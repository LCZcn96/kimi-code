/**
 * `workspaceMcp` domain — `IWorkspaceMcpService` implementation.
 *
 * Owns the handler-wide `McpConnectionManager` (built at construction,
 * shared by every session of the workspace). This service drives the
 * initial connect from the config domain's snapshot, applies its reconciled
 * change events incrementally (serialized on a mutation tail, always after
 * the initial connect settles — removals tombstone the server via
 * `markRemoved` so live sessions keep the tool registrations but fail calls
 * with a removal notice, while new sessions never see them), feeds the
 * manager's global timeout defaults
 * from the config domain's tunables at each (re)connect, and reports
 * connection telemetry for the initial load. Every session handle it hands
 * out (`sessionHandle` / `sessionOverlay`) captures a server baseline — the
 * names present when the session materializes, open to additions until the
 * initial connect settles, then closed — so servers that appear mid-session
 * (a plugin install or a config edit, which always land after the initial
 * connect via the mutation tail) never reach the live sessions' tool
 * registries; the next session materialization (`/new`, `/reload`, resume)
 * captures a fresh baseline. It also builds per-session
 * overlays (`sessionOverlay`): a session-owned manager for a session's
 * ephemeral (caller-injected, never persisted) servers — baseline members
 * by construction — presented through a
 * `MergedMcpConnectionView` over the shared manager. Overlay activation is
 * event-driven: this service subscribes to the session lifecycle's
 * `onWillCreateSession`, and a session created with an
 * `ISessionEphemeralMcpServers` seed gets its overlay created there — the
 * merged handle contributed as the session's `ISessionMcpHandle` (replacing
 * the seed adapter's workspace projection), the overlay's shutdown attached
 * to the session's teardown, so the session lifecycle never depends on MCP.
 * The overlay's stdio cwd is read from the session's own `ISessionContext`.
 * An overlay handle's
 * baseline still freezes on the workspace manager's initial load — never on
 * the overlay's own connect — so a slow ephemeral connect cannot reopen the
 * window for mid-session workspace additions.
 * An outright initial-load or change-apply failure is logged (per-server
 * failures are status entries). The manager (and its stdio child processes,
 * whose cwd is the handler root) lives as long as the handler — i.e. the
 * process — so a stateful stdio server is shared by concurrent sessions of
 * the workspace rather than owned by one session. Bound at Workspace scope.
 *
 * The OAuth orchestrator is the App-scope `IMcpOAuthService` shared by every
 * handler and overlay: this service subscribes its credential events and
 * reconciles the affected manager entries — a completed login reconnects a
 * `needs-auth` / `failed` entry, a reset or a failed proactive refresh flips
 * a live connection back to `needs-auth` (the reconnect hits a 401) instead
 * of leaving it doomed-but-connected, and an entry still performing its
 * initial connect defers the reconnect until it settles, so a credential
 * written mid-initialization is not lost. Each session overlay subscribes
 * the same events against its own manager for the overlay's lifetime.
 *
 * The client name announced to MCP servers — on initialize and on OAuth
 * dynamic registration — is the identity snapshot's slug. Every manager it
 * builds, the shared one and each session overlay, gates its connects on
 * `identity.resolved()`, so the callback handed to the managers always reads
 * the frozen snapshot: a connection (and the OAuth provider a remote server
 * materializes, cached on the shared service) can never carry a pre-config
 * name.
 */

import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpConnectionManager, type McpConnectionView } from '#/mcpCore/connection-manager';
import type { McpOAuthEvent, McpOAuthService } from '#/mcpCore/oauth/service';
import { canonicalMcpOAuthResource } from '#/mcpCore/oauth/store';
import { ISessionEphemeralMcpServers } from '#/session/mcp/ephemeralMcpServers';
import { MergedMcpConnectionView } from '#/session/mcp/mergedConnectionView';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';

import {
  IWorkspaceMcpService,
  type ISessionMcpOverlay,
  type SessionMcpOverlayOptions,
} from './workspaceMcp';

export class WorkspaceMcpService extends Disposable implements IWorkspaceMcpService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: McpConnectionManager;
  private readonly oauthService: McpOAuthService;
  private readonly stdioCwd: string;
  private readonly workspaceId: string;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly resolveClientName = (): string | undefined => this.identity.current().slug;
  private readonly sessionLifecycle: LiveRef<ISessionManager>;
  private sessionLifecycleAttached = false;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @IWorkspaceMcpConfigService private readonly mcpConfig: IWorkspaceMcpConfigService,
    @IMcpOAuthService oauthService: McpOAuthService,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @ref(ISessionManager) sessionLifecycle: LiveRef<ISessionManager>,
  ) {
    super();
    this.sessionLifecycle = sessionLifecycle;
    this.stdioCwd = workspace.cwd;
    this.workspaceId = workspace.workspaceId;
    this.oauthService = oauthService;
    this.manager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: this.stdioCwd,
      runtimeResolver: this.runtimeResolver,
      workspaceId: workspace.workspaceId,
      runtimeId: 'local',
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    this._register({ dispose: () => void this.manager.shutdown() });
    this._register(
      this.mcpConfig.onDidChange((change) => {
        this.scheduleApply(change);
      }),
    );
    this._register({ dispose: this.oauthEventSubscription(this.manager) });
    this.attachSessionLifecycle();
    this._register(sessionLifecycle.onDidChange(() => this.attachSessionLifecycle()));
    this.ready = this.initialize().catch((error: unknown) => {
      this.log.error('mcp initial load failed', { error });
    });
  }

  private attachSessionLifecycle(): void {
    if (this.sessionLifecycleAttached) return;
    const lifecycle = this.sessionLifecycle.current;
    if (lifecycle?.onWillCreateSession === undefined) return;
    this.sessionLifecycleAttached = true;
    this._register(
      lifecycle.onWillCreateSession((event) => {
        if (event.readSeed(ISessionContext).workspaceId !== this.workspaceId) return;
        const servers = event.readSeed(ISessionEphemeralMcpServers);
        if (Object.keys(servers).length === 0) return;
        const overlay = this.sessionOverlay(servers, {
          stdioCwd: event.readSeed(ISessionContext).cwd,
        });
        event.contributeSeed(ISessionMcpHandle, overlay.handle);
        event.onSessionDispose(() => {
          void overlay.shutdown();
        });
      }),
    );
  }

  connectionManager(): McpConnectionManager {
    return this.manager;
  }

  sessionHandle(): ISessionMcpHandle {
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      connectionManager: this.manager,
      isBaselineServer: this.sessionBaseline(this.manager, this.ready),
    };
  }

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
  ): ISessionMcpOverlay {
    const sessionManager = new McpConnectionManager({
      log: this.log,
      oauthService: this.oauthService,
      stdioCwd: opts?.stdioCwd ?? this.stdioCwd,
      runtimeResolver: this.runtimeResolver,
      workspaceId: this.workspaceId,
      runtimeId: 'local',
      requireStdioRuntimeId: true,
      resolveDefaultTimeouts: () => this.mcpConfig.tunables(),
      resolveClientName: this.resolveClientName,
    });
    const connect = Promise.all([this.mcpConfig.ready, this.identity.resolved()])
      .then(() => sessionManager.connectAll({ ...servers }))
      .catch((error: unknown) => {
        this.log.error('session mcp overlay initial load failed', { error });
      });
    const unsubscribeOAuth = this.oauthEventSubscription(sessionManager);
    const view = new MergedMcpConnectionView(
      this.manager,
      sessionManager,
      new Set(Object.keys(servers)),
    );
    const ready = Promise.all([this.ready, connect]).then(() => undefined);
    return {
      handle: {
        _serviceBrand: undefined,
        ready,
        connectionManager: view,
        // The baseline's lazy window tracks only the workspace manager's
        // initial load: freezing on the combined `ready` would keep it open
        // while a slow ephemeral server connects, and a workspace server
        // added in that window (plugin install, config edit) would leak into
        // the live session through the merged view. Overlay names are known
        // at construction, so they need no window at all.
        isBaselineServer: this.sessionBaseline(this.manager, this.ready, Object.keys(servers)),
      },
      shutdown: () => {
        unsubscribeOAuth();
        return sessionManager.shutdown();
      },
    };
  }

  /**
   * Subscribe a manager to the shared OAuth service's credential events,
   * returning the unsubscribe. A completed login reconnects a `needs-auth` /
   * `failed` entry; a reset or a failed proactive refresh flips a live
   * connection back to `needs-auth` (the reconnect hits a 401) instead of
   * leaving it doomed-but-connected.
   */
  private oauthEventSubscription(manager: McpConnectionManager): () => void {
    return this.oauthService.onEvent((event) => {
      void this.handleMcpOAuthEvent(manager, event).catch((error: unknown) => {
        this.log.warn(`mcp oauth event handling failed: ${String(error)}`);
      });
    });
  }

  private async handleMcpOAuthEvent(
    manager: McpConnectionManager,
    event: McpOAuthEvent,
  ): Promise<void> {
    // Client/verifier/discovery invalidations are flow-local; only token-level
    // changes move connections.
    if (event.type === 'tokens-invalidated' && event.scope !== 'tokens' && event.scope !== 'all') {
      return;
    }
    const entry = manager.get(event.serverName);
    if (entry === undefined) return;
    // The credential is keyed by name + canonical URL: if this manager's
    // entry points at a different URL now, the event is not about it.
    const serverUrl = manager.getRemoteServerUrl(event.serverName);
    if (serverUrl === undefined || canonicalMcpOAuthResource(serverUrl) !== event.serverUrl) return;
    if (event.type === 'tokens-invalidated') {
      // Drop the cached provider so the reconnect starts from clean state.
      this.oauthService.forgetProvider(event.serverName, event.serverUrl);
    }
    if (entry.status === 'disabled' || entry.status === 'removed') return;
    if (entry.status === 'pending') {
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = manager.onStatusChange((next) => {
          if (next.name !== event.serverName || next.status === 'pending') return;
          unsubscribe();
          if (next.status === 'disabled' || next.status === 'removed') {
            resolve();
            return;
          }
          void manager.reconnectAfterCurrent(event.serverName).then(resolve, reject);
        });
      });
      return;
    }
    if (
      event.type === 'tokens-saved' &&
      entry.status !== 'needs-auth' &&
      entry.status !== 'failed'
    ) {
      return;
    }
    // A failed proactive refresh only matters to a live connection.
    if (event.type === 'refresh-failed' && entry.status !== 'connected') return;
    await manager.reconnectAndJoin(event.serverName);
  }

  private sessionBaseline(
    view: McpConnectionView,
    ready: Promise<void>,
    extra?: readonly string[],
  ): (name: string) => boolean {
    const baseline = new Set<string>(extra);
    for (const entry of view.list()) {
      baseline.add(entry.name);
    }
    let frozen = false;
    void ready.then(
      () => {
        frozen = true;
      },
      () => {
        frozen = true;
      },
    );
    return (name) => {
      if (baseline.has(name)) return true;
      if (frozen) return false;
      if (view.get(name) === undefined) return false;
      baseline.add(name);
      return true;
    };
  }

  private mutate(work: () => Promise<void>): Promise<void> {
    const tail = this.mutationTail.catch(() => undefined).then(work);
    this.mutationTail = tail;
    return tail;
  }

  private async initialize(): Promise<void> {
    await this.mcpConfig.ready;
    await this.identity.resolved();
    const servers = this.mcpConfig.servers();
    if (Object.keys(servers).length === 0) return;
    await this.manager.connectAll(servers);
    this.trackMcpInitialLoad();
  }

  private scheduleApply(change: McpServersChange): void {
    void this.ready
      .then(() => this.mutate(() => this.apply(change)))
      .catch((error) => {
        this.log.warn(`mcp server change apply failed: ${String(error)}`);
      });
  }

  private async apply(change: McpServersChange): Promise<void> {
    for (const name of change.remove) {
      await this.manager.markRemoved(name);
    }
    for (const [name, config] of Object.entries(change.upsert)) {
      await this.manager.connect(name, config);
    }
  }

  private trackMcpInitialLoad(): void {
    const entries = this.manager.list().filter((entry) => entry.status !== 'disabled');
    const totalCount = entries.length;
    if (totalCount === 0) return;

    const connectedCount = entries.filter((entry) => entry.status === 'connected').length;
    if (connectedCount > 0) {
      this.telemetry.track2('mcp_connected', {
        server_count: connectedCount,
        total_count: totalCount,
      });
    }

    const failedCount = entries.filter((entry) => entry.status === 'failed').length;
    if (failedCount > 0) {
      this.telemetry.track2('mcp_failed', {
        failed_count: failedCount,
        total_count: totalCount,
      });
    }
  }
}
