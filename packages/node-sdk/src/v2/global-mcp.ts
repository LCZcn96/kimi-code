/**
 * The v1 user-global MCP file store (`<KIMI_CODE_HOME>/mcp.json` CRUD) plus
 * the inline/reconnect config validation, rebuilt for the v2 client.
 *
 * The unified management plane (CRUD facade, connection probe, inspection,
 * OAuth orchestration) delegates to the engine's App-scope
 * `IMcpManagementService`; what remains here serves the session-level MCP
 * methods of `sdk-rpc-client-v2.ts`, which ride the session's own connection
 * manager and have no engine service behind them: the store persists
 * `addSessionMcpServer`'s `persist: true` adds byte-for-byte like v1
 * (`agent-core/src/mcp/global-config.ts`), and the validators keep v1's exact
 * error text for the session RPC paths. Validation keeps using v1's own
 * `McpServerConfigSchema`.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ErrorCodes,
  KimiError,
  McpServerConfigSchema,
  type GlobalMcpServerConfig,
  type McpServerConfig,
} from '@moonshot-ai/agent-core';
import { atomicWrite } from '@moonshot-ai/agent-core-v2/_base/utils/fs';

interface GlobalMcpConfigFile {
  readonly raw: Record<string, unknown>;
  readonly rawServers: Record<string, unknown>;
  readonly servers: readonly GlobalMcpServerConfig[];
}

/** Byte-identical port of v1's `GlobalMcpConfigStore`. */
export class GlobalMcpConfigStore {
  readonly path: string;

  constructor(homeDir: string) {
    this.path = join(homeDir, 'mcp.json');
  }

  async list(): Promise<readonly GlobalMcpServerConfig[]> {
    return (await this.read()).servers;
  }

  async get(name: string): Promise<GlobalMcpServerConfig> {
    const normalizedName = normalizeServerName(name);
    const server = (await this.read()).servers.find((entry) => entry.name === normalizedName);
    if (server !== undefined) return server;
    throw serverNotFound(normalizedName);
  }

  async add(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]> {
    const normalized = parseServerInput(server);
    const file = await this.read();
    if (Object.hasOwn(file.rawServers, normalized.name)) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `MCP server "${normalized.name}" already exists`,
      );
    }
    await this.write(file, {
      ...file.rawServers,
      [normalized.name]: persistedEntry(normalized),
    });
    return this.list();
  }

  async update(server: GlobalMcpServerConfig): Promise<readonly GlobalMcpServerConfig[]> {
    const normalized = parseServerInput(server);
    const file = await this.read();
    if (!Object.hasOwn(file.rawServers, normalized.name)) {
      throw serverNotFound(normalized.name);
    }
    await this.write(file, {
      ...file.rawServers,
      [normalized.name]: persistedEntry(normalized),
    });
    return this.list();
  }

  async remove(name: string): Promise<readonly GlobalMcpServerConfig[]> {
    const normalizedName = normalizeServerName(name);
    const file = await this.read();
    if (!Object.hasOwn(file.rawServers, normalizedName)) return file.servers;
    const nextServers = Object.fromEntries(
      Object.entries(file.rawServers).filter(([entryName]) => entryName !== normalizedName),
    );
    await this.write(file, nextServers);
    return this.list();
  }

  private async read(): Promise<GlobalMcpConfigFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf-8');
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        return { raw: {}, rawServers: {}, servers: [] };
      }
      throw configError(`Failed to read ${this.path}: ${describeError(error)}`, error);
    }

    if (text.trim().length === 0) {
      return { raw: {}, rawServers: {}, servers: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw configError(`Invalid JSON in ${this.path}: ${describeError(error)}`, error);
    }
    if (!isRecord(parsed)) {
      throw configError(`Invalid MCP config in ${this.path}: expected a JSON object`);
    }
    const rawServersValue = parsed['mcpServers'];
    if (rawServersValue !== undefined && !isRecord(rawServersValue)) {
      throw configError(`Invalid MCP config in ${this.path}: "mcpServers" must be an object`);
    }
    const rawServers = rawServersValue ?? {};
    const servers = Object.entries(rawServers).map(([name, value]) => parseServer(name, value));
    return { raw: parsed, rawServers, servers };
  }

  private async write(
    file: GlobalMcpConfigFile,
    rawServers: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await atomicWrite(
      this.path,
      `${JSON.stringify({ ...file.raw, mcpServers: rawServers }, null, 2)}\n`,
    );
  }
}

/** Byte-identical port of v1's `mcpConfigWithoutName`. */
export function mcpConfigWithoutName(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...config } = server;
  return config;
}

/**
 * Byte-identical port of v1's inline-server validation (the `server` branch
 * of `resolveMcpTestTarget`, shared with `addSessionMcpServer`): the schema
 * strips unknown keys such as a stray `name`, so the name is re-attached.
 */
export function parseInlineMcpServer(server: GlobalMcpServerConfig): GlobalMcpServerConfig {
  const parsed = McpServerConfigSchema.safeParse(server);
  if (!parsed.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server "${server.name}": ${parsed.error.message}`,
    );
  }
  return { name: server.name, ...parsed.data };
}

/**
 * Byte-identical port of v1's reconnect-config validation
 * (`SessionAPIImpl.reconnectMcpServer`): same schema strip, nameless result.
 */
export function parseReconnectMcpServerConfig(
  name: string,
  config: GlobalMcpServerConfig,
): McpServerConfig {
  const parsed = McpServerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server config for "${name}": ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseServerInput(server: GlobalMcpServerConfig): GlobalMcpServerConfig {
  return parseServer(normalizeServerName(server.name), server);
}

function parseServer(name: string, value: unknown): GlobalMcpServerConfig {
  const result = McpServerConfigSchema.safeParse(value);
  if (!result.success) {
    throw configError(
      `Invalid MCP server "${name}" in global config: ${result.error.message}`,
      result.error,
    );
  }
  return { name, ...result.data };
}

function persistedEntry(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...entry } = server;
  return entry;
}

export function normalizeServerName(name: string): string {
  const normalized = name.trim();
  if (normalized.length > 0) return normalized;
  throw new KimiError(ErrorCodes.REQUEST_INVALID, 'MCP server name cannot be empty');
}

function serverNotFound(name: string): KimiError {
  return new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
}

function configError(message: string, cause?: unknown): KimiError {
  return new KimiError(ErrorCodes.CONFIG_INVALID, message, { cause });
}

function errorCode(error: unknown): unknown {
  if (!isRecord(error)) return undefined;
  return error['code'];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
