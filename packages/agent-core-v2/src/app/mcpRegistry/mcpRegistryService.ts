/**
 * `mcpRegistry` domain — `IMcpRegistryService` implementation.
 *
 * Assembles the unified read view per query — config files and the plugin
 * install state are the sources of truth, so nothing here needs
 * invalidation: `global` entries come from the user-level store
 * (`mcpConfig`) alone, or from the layered files loaded through the
 * `mcpConfig` config loader when a `cwd` is supplied (rooted at the
 * `bootstrap` home dir); `plugin` entries come
 * from the `plugin` domain's full descriptor list (disabled plugins
 * included, managed env already merged). Reads go through the os
 * `IHostFileSystem`; resolution errors (e.g. a malformed project file)
 * propagate instead of reading as "not configured". Bound at App scope.
 */

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { ErrorCodes, Error2 } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { loadMcpServersDetailed } from '#/app/mcpConfig/configLoader';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import {
  IMcpRegistryService,
  type McpRegistryEntry,
  type McpRegistryQuery,
} from './mcpRegistry';

export class McpRegistryService implements IMcpRegistryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IMcpConfigStore private readonly store: IMcpConfigStore,
    @IPluginService private readonly plugins: IPluginService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async list(query: McpRegistryQuery = {}): Promise<readonly McpRegistryEntry[]> {
    const out: McpRegistryEntry[] = [];

    if (query.cwd === undefined) {
      const userEntries = await this.store.list();
      for (const server of userEntries) {
        const { name, ...config } = server;
        out.push({
          name,
          config,
          source: 'global',
          origin: this.store.path,
          mutable: true,
        });
      }
    } else {
      const detailed = await loadMcpServersDetailed({
        fs: this.fs,
        cwd: query.cwd,
        homeDir: this.bootstrap.homeDir,
      });
      for (const [name, config] of Object.entries(detailed.servers)) {
        const origin = detailed.origins[name] ?? this.store.path;
        out.push({
          name,
          config,
          source: 'global',
          origin,
          // Only entries whose effective definition lives in the user-level
          // file can be mutated through the management API — writing a
          // project-shadowed name would never change what sessions run.
          mutable: origin === this.store.path,
        });
      }
    }

    for (const entry of await this.plugins.mcpServerEntries()) {
      // A plugin entry whose runtime name collides with a global one is kept,
      // not dropped: the management plane must show the collision (the app
      // inspection surfaces it as `unavailable`) instead of hiding one side.
      out.push({
        name: entry.name,
        config: entry.config,
        source: 'plugin',
        origin: entry.pluginId,
        mutable: false,
        plugin: { id: entry.pluginId, name: entry.serverName },
      });
    }

    return out;
  }

  async get(name: string, query: McpRegistryQuery = {}): Promise<McpRegistryEntry> {
    const entry = (await this.list(query)).find((candidate) => candidate.name === name);
    if (entry !== undefined) return entry;
    throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
  }

  async resolveRuntimeTarget(
    name: string,
    query: McpRegistryQuery = {},
  ): Promise<McpRegistryEntry | undefined> {
    const matches = (await this.list(query)).filter((entry) => entry.name === name);
    const plugin = matches.find(
      (entry) => entry.source === 'plugin' && entry.config.enabled !== false,
    );
    if (plugin !== undefined) return plugin;
    return matches.find((entry) => entry.source === 'global');
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpRegistryService,
  McpRegistryService,
  ScopeActivation.OnDemand,
  'mcpRegistry',
);
