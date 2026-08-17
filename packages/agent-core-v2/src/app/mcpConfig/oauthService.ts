/**
 * `mcpConfig` domain — `IMcpOAuthService`, the App-scope shared MCP OAuth
 * orchestrator.
 *
 * One process-wide `McpOAuthService` (the `mcpCore` mechanism class) over the
 * shared `IMcpOAuthStore` credential persistence: every workspace handler and
 * session overlay attaches its providers instead of building per-handler
 * services, so credential events, single-flight refreshes, and proactive
 * refresh timers are process-global and N handlers sharing one server cannot
 * interfere. The constructor starts the proactive-refresh sweep from the
 * persisted credential meta sidecars. The client name announced on OAuth
 * dynamic registration is the identity snapshot's slug, consulted per
 * provider so an identity configured after construction still applies.
 * Disposing the App scope shuts the service down (timers, in-flight flows,
 * providers). Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { LifecycleScope } from '#/app/scopes';
import { McpOAuthService } from '#/mcpCore/oauth/service';

import { IMcpOAuthStore } from './oauthStore';

export const IMcpOAuthService: ServiceIdentifier<McpOAuthService> =
  createDecorator<McpOAuthService>('mcpOAuthService');

export class AppMcpOAuthService extends McpOAuthService {
  constructor(
    @IMcpOAuthStore store: IMcpOAuthStore,
    @IAgentIdentity identity: IAgentIdentity,
    @ILogService log: ILogService,
  ) {
    super({
      store,
      resolveClientName: () => identity.current().slug,
      log,
    });
    void this.sweepProactiveRefresh().catch((error: unknown) => {
      log.warn(`mcp oauth proactive-refresh sweep failed: ${String(error)}`);
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpOAuthService,
  AppMcpOAuthService,
  ScopeActivation.OnDemand,
  'mcpConfig',
);
