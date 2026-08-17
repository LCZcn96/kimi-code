/**
 * `mcpConfig` domain — MCP JSON config discovery and loading.
 *
 * Resolves the three MCP config files for a cwd (user `mcp.json` under the
 * kimi home, project-root `.mcp.json` — the root discovered through the
 * `git` domain's work-tree probe — and `.kimi-code/mcp.json` under the cwd)
 * and loads them with user < project-root < project precedence, normalizing
 * relative stdio `cwd` entries against the project-root file's directory.
 * `includeProject: false` skips the two project-level files and loads the
 * user file only — the workspace-trust gate: the project files ship with
 * the checkout, so an untrusted workspace must never see them.
 * {@link loadMcpServersDetailed} additionally reports the defining-file
 * origin of every effective entry, for management surfaces that show where
 * a server came from. All filesystem access goes through the os
 * `IHostFileSystem`, supplied by the caller. Pure functions — no scoped
 * state.
 */

import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { findGitWorkTree } from '#/app/git/workTree';
import { ErrorCodes, Error2 } from '#/errors';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { OsFsErrors, HostFsError } from '#/os/interface/hostFsErrors';

export interface McpJsonPaths {
  readonly user: string;
  readonly projectRoot: string;
  readonly project: string;
}

export interface ResolveMcpJsonPathsInput {
  readonly fs: IHostFileSystem;
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveMcpJsonPaths(input: ResolveMcpJsonPathsInput): Promise<McpJsonPaths> {
  const start = normalize(input.cwd);
  const projectRoot = (await findGitWorkTree(input.fs, start))?.root ?? start;

  return {
    user: join(resolveKimiHome(input.homeDir), 'mcp.json'),
    projectRoot: join(projectRoot, '.mcp.json'),
    project: join(input.cwd, '.kimi-code', 'mcp.json'),
  };
}

export interface LoadMcpServersInput {
  readonly fs: IHostFileSystem;
  readonly cwd: string;
  readonly homeDir?: string;
  readonly includeProject?: boolean;
}

export interface LoadMcpServersDetailedResult {
  /** Later layers override earlier ones with the same key. */
  readonly servers: Record<string, McpServerConfig>;
  /** The file each effective entry was last defined in. */
  readonly origins: Record<string, string>;
}

export async function loadMcpServers(
  input: LoadMcpServersInput,
): Promise<Record<string, McpServerConfig>> {
  return (await loadMcpServersDetailed(input)).servers;
}

/**
 * {@link loadMcpServers} plus the defining-file origin of every effective
 * entry, for management surfaces that show where a server came from.
 */
export async function loadMcpServersDetailed(
  input: LoadMcpServersInput,
): Promise<LoadMcpServersDetailedResult> {
  const paths = await resolveMcpJsonPaths(input);
  if (input.includeProject === false) {
    const user = await readMcpJson(input.fs, paths.user);
    return { servers: user, origins: mapValuesToPath(user, paths.user) };
  }
  const layers: readonly [path: string, servers: Record<string, McpServerConfig>][] =
    await Promise.all([
      readMcpJson(input.fs, paths.user),
      readMcpJson(input.fs, paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
      readMcpJson(input.fs, paths.project),
    ]).then(([user, projectRoot, project]) => [
      [paths.user, user],
      [paths.projectRoot, projectRoot],
      [paths.project, project],
    ]);
  // Null-prototype accumulators: a server literally named `__proto__` would
  // otherwise hit the prototype setter and silently vanish from the merge.
  const servers: Record<string, McpServerConfig> = Object.create(null);
  const origins: Record<string, string> = Object.create(null);
  for (const [path, layer] of layers) {
    for (const [name, config] of Object.entries(layer)) {
      servers[name] = config;
      origins[name] = path;
    }
  }
  return { servers, origins };
}

interface ReadMcpJsonOptions {
  readonly stdioCwdBase?: string;
}

async function readMcpJson(
  fs: IHostFileSystem,
  filePath: string,
  options: ReadMcpJsonOptions = {},
): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await fs.readText(filePath);
  } catch (error: unknown) {
    if (isFileNotFound(error)) return {};
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${filePath}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid JSON in ${filePath}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }

  try {
    return normalizeMcpServers(parseMcpJsonServers(data), options);
  } catch (error: unknown) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server config in ${filePath}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Parse the file's server map entry-by-entry instead of through a single
 * `z.record()`: a record parse rebuilds its output with property assignment,
 * which routes a literal `__proto__` server key through the prototype setter
 * and silently drops it. Per-entry parsing over the JSON own-keys keeps every
 * declared server.
 */
function parseMcpJsonServers(data: unknown): Record<string, McpServerConfig> {
  if (!isRecord(data)) {
    throw new Error('expected a JSON object');
  }
  const raw = data['mcpServers'] ?? {};
  if (!isRecord(raw)) {
    throw new Error('"mcpServers" must be an object');
  }
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, McpServerConfigSchema.parse(value)]),
  );
}

function normalizeMcpServers(
  servers: Record<string, McpServerConfig>,
  options: ReadMcpJsonOptions,
): Record<string, McpServerConfig> {
  const stdioCwdBase = options.stdioCwdBase;
  if (stdioCwdBase === undefined) return servers;

  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      normalizeStdioCwd(config, stdioCwdBase),
    ]),
  );
}

function normalizeStdioCwd(config: McpServerConfig, cwdBase: string): McpServerConfig {
  if (config.transport !== 'stdio') return config;
  const cwd = config.cwd === undefined ? cwdBase : resolvePath(cwdBase, config.cwd);
  return { ...config, cwd };
}

function mapValuesToPath(
  servers: Record<string, McpServerConfig>,
  path: string,
): Record<string, string> {
  const origins: Record<string, string> = Object.create(null);
  for (const name of Object.keys(servers)) {
    origins[name] = path;
  }
  return origins;
}

function resolvePath(base: string, value: string): string {
  return isAbsolute(value) ? normalize(value) : resolve(base, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
