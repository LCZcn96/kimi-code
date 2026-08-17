/**
 * `mcpRegistry` domain — `IMcpRegistryService` contract.
 *
 * The unified read view over every MCP server source the management plane
 * knows about: the layered config files (`global` — the user-level
 * `mcp.json` plus, when a `cwd` is supplied, the project-root `.mcp.json`
 * and project-local `.kimi-code/mcp.json`) and plugin manifests (`plugin`,
 * the final effective config after the plugin contributor's transforms;
 * read-only, config ownership lives in the manifest). Only user-level
 * entries are `mutable` through the management API (writes keep landing in
 * the user-level file). A runtime-name collision keeps both entries — the
 * management plane must show the collision instead of hiding one side —
 * while {@link IMcpRegistryService.resolveRuntimeTarget} picks the entry a
 * live session should actually run (an enabled plugin entry wins over the
 * file layers; a disabled plugin descriptor is treated as absent). Caller
 * (SDK-injected) entries are session-scoped and never appear here. Bound at
 * App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { McpServerConfig } from '#/mcpCore/config-schema';

export type McpServerSource = 'global' | 'plugin' | 'caller';

export interface McpRegistryPluginOrigin {
  readonly id: string;
  /** Manifest-local server name (without the `plugin-<id>:` runtime prefix). */
  readonly name: string;
}

export interface McpRegistryEntry {
  /** Runtime name — for plugin entries the renamed `plugin-<id>:<name>` form. */
  readonly name: string;
  /** Final effective config after source-specific transforms. */
  readonly config: McpServerConfig;
  readonly source: McpServerSource;
  /** global: the defining file path; plugin: the plugin id; caller: `'caller'`. */
  readonly origin: string;
  /** True only for user-level global entries — the management API writes there. */
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
}

export interface McpRegistryQuery {
  /**
   * When set, the project-root and project-local layers join the global
   * source. Session-scoped resolutions pass the session workDir; the
   * process-global management plane usually omits it.
   */
  readonly cwd?: string;
}

export interface IMcpRegistryService {
  readonly _serviceBrand: undefined;

  list(query?: McpRegistryQuery): Promise<readonly McpRegistryEntry[]>;

  /** First match wins on a runtime-name collision (globals list first). */
  get(name: string, query?: McpRegistryQuery): Promise<McpRegistryEntry>;

  /**
   * Session-runtime resolution for one server name — the entry a live
   * session should actually run, as opposed to the management view which
   * lists every collision side by side. Returns `undefined` when no source
   * currently defines the name.
   */
  resolveRuntimeTarget(name: string, query?: McpRegistryQuery): Promise<McpRegistryEntry | undefined>;
}

export const IMcpRegistryService: ServiceIdentifier<IMcpRegistryService> =
  createDecorator<IMcpRegistryService>('mcpRegistryService');

export { mcpServerConfigsEqual } from '#/mcpCore/connection-manager';
