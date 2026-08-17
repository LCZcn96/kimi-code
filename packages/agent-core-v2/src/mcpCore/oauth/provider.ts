/**
 * `mcpCore` domain — `McpOAuthClientProvider`, the `OAuthClientProvider`
 * backed by the MCP OAuth credential store (`McpOAuthStore` over
 * `IAtomicDocumentStore`).
 *
 * One provider instance per server/resource identity. It persists OAuth
 * tokens, the registered DCR client info, and discovery state under
 * `<homeDir>/credentials/mcp/<key>-*.json` via the store; captures the
 * authorization URL when the SDK calls `redirectToAuthorization`; and keeps
 * the PKCE verifier and OAuth `state` in-memory. Client info and discovery
 * state are mirrored into in-memory caches loaded eagerly on construction
 * (`ready`) so the SDK's synchronous `redirectUrl` / `clientMetadata` getters
 * read without blocking; tokens are read through the store on every call so
 * a grant written (or revoked) by another process is honored immediately
 * instead of going stale behind a construction-time snapshot. The provider
 * does not open browsers or run servers — it is the persistence + flow-state
 * shim.
 *
 * Every durable token write is serialized through an `OAuthTokenTransaction`
 * keyed by this credential, so a late SDK callback cannot overwrite or delete
 * a newer grant committed by a concurrent refresh. The transaction's write
 * callback is the single choke point that stamps `obtained_at`
 * ({@link StoredMcpOAuthTokens}) onto the durable record — explicit saves and
 * refresh grants committed by the fetch interceptor alike — so token-state
 * readers can compute the absolute expiry (`expires_in` alone is relative);
 * the MCP SDK only reads the standard fields, so the extra key is inert. A
 * `<key>-meta.json` sidecar mapping the store key back to its server is
 * written alongside every token save for the service's startup sweep.
 *
 * `onTokensSaved` / `onCredentialsInvalidated` report durable outcomes so the
 * owning service can broadcast credential events — including SDK-driven
 * invalidations, which flip sharing sessions to needs-auth now instead of
 * leaving them on doomed connections until each hits its own 401.
 *
 * `invalidateStaleRegistration` guards interactive flows: the callback
 * listener binds a random port per flow while a DCR registration pins the
 * redirect URIs of the flow that created it, so a reused registration whose
 * URIs no longer cover the current callback would be rejected at the
 * authorization endpoint ("invalid redirect URI", rendered only in the
 * user's browser). Dropping it lets `auth()` re-register.
 *
 * `clientName` is the product token for the default label
 * (`<clientName> (<serverName>)`), carrying the configured custom identity; it
 * is ignored when `clientLabel` states the whole label explicitly.
 */

import { randomBytes } from 'node:crypto';

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthTokensSchema,
  type OAuthClientInformationFull,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthTokenTransaction } from '@moonshot-ai/kimi-code-oauth';

import { BugIndicatingError } from '#/errors';

import { KIMI_MCP_CLIENT_NAME } from '../client-shared';
import { canonicalMcpOAuthResource, mcpOAuthStoreKey, type McpOAuthStore } from './store';

const TOKENS_SUFFIX = '-tokens.json';
const CLIENT_SUFFIX = '-client.json';
const DISCOVERY_SUFFIX = '-discovery.json';
/** Sidecar `<key>-meta.json` suffix; the service scans these on startup. */
export const META_SUFFIX = '-meta.json';
// Used only when the SDK probes auth during normal transport startup and no
// callback listener is active. Interactive login overrides it with a real URL.
const PASSIVE_REDIRECT_URI = 'http://127.0.0.1:3118/callback';

export interface StoredMcpOAuthTokens extends OAuthTokens {
  readonly obtained_at?: number;
}

/** Sidecar `<key>-meta.json` record mapping a store key back to its server. */
export interface McpOAuthStoreMeta {
  readonly serverName: string;
  readonly serverUrl: string;
}

export interface McpOAuthProviderOptions {
  readonly serverName: string;
  readonly serverUrl: string | URL;
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
  readonly clientName?: string;
  /** Called after tokens are persisted (login, exchange, or refresh). */
  readonly onTokensSaved?: (tokens: StoredMcpOAuthTokens) => void;
  /** Called after any credential invalidation, including SDK-driven ones. */
  readonly onCredentialsInvalidated?: (
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) => void;
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  readonly storeKey: string;
  readonly serverUrl: string;
  readonly ready: Promise<void>;
  private readonly serverName: string;
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string;
  private readonly onTokensSaved: McpOAuthProviderOptions['onTokensSaved'];
  private readonly onCredentialsInvalidated: McpOAuthProviderOptions['onCredentialsInvalidated'];
  private _redirectUrl: URL | undefined;
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _lastAuthorizationUrl: URL | undefined;
  private readonly tokenTransaction: OAuthTokenTransaction<OAuthTokens>;

  private clientCache: OAuthClientInformationMixed | undefined;
  private discoveryCache: OAuthDiscoveryState | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = canonicalMcpOAuthResource(options.serverUrl);
    this.storeKey = mcpOAuthStoreKey(options.serverName, this.serverUrl);
    this.serverName = options.serverName;
    this.store = options.store;
    this.clientLabel =
      options.clientLabel ??
      `${options.clientName ?? KIMI_MCP_CLIENT_NAME} (${options.serverName})`;
    this.onTokensSaved = options.onTokensSaved;
    this.onCredentialsInvalidated = options.onCredentialsInvalidated;
    const tokensFile = `${this.storeKey}${TOKENS_SUFFIX}`;
    this.tokenTransaction = new OAuthTokenTransaction({
      key: this.storeKey,
      read: async () => this.store.read<OAuthTokens>(tokensFile),
      write: async (tokens) => {
        // Single choke point for every durable token write (explicit saves and
        // refresh grants committed by the fetch interceptor alike): keep the
        // incoming stamp when present, stamp otherwise.
        const incoming = tokens as StoredMcpOAuthTokens;
        await this.store.write(tokensFile, {
          ...incoming,
          obtained_at: incoming.obtained_at ?? Date.now(),
        });
      },
      remove: async () => {
        await this.store.remove(tokensFile);
      },
      parse: (value) => OAuthTokensSchema.safeParse(value).data,
    });
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const [client, discovery] = await Promise.all([
      this.store.read<OAuthClientInformationFull>(`${this.storeKey}${CLIENT_SUFFIX}`),
      this.store.read<OAuthDiscoveryState>(`${this.storeKey}${DISCOVERY_SUFFIX}`),
    ]);
    this.clientCache = client;
    this.discoveryCache = discovery;
  }

  setRedirectUrl(url: URL): void {
    this._redirectUrl = url;
  }

  takeAuthorizationUrl(): URL | undefined {
    const url = this._lastAuthorizationUrl;
    this._lastAuthorizationUrl = undefined;
    return url;
  }

  expectedState(): string | undefined {
    return this._state;
  }

  resetFlow(): void {
    this._redirectUrl = undefined;
    this._codeVerifier = undefined;
    this._state = undefined;
    this._lastAuthorizationUrl = undefined;
  }

  get redirectUrl(): string | URL {
    return this.effectiveRedirectUri();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.effectiveRedirectUri()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.clientLabel,
    };
  }

  state(): string {
    this._state ??= randomBytes(16).toString('hex');
    return this._state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    await this.ready;
    return this.clientCache;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    // Persist first, then mirror into the cache: a failed write must not
    // leave the cache claiming a registration the disk does not have.
    await this.store.write(`${this.storeKey}${CLIENT_SUFFIX}`, info);
    this.clientCache = info;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.store.read<OAuthTokens>(`${this.storeKey}${TOKENS_SUFFIX}`);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Hand the SDK's token object to the transaction untouched: when the
    // grant rode createOAuthFetch, the transaction already persisted and
    // recorded exactly this payload, so a matching save consumes the
    // recorded effect instead of writing again — re-writing here could
    // resurrect credentials cleared between the fetch and this callback.
    // The durable `obtained_at` stamp is applied by the write callback.
    await this.tokenTransaction.save(tokens);
    const meta: McpOAuthStoreMeta = { serverName: this.serverName, serverUrl: this.serverUrl };
    await this.store.write(`${this.storeKey}${META_SUFFIX}`, meta);
    const stamped: StoredMcpOAuthTokens = {
      ...tokens,
      obtained_at: (tokens as StoredMcpOAuthTokens).obtained_at ?? Date.now(),
    };
    this.onTokensSaved?.(stamped);
  }

  /**
   * Wrap the fetch used by the SDK's OAuth flow. Refresh-token grants for the
   * same MCP identity are serialized, re-read from durable storage inside the
   * lock, and committed before the lock is released.
   */
  createOAuthFetch(fetchFn: typeof fetch = globalThis.fetch): typeof fetch {
    return this.tokenTransaction.createFetch(fetchFn);
  }

  redirectToAuthorization(url: URL): void {
    this._lastAuthorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this._codeVerifier === undefined) {
      throw new BugIndicatingError('McpOAuthClientProvider: PKCE code verifier not initialized');
    }
    return this._codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.store.write(`${this.storeKey}${DISCOVERY_SUFFIX}`, state);
    this.discoveryCache = state;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.ready;
    return this.discoveryCache;
  }

  async invalidateStaleRegistration(redirectUri: string): Promise<boolean> {
    await this.ready;
    const info = this.clientCache;
    if (info === undefined || !('redirect_uris' in info)) return false;
    const uris = info.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return false;
    if (uris.includes(redirectUri)) return false;
    await this.clearCredentials('client');
    return true;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope !== 'tokens' && scope !== 'all') {
      await this.clearCredentials(scope);
      return;
    }
    const tokensInvalidated = await this.tokenTransaction.invalidateFromSdk(scope);
    if (!tokensInvalidated) return;
    if (scope === 'all') {
      await this.clearCredentials('client');
      await this.clearCredentials('discovery');
      this._codeVerifier = undefined;
    }
    // The SDK-driven invalidation actually dropped the durable grant, so
    // broadcast it like a user-driven reset: sessions sharing this credential
    // flip to needs-auth now instead of keeping doomed connections until
    // they each hit their own 401.
    this.onCredentialsInvalidated?.(scope);
  }

  /** Explicit user-driven reset; unlike the SDK invalidation hook, never preserves tokens. */
  async clearCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'verifier') {
      this._codeVerifier = undefined;
      this.onCredentialsInvalidated?.(scope);
      return;
    }
    if (scope === 'tokens' || scope === 'all') {
      await this.tokenTransaction.clear();
      await this.store.remove(`${this.storeKey}${META_SUFFIX}`);
    }
    if (scope === 'client' || scope === 'all') {
      await this.store.remove(`${this.storeKey}${CLIENT_SUFFIX}`);
      this.clientCache = undefined;
    }
    if (scope === 'discovery' || scope === 'all') {
      await this.store.remove(`${this.storeKey}${DISCOVERY_SUFFIX}`);
      this.discoveryCache = undefined;
    }
    if (scope === 'all') {
      this._codeVerifier = undefined;
    }
    this.onCredentialsInvalidated?.(scope);
  }

  private effectiveRedirectUri(): string {
    if (this._redirectUrl !== undefined) {
      return this._redirectUrl.toString();
    }
    const registered = registeredRedirectUri(this.clientCache);
    return registered ?? PASSIVE_REDIRECT_URI;
  }
}

function registeredRedirectUri(info: OAuthClientInformationMixed | undefined): string | undefined {
  if (info === undefined || !('redirect_uris' in info)) return undefined;
  const [redirectUri] = info.redirect_uris;
  return redirectUri;
}

/**
 * Route a transport's fetch through the provider's token transaction when one
 * is attached, so refresh grants racing on the same credential serialize.
 */
export function createMcpOAuthFetch(
  provider: OAuthClientProvider | undefined,
  fetchFn: typeof fetch | undefined,
): typeof fetch | undefined {
  return provider instanceof McpOAuthClientProvider ? provider.createOAuthFetch(fetchFn) : fetchFn;
}
