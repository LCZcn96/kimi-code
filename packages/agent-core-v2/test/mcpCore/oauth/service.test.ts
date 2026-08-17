/**
 * Scenario: the shared McpOAuthService stamps token writes with `obtained_at`,
 * exposes the offline token state, emits credential events, runs token
 * refreshes single-flight per credential, serializes interactive flows per
 * credential, and schedules/shuts down proactive refreshes — over the async
 * `McpOAuthStore` port (memory stub). Ported from v1's
 * `test/mcp/oauth-service.test.ts`. Run with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/mcpCore/oauth/service.test.ts`.
 *
 * Note: the scheduling/shutdown describes drive the refresh timers with
 * `vi.useFakeTimers()` — a deliberate exception to the no-fake-timers rule:
 * the behavior under test IS the timer semantics (a `MAX_TIMER_DELAY_MS`
 * re-arm would take ~25 days of wall clock), and the service exposes no
 * clock seam. The v1 blueprint suite drives them the same way.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  META_SUFFIX,
  type McpOAuthClientProvider,
  type McpOAuthStoreMeta,
} from '#/mcpCore/oauth/provider';
import {
  AlreadyAuthorizedError,
  McpOAuthService,
  type BeginAuthorizationResult,
  type McpOAuthEvent,
} from '#/mcpCore/oauth/service';
import { mcpOAuthStoreKey, type McpOAuthStore } from '#/mcpCore/oauth/store';

import { createMemoryMcpOAuthStore } from '../stubs';

const SERVER_NAME = 'notion';
const SERVER_URL = 'https://mcp.example.test/mcp';

interface Fixture {
  readonly service: McpOAuthService;
  readonly store: McpOAuthStore;
  readonly events: McpOAuthEvent[];
}

function makeFixture(store: McpOAuthStore = createMemoryMcpOAuthStore()): Fixture {
  const events: McpOAuthEvent[] = [];
  const service = new McpOAuthService({ store });
  service.onEvent((event) => events.push(event));
  return { service, store, events };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/** The memory store's `list(prefix)` is prefix-matching, so meta sidecars are filtered by suffix. */
async function listMetaKeys(store: McpOAuthStore): Promise<readonly string[]> {
  return (await store.list()).filter((key) => key.endsWith(META_SUFFIX));
}

/**
 * The provider mirrors client/discovery state into in-memory caches on
 * construction (`ready`); seeding before that load settles is clobbered by
 * it, so every seed goes through a provider whose `ready` has resolved.
 */
async function readyProvider(fixture: Fixture): Promise<McpOAuthClientProvider> {
  const provider = fixture.service.getProvider(SERVER_NAME, SERVER_URL);
  await provider.ready;
  return provider;
}

interface FakeAuthServer {
  readonly url: string;
  readonly counts: { register: number; exchange: number; refresh: number };
}

/**
 * Minimal OAuth authorization server: DCR at `/register` (echoes the client
 * metadata back with a client_id) and a token endpoint that answers both
 * `authorization_code` and `refresh_token` grants with a fresh access token.
 * Discovery and the authorization redirect never touch the network — tests
 * seed discovery state and drive the localhost callback listener directly.
 */
async function startFakeAuthServer(
  options: { readonly rejectRefreshToken?: boolean } = {},
): Promise<FakeAuthServer> {
  const counts = { register: 0, exchange: 0, refresh: 0 };
  const httpServer: HttpServer = createHttpServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/token' && req.url !== '/register')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (req.url === '/register') {
        counts.register += 1;
        const metadata = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...metadata, client_id: `test-client-${counts.register}` }));
        return;
      }
      const grantType = new URLSearchParams(body).get('grant_type');
      if (grantType === 'authorization_code') counts.exchange += 1;
      if (grantType === 'refresh_token') {
        counts.refresh += 1;
        if (options.rejectRefreshToken === true) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }),
      );
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  );
  const port = (httpServer.address() as HttpAddress).port;
  return { url: `http://127.0.0.1:${port}`, counts };
}

/** Discovery state + registered client metadata matching a fake auth server. */
function authServerState(authServerUrl: string) {
  return {
    discovery: {
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        registration_endpoint: `${authServerUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    },
    client: {
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull,
  };
}

/**
 * Play the browser: hit the flow's localhost callback listener with a code
 * and the `state` carried by the authorization URL.
 */
async function deliverCallback(flow: BeginAuthorizationResult): Promise<void> {
  const redirectUri = flow.authorizationUrl.searchParams.get('redirect_uri');
  const state = flow.authorizationUrl.searchParams.get('state');
  expect(redirectUri).toBeTruthy();
  const callbackUrl = new URL(redirectUri!);
  callbackUrl.searchParams.set('code', 'test-auth-code');
  if (state !== null) callbackUrl.searchParams.set('state', state);
  const response = await fetch(callbackUrl);
  expect(response.status).toBe(200);
  await response.text();
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('McpOAuthService credential bookkeeping', () => {
  it('stamps token writes with obtained_at and a name/url meta record', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    const before = Date.now();
    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });

    const state = await fixture.service.tokenState(SERVER_NAME, SERVER_URL);
    expect(state.hasTokens).toBe(true);
    expect(state.expired).toBe(false);
    expect(state.expiresAt).toBeDefined();
    expect(state.expiresAt!).toBeGreaterThanOrEqual(before + 3600_000);
    expect(state.expiresAt!).toBeLessThanOrEqual(Date.now() + 3600_000);

    const metaFiles = await listMetaKeys(fixture.store);
    expect(metaFiles).toHaveLength(1);
    expect(await fixture.store.read<McpOAuthStoreMeta>(metaFiles[0]!)).toEqual({
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
    });

    expect(fixture.events).toEqual([
      { type: 'tokens-saved', serverName: SERVER_NAME, serverUrl: SERVER_URL },
    ]);
  });

  it('treats tokens without expiry data as non-expiring', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toEqual({
      hasTokens: false,
      hasRefreshToken: false,
      expired: false,
    });

    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      expired: false,
      expiresAt: undefined,
    });
  });

  it('treats a grant saved with a negative expires_in as expired', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      expires_in: -60,
    });
    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      hasRefreshToken: false,
      expired: true,
    });
  });

  it('emits tokens-invalidated and drops the meta record when credentials are cleared', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(await listMetaKeys(fixture.store)).toHaveLength(1);

    await fixture.service.invalidate(SERVER_NAME, SERVER_URL, 'tokens');
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(false);
    expect(await listMetaKeys(fixture.store)).toHaveLength(0);
    expect(fixture.events).toContainEqual({
      type: 'tokens-invalidated',
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
      scope: 'tokens',
    });
  });
});

describe('McpOAuthService single-flight refresh', () => {
  it('shares one in-flight refresh across concurrent callers', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    let tokenRequests = 0;
    const httpServer: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token' && req.method === 'POST') {
        tokenRequests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
    );
    const port = (httpServer.address() as HttpAddress).port;
    const authServerUrl = `http://127.0.0.1:${port}`;

    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState({
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    await Promise.all([
      fixture.service.refresh(SERVER_NAME, SERVER_URL),
      fixture.service.refresh(SERVER_NAME, SERVER_URL),
    ]);
    expect(tokenRequests).toBe(1);
    expect(await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).toMatchObject({
      hasTokens: true,
      expired: false,
    });
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(2);
  }, 15000);

  it('rejects when no refresh token is stored', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await expect(fixture.service.refresh(SERVER_NAME, SERVER_URL)).rejects.toThrow(
      /no refreshable OAuth grant/,
    );
  });

  it('routes the token request through the credential-serialized fetch', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    // The refresh's /token request must go through OAuthTokenTransaction so
    // it serializes against concurrent 401-driven refreshes from transports.
    const fetchSpy = vi.spyOn(provider, 'createOAuthFetch');
    await fixture.service.refresh(SERVER_NAME, SERVER_URL);
    expect(fetchSpy).toHaveBeenCalled();
    expect(authServer.counts.refresh).toBe(1);
  }, 15000);

  it('emits tokens-invalidated when the SDK invalidates a rejected refresh grant', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer({ rejectRefreshToken: true });
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveClientInformation(authServerState(authServer.url).client);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    // The dead refresh token is rejected with invalid_grant, so the SDK
    // invalidates the 'tokens' scope and the durable grant is dropped. That
    // must broadcast the invalidation like a user-driven reset, or sessions
    // sharing the credential keep their doomed connections until their own
    // 401s.
    await expect(fixture.service.refresh(SERVER_NAME, SERVER_URL)).rejects.toThrow(
      /requires an interactive login/,
    );
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(false);
    expect(fixture.events).toContainEqual({
      type: 'tokens-invalidated',
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
      scope: 'tokens',
    });
  }, 15000);

  it('does not resurrect tokens cleared between a grant fetch and the SDK save', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    // The token endpoint returns a rotating refresh grant.
    const grant = {
      access_token: 'rotated-access',
      refresh_token: 'rotated-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    const httpServer: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(grant));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
    );
    const authServerUrl = `http://127.0.0.1:${(httpServer.address() as HttpAddress).port}`;

    const provider = await readyProvider(fixture);
    const state = authServerState(authServerUrl);
    await provider.saveDiscoveryState(state.discovery);
    await provider.saveClientInformation(state.client);
    await provider.saveTokens({
      access_token: 'seed-access',
      refresh_token: 'seed-refresh',
      token_type: 'Bearer',
    });

    // The SDK's grant request rides the transaction fetch, which persists and
    // records the exact payload…
    const res = await provider.createOAuthFetch()(`${authServerUrl}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'seed-refresh' }),
    });
    const granted = (await res.json()) as Parameters<typeof provider.saveTokens>[0];

    // …but before the SDK's saveTokens lands, the credential is reset.
    await provider.clearCredentials('all');
    expect(await provider.tokens()).toBeUndefined();

    // The matching save is consumed as already-recorded instead of writing
    // the cleared grant back to disk.
    await provider.saveTokens(granted);
    expect(await provider.tokens()).toBeUndefined();
  }, 15000);
});

describe('McpOAuthService interactive flow serialization', () => {
  it('joins a concurrent flow for the same credential instead of resetting PKCE state', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    // A clientLabel variant maps to the same store key, so it joins too.
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL, {
      clientLabel: 'other-client',
    });
    expect(second.authorizationUrl.toString()).toBe(first.authorizationUrl.toString());

    const firstComplete = first.complete({ timeoutMs: 10_000 });
    await deliverCallback(first);
    await firstComplete;
    // The joiner shares the settled outcome; the exchange ran exactly once.
    await second.complete();
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('skips a refresh that fires while an interactive flow owns the credential', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer({ rejectRefreshToken: true });
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    // A dead-but-present grant keeps the credential refreshable, so a
    // proactive/manual refresh would normally proceed — and would hit the
    // same shared provider the interactive flow lives on.
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const complete = flow.complete({ timeoutMs: 10_000 });
    // Refresh must skip while the flow is active instead of resetting the
    // shared provider's PKCE/state out from under the browser callback.
    await expect(fixture.service.refresh(SERVER_NAME, SERVER_URL)).resolves.toBeUndefined();
    await deliverCallback(flow);
    await complete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('skips a refresh whose token read straddles the start of an interactive flow', async () => {
    // Gate one read of the tokens file so the refresh's `tokenState()` await
    // stays open while an interactive flow begins — the exact window the
    // second `activeAuthorizations` check in refreshNow exists for.
    const memory = createMemoryMcpOAuthStore();
    let releaseTokensRead: () => void = () => undefined;
    const tokensReadGate = new Promise<void>((resolve) => {
      releaseTokensRead = resolve;
    });
    let signalReadHeld: () => void = () => undefined;
    const tokensReadHeld = new Promise<void>((resolve) => {
      signalReadHeld = resolve;
    });
    let gateArmed = false;
    const store: McpOAuthStore = {
      ...memory,
      async read<T>(key: string): Promise<T | undefined> {
        if (gateArmed && key.endsWith('-tokens.json')) {
          gateArmed = false; // hold exactly one read
          signalReadHeld();
          await tokensReadGate;
        }
        return memory.read<T>(key);
      },
    };
    const fixture = makeFixture(store);
    cleanups.push(() => fixture.service.dispose());
    // Runs before dispose (LIFO): unblocks a parked refresh on a failure path.
    cleanups.push(() => releaseTokensRead());
    const authServer = await startFakeAuthServer({ rejectRefreshToken: true });
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveClientInformation(authServerState(authServer.url).client);
    // A dead-but-present grant keeps the credential refreshable, so the
    // refresh below would normally proceed to the token endpoint.
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    // The refresh passes the first activeAuthorizations check and parks
    // inside the token-state read.
    gateArmed = true;
    const refresh = fixture.service.refresh(SERVER_NAME, SERVER_URL);
    await tokensReadHeld;

    // An interactive flow begins in that window and takes over the shared
    // provider's flow state. (Its own dead-grant refresh attempt is the one
    // /token hit counted here.)
    const flow = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const complete = flow.complete({ timeoutMs: 10_000 });
    expect(authServer.counts.refresh).toBe(1);

    // Releasing the read must not let the refresh race the flow: the re-check
    // sees the active authorization, so no resetFlow and no second /token
    // request — the refresh settles quietly.
    releaseTokensRead();
    await expect(refresh).resolves.toBeUndefined();
    expect(authServer.counts.refresh).toBe(1);

    // The interactive flow is intact: the callback completes the exchange.
    await deliverCallback(flow);
    await complete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('lets only the initiating handle cancel the shared flow', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);

    // A joiner's cancel only detaches itself; the underlying flow survives.
    await second.cancel();
    await expect(second.complete()).rejects.toThrow(/already completed or cancelled/);

    const firstComplete = first.complete({ timeoutMs: 10_000 });
    await deliverCallback(first);
    await firstComplete;
    expect(authServer.counts.exchange).toBe(1);
  }, 15000);

  it('rejects joiners when the initiator cancels, then allows a fresh flow', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const first = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    const second = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    await first.cancel();
    await expect(second.complete()).rejects.toThrow(/already completed or cancelled/);

    // The credential is free again: a new begin starts a fresh flow with a
    // new callback listener (hence a new redirect URI) and completes cleanly.
    const third = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);
    expect(third.authorizationUrl.toString()).not.toBe(first.authorizationUrl.toString());
    const thirdComplete = third.complete({ timeoutMs: 10_000 });
    await deliverCallback(third);
    await thirdComplete;
    expect(authServer.counts.exchange).toBe(1);
    expect((await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).hasTokens).toBe(true);
  }, 15000);

  it('leaves no shared flow behind when begin reports already-authorized', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    });

    // The stored grant refreshes fine, so begin falls into the
    // AlreadyAuthorizedError path instead of surfacing a URL.
    await expect(
      fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL),
    ).rejects.toBeInstanceOf(AlreadyAuthorizedError);
    // A stale map entry would make the retry join a dead flow instead of
    // failing the same way.
    await expect(
      fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL),
    ).rejects.toBeInstanceOf(AlreadyAuthorizedError);
    expect(authServer.counts.refresh).toBe(2);
  }, 15000);
});

describe('McpOAuthService sweepProactiveRefresh resilience', () => {
  it('skips malformed meta sidecars and still schedules the valid credential', async () => {
    // The memory store cannot hold unparseable JSON, so v1's corrupt file is
    // simulated by a key that `list()` surfaces but `read()` yields undefined
    // for (the same observation v1's JsonFileStore produced for corrupt JSON).
    const memory = createMemoryMcpOAuthStore();
    const store: McpOAuthStore = {
      ...memory,
      async read<T>(key: string): Promise<T | undefined> {
        if (key === 'corrupt-meta.json') return undefined;
        return memory.read<T>(key);
      },
    };
    const fixture = makeFixture(store);
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();

    // A valid credential written straight to the store (simulating a previous
    // process), expiring inside the proactive window so the sweep schedules
    // an immediate refresh.
    const state = authServerState(authServer.url);
    const storeKey = mcpOAuthStoreKey(SERVER_NAME, SERVER_URL);
    await fixture.store.write(`${storeKey}-discovery.json`, state.discovery);
    await fixture.store.write(`${storeKey}-client.json`, state.client);
    await fixture.store.write(`${storeKey}-tokens.json`, {
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 60,
      obtained_at: Date.now(),
    });
    await fixture.store.write(`${storeKey}-meta.json`, {
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
    } satisfies McpOAuthStoreMeta);

    // Sidecars that parse as JSON but have the wrong shape, plus one whose
    // read yields undefined (the corrupt-JSON case).
    await fixture.store.write('broken-empty-meta.json', {});
    await fixture.store.write('broken-types-meta.json', { serverName: 1, serverUrl: 42 });
    await fixture.store.write('broken-url-meta.json', { serverName: 'x', serverUrl: 'not a url' });
    await fixture.store.write('corrupt-meta.json', '{not json');

    await expect(fixture.service.sweepProactiveRefresh()).resolves.toBeUndefined();
    await waitFor(
      () => authServer.counts.refresh === 1,
      'the swept credential to refresh immediately',
    );
  }, 15000);
});

describe('McpOAuthService proactive refresh scheduling', () => {
  it('refreshes immediately when a stored grant is already inside the refresh window', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();

    const provider = await readyProvider(fixture);
    const state = authServerState(authServer.url);
    await provider.saveDiscoveryState(state.discovery);
    await provider.saveClientInformation(state.client);
    // expires_in 60s < REFRESH_AHEAD_MS (120s): still valid, but already
    // inside the proactive window, so the save hook must refresh immediately.
    await provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
      expires_in: 60,
    });

    await waitFor(() => authServer.counts.refresh === 1, 'an immediate proactive refresh');
    expect(fixture.events.filter((event) => event.type === 'tokens-saved')).toHaveLength(2);
  }, 15000);

  it('re-arms scheduling for expiries beyond the setTimeout limit', async () => {
    const fixture = makeFixture();
    cleanups.push(() => {
      vi.useRealTimers();
    });
    cleanups.push(() => fixture.service.dispose());
    vi.useFakeTimers();
    const maxTimerDelayMs = 0x7fffffff; // mirrors MAX_TIMER_DELAY_MS in the service
    const refreshSpy = vi
      .spyOn(fixture.service, 'refresh')
      .mockRejectedValue(new Error('refresh unavailable in test'));

    // ~25 days of validity: expiresAt - REFRESH_AHEAD_MS exceeds 2^31-1 ms.
    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: Math.ceil(maxTimerDelayMs / 1000) + 600,
    });
    const expiresAt = (await fixture.service.tokenState(SERVER_NAME, SERVER_URL)).expiresAt!;

    // The far-future grant is armed at the maximum timer delay; firing that
    // timer re-computes the schedule instead of dropping the grant.
    await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
    expect(refreshSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(expiresAt - Date.now() - 120_000);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(fixture.events).toContainEqual({
      type: 'refresh-failed',
      serverName: SERVER_NAME,
      serverUrl: SERVER_URL,
      error: 'refresh unavailable in test',
    });
  });

  it('does not proactively refresh an already-expired grant', async () => {
    const fixture = makeFixture();
    cleanups.push(() => {
      vi.useRealTimers();
    });
    cleanups.push(() => fixture.service.dispose());
    vi.useFakeTimers();
    const refreshSpy = vi.spyOn(fixture.service, 'refresh');

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: -60,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('McpOAuthService shutdown', () => {
  it('cancels active flows on shutdown', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const authServer = await startFakeAuthServer();
    const provider = await readyProvider(fixture);
    await provider.saveDiscoveryState(authServerState(authServer.url).discovery);

    const flow = await fixture.service.beginAuthorization(SERVER_NAME, SERVER_URL);

    await fixture.service.shutdown();

    // The flow's callback listener is gone; completing is no longer possible.
    await expect(flow.complete()).rejects.toThrow(/already completed or cancelled/);
  }, 15000);

  it('clears event listeners and cached providers on shutdown', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());
    const providerBefore = fixture.service.getProvider(SERVER_NAME, SERVER_URL);

    await fixture.service.shutdown();

    // Listeners are cleared: later credential events go nowhere.
    const eventCount = fixture.events.length;
    await fixture.service
      .getProvider(SERVER_NAME, SERVER_URL)
      .saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });
    expect(fixture.events).toHaveLength(eventCount);

    // Cached providers were dropped.
    expect(fixture.service.getProvider(SERVER_NAME, SERVER_URL)).not.toBe(providerBefore);
  });

  it('is idempotent across repeated shutdown calls', async () => {
    const fixture = makeFixture();
    cleanups.push(() => fixture.service.dispose());

    await fixture.service.shutdown();
    await expect(fixture.service.shutdown()).resolves.toBeUndefined();
  });

  it('clears pending proactive-refresh timers', async () => {
    const fixture = makeFixture();
    cleanups.push(() => {
      vi.useRealTimers();
    });
    cleanups.push(() => fixture.service.dispose());
    vi.useFakeTimers();

    await fixture.service.getProvider(SERVER_NAME, SERVER_URL).saveTokens({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const refreshSpy = vi.spyOn(fixture.service, 'refresh');

    await fixture.service.shutdown();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
