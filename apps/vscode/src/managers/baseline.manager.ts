import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

import type { FileChange, UndoFileChangesResult } from '../../shared/types';
import { relativeFsPath } from '../utils/fs-path';

const MANIFEST_VERSION = 2;
const SNAPSHOT_HASH = /^[a-f0-9]{64}$/;

export interface BaselineSession {
  readonly id: string;
  readonly workDir: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ManifestEntry {
  readonly snapshot: string;
  readonly existedBefore: boolean;
}

interface TurnFileEntry {
  readonly beforeSnapshot: string;
  readonly existedBefore: boolean;
  readonly afterSnapshot?: string;
  readonly existedAfter?: boolean;
  readonly diverged?: boolean;
}

interface TurnEntry {
  readonly id: string;
  readonly files: Readonly<Record<string, TurnFileEntry>>;
}

interface BaselineManifestV2 {
  readonly version: 2;
  readonly sessionId: string;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
  readonly acceptedLegacyPaths: readonly string[];
  readonly turns: readonly TurnEntry[];
}

interface MutableManifest {
  version: 2;
  sessionId: string;
  entries: Record<string, ManifestEntry>;
  acceptedLegacyPaths: string[];
  turns: Array<{ id: string; files: Record<string, TurnFileEntry> }>;
}

export interface ResolvedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface BaselineValue {
  readonly content: string;
  readonly existedBefore: boolean;
}

export class BaselineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BaselineError';
  }
}

export class BaselineManager {
  private readonly baselinesRoot: string;
  private readonly updates = new Map<string, Promise<void>>();

  constructor(globalStorageRoot: string, homeNamespace = 'default') {
    if (globalStorageRoot.length === 0) {
      throw new BaselineError('The VSCode global storage path is empty');
    }
    if (homeNamespace.length === 0) {
      throw new BaselineError('The Kimi home namespace is empty');
    }
    this.baselinesRoot = path.join(globalStorageRoot, 'baselines', hash(homeNamespace));
  }

  /**
   * Capture the file synchronously before returning control to the caller.
   * Persistence is serialized per session and completes through the returned
   * promise, but no `await` occurs before the original file has been read.
   */
  async capture(session: BaselineSession, filePath: string, turnId?: string): Promise<void> {
    if (turnId !== undefined) requireTurnId(turnId);
    const resolved = resolveSessionFile(session, filePath);
    const captured = captureOriginal(resolved.absolutePath);

    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const next = mutableManifest(manifest);
      let changed = false;
      const localPath = equivalentPath(
        session,
        Object.keys(manifest.entries),
        resolved.relativePath,
      );
      if (localPath === undefined) {
        const accepted = new Set(manifest.acceptedLegacyPaths);
        const acceptedPath = equivalentPath(session, accepted, resolved.relativePath);
        const useLegacy = acceptedPath === undefined
          && await this.hasLegacyBaseline(session, resolved.relativePath);
        if (!useLegacy) {
          const snapshot = hash(captured.content);
          await this.writeSnapshot(session.id, snapshot, captured.content);
          if (acceptedPath !== undefined) accepted.delete(acceptedPath);
          next.entries[resolved.relativePath] = {
            snapshot,
            existedBefore: captured.existedBefore,
          };
          next.acceptedLegacyPaths = uniquePaths(session, accepted);
          changed = true;
        }
      }

      if (turnId !== undefined) {
        let turn = next.turns.find((entry) => entry.id === turnId);
        if (turn === undefined) {
          turn = { id: turnId, files: {} };
          next.turns.push(turn);
          changed = true;
        }
        const turnPath = equivalentPath(session, Object.keys(turn.files), resolved.relativePath);
        if (turnPath === undefined) {
          const beforeSnapshot = hash(captured.content);
          await this.writeSnapshot(session.id, beforeSnapshot, captured.content);
          turn.files[resolved.relativePath] = {
            beforeSnapshot,
            existedBefore: captured.existedBefore,
          };
          changed = true;
        } else {
          const entry = turn.files[turnPath];
          const current = captured.existedBefore ? captured.content : undefined;
          if (
            entry?.afterSnapshot !== undefined
            && entry.existedAfter !== undefined
            && entry.diverged !== true
            && !matchesTurnOutput(current, entry)
          ) {
            turn.files[turnPath] = { ...entry, diverged: true };
            changed = true;
          }
        }
      }

      if (changed) await this.writeManifest(next);
    });
  }

  async captureTurnOutput(
    session: BaselineSession,
    filePath: string,
    turnId: string,
  ): Promise<void> {
    requireTurnId(turnId);
    const resolved = resolveSessionFile(session, filePath);
    const captured = captureOriginal(resolved.absolutePath);

    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const next = mutableManifest(manifest);
      const turn = next.turns.find((entry) => entry.id === turnId);
      if (turn === undefined) return;
      const turnPath = equivalentPath(session, Object.keys(turn.files), resolved.relativePath);
      if (turnPath === undefined) return;
      const entry = turn.files[turnPath];
      if (entry === undefined) return;

      const afterSnapshot = hash(captured.content);
      await this.writeSnapshot(session.id, afterSnapshot, captured.content);
      turn.files[turnPath] = {
        ...entry,
        afterSnapshot,
        existedAfter: captured.existedBefore,
      };
      await this.writeManifest(next);
    });
  }

  async finishTurn(session: BaselineSession, turnId: string): Promise<void> {
    requireTurnId(turnId);
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const next = mutableManifest(manifest);
      let turn = next.turns.find((entry) => entry.id === turnId);
      let changed = false;
      if (turn === undefined) {
        turn = { id: turnId, files: {} };
        next.turns.push(turn);
        changed = true;
      }

      for (const [relativePath, entry] of Object.entries(turn.files)) {
        if (entry.afterSnapshot !== undefined && entry.existedAfter !== undefined) continue;
        const current = await readCurrentFile(resolveSessionFile(session, relativePath).absolutePath);
        const afterSnapshot = hash(current ?? '');
        await this.writeSnapshot(session.id, afterSnapshot, current ?? '');
        turn.files[relativePath] = {
          ...entry,
          afterSnapshot,
          existedAfter: current !== undefined,
        };
        changed = true;
      }

      if (changed) await this.writeManifest(next);
    });
  }

  async undoTurns(
    session: BaselineSession,
    count: number,
    restoreFiles: boolean,
    isRestoreProtected: (absolutePath: string) => boolean = () => false,
  ): Promise<UndoFileChangesResult> {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new BaselineError('The turn undo count must be a positive safe integer');
    }

    return this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const next = mutableManifest(manifest);
      const available = count <= next.turns.length;
      const start = Math.max(0, next.turns.length - count);
      const turns = available ? next.turns.slice(start) : [];
      next.turns.splice(start);

      if (!restoreFiles || !available) {
        await this.writeManifest(next);
        await this.removeUnreferencedSnapshots(session.id, next);
        return emptyUndoResult(restoreFiles ? 'unavailable' : 'kept');
      }

      const targets = new Map<string, {
        relativePath: string;
        before: TurnFileEntry;
        after: TurnFileEntry;
        diverged: boolean;
      }>();
      for (const turn of turns) {
        for (const [relativePath, entry] of Object.entries(turn.files)) {
          const key = pathComparisonKey(session, relativePath);
          const existing = targets.get(key);
          if (existing === undefined) {
            targets.set(key, {
              relativePath,
              before: entry,
              after: entry,
              diverged: entry.diverged === true,
            });
          } else {
            existing.after = entry;
            existing.diverged ||= entry.diverged === true;
          }
        }
      }

      const plans: Array<{
        relativePath: string;
        absolutePath: string;
        before: BaselineValue;
        after: TurnFileEntry;
        diverged: boolean;
      }> = [];
      const result = emptyUndoResult('restored');
      for (const target of [...targets.values()].toSorted((a, b) =>
        a.relativePath.localeCompare(b.relativePath))) {
        try {
          const content = await this.readSnapshot(
            session.id,
            target.before.beforeSnapshot,
            target.relativePath,
          );
          plans.push({
            relativePath: target.relativePath,
            absolutePath: resolveSessionFile(session, target.relativePath).absolutePath,
            before: { content, existedBefore: target.before.existedBefore },
            after: target.after,
            diverged: target.diverged,
          });
        } catch {
          result.failed.push(target.relativePath);
        }
      }

      // Remove the conversation anchors before touching files so later turns
      // cannot be matched against history the engine has already discarded.
      await this.writeManifest(next);

      for (const plan of plans) {
        try {
          if (plan.diverged || isRestoreProtected(plan.absolutePath)) {
            result.conflicted.push(plan.relativePath);
            continue;
          }
          const current = await readCurrentFile(plan.absolutePath);
          if (matchesBaseline(current, plan.before)) {
            (plan.before.existedBefore ? result.restored : result.removed).push(plan.relativePath);
            continue;
          }
          if (!matchesTurnOutput(current, plan.after)) {
            result.conflicted.push(plan.relativePath);
            continue;
          }
          await restoreFile(session.workDir, plan.absolutePath, plan.before);
          (plan.before.existedBefore ? result.restored : result.removed).push(plan.relativePath);
        } catch {
          result.failed.push(plan.relativePath);
        }
      }
      if (result.conflicted.length > 0 || result.failed.length > 0) {
        result.status = 'partial';
      }
      await this.removeUnreferencedSnapshots(session.id, next);
      return result;
    });
  }

  async getChanges(session: BaselineSession): Promise<FileChange[]> {
    await this.waitForUpdates([session.id]);
    const manifest = await this.readManifest(session);
    const relativePaths = await this.effectivePaths(session, manifest);
    const changes: FileChange[] = [];

    for (const relativePath of relativePaths) {
      const baseline = await this.readEffectiveBaseline(session, relativePath, manifest);
      if (baseline === undefined) continue;

      const resolved = resolveSessionFile(session, relativePath);
      const currentContent = await readCurrentFile(resolved.absolutePath);
      if (currentContent === undefined) {
        if (baseline.existedBefore) {
          changes.push({
            path: relativePath,
            status: 'Deleted',
            additions: 0,
            deletions: countLines(baseline.content),
          });
        }
        continue;
      }

      if (!baseline.existedBefore) {
        changes.push({
          path: relativePath,
          status: 'Added',
          additions: countLines(currentContent),
          deletions: 0,
        });
        continue;
      }

      if (currentContent !== baseline.content) {
        const diff = computeLineDiff(baseline.content, currentContent);
        changes.push({
          path: relativePath,
          status: 'Modified',
          additions: diff.additions,
          deletions: diff.deletions,
        });
      }
    }

    return changes;
  }

  async getContent(session: BaselineSession, filePath: string): Promise<string> {
    await this.waitForUpdates([session.id]);
    const resolved = resolveSessionFile(session, filePath);
    const manifest = await this.readManifest(session);
    const baseline = await this.readEffectiveBaseline(session, resolved.relativePath, manifest);
    if (baseline === undefined) {
      throw new BaselineError(
        `No baseline exists for "${resolved.relativePath}" in session "${session.id}"`,
      );
    }
    return baseline.content;
  }

  async undo(session: BaselineSession, filePath: string): Promise<void> {
    const resolved = resolveSessionFile(session, filePath);
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const baseline = await this.readEffectiveBaseline(session, resolved.relativePath, manifest);
      if (baseline === undefined) {
        throw new BaselineError(
          `No baseline exists for "${resolved.relativePath}" in session "${session.id}"`,
        );
      }
      await restoreFile(session.workDir, resolved.absolutePath, baseline);
      const next = mutableManifest(manifest);
      removeTurnFile(session, next, resolved.relativePath);
      await this.writeManifest(next);
      await this.removeUnreferencedSnapshots(session.id, next);
    });
  }

  async undoAll(session: BaselineSession): Promise<void> {
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const relativePaths = await this.effectivePaths(session, manifest);
      for (const relativePath of relativePaths) {
        const baseline = await this.readEffectiveBaseline(session, relativePath, manifest);
        if (baseline === undefined) continue;
        await restoreFile(
          session.workDir,
          resolveSessionFile(session, relativePath).absolutePath,
          baseline,
        );
      }
      const next = mutableManifest(manifest);
      clearTurnFiles(next);
      await this.writeManifest(next);
      await this.removeUnreferencedSnapshots(session.id, next);
    });
  }

  async keep(session: BaselineSession, filePath: string): Promise<void> {
    const resolved = resolveSessionFile(session, filePath);
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const localPath = equivalentPath(
        session,
        Object.keys(manifest.entries),
        resolved.relativePath,
      );
      const hadLocal = localPath !== undefined;
      const hasLegacy = await this.hasLegacyBaseline(session, resolved.relativePath);
      const hadTurn = hasTurnFile(session, manifest, resolved.relativePath);
      if (!hadLocal && !hasLegacy && !hadTurn) return;

      const next = mutableManifest(manifest);
      if (localPath !== undefined) delete next.entries[localPath];
      const accepted = new Set(next.acceptedLegacyPaths);
      const acceptedPath = equivalentPath(session, accepted, resolved.relativePath);
      if (acceptedPath !== undefined) accepted.delete(acceptedPath);
      if (hasLegacy) accepted.add(resolved.relativePath);
      next.acceptedLegacyPaths = uniquePaths(session, accepted);
      removeTurnFile(session, next, resolved.relativePath);

      await this.writeManifest(next);
      await this.removeUnreferencedSnapshots(session.id, next);
    });
  }

  async keepAll(session: BaselineSession): Promise<void> {
    await this.serialize([session.id], async () => {
      const manifest = await this.readManifest(session);
      const legacyPaths = await this.listLegacyPaths(session);
      const next = mutableManifest(manifest);
      next.entries = {};
      next.acceptedLegacyPaths = uniquePaths(session, [
        ...next.acceptedLegacyPaths,
        ...legacyPaths,
      ]);
      clearTurnFiles(next);

      await this.writeManifest(next);
      await this.removeUnreferencedSnapshots(session.id, next);
    });
  }

  async materializeToFork(source: BaselineSession, target: BaselineSession): Promise<void> {
    if (source.id === target.id) {
      throw new BaselineError('Cannot materialize a baseline fork onto the source session');
    }

    await this.serialize([source.id, target.id], async () => {
      const sourceManifest = await this.readManifest(source);
      const sourcePaths = await this.effectivePaths(source, sourceManifest);
      const values = new Map<string, BaselineValue>();
      for (const relativePath of sourcePaths) {
        const baseline = await this.readEffectiveBaseline(source, relativePath, sourceManifest);
        if (baseline !== undefined) values.set(relativePath, baseline);
      }

      const targetManifest = await this.readManifest(target);
      const next = mutableManifest(targetManifest);
      const accepted = uniquePaths(target, [
        ...next.acceptedLegacyPaths,
        ...sourceManifest.acceptedLegacyPaths,
      ]);

      for (const [relativePath, baseline] of values) {
        const existingPath = equivalentPath(target, Object.keys(next.entries), relativePath);
        if (existingPath !== undefined) continue;
        const snapshot = hash(baseline.content);
        await this.writeSnapshot(target.id, snapshot, baseline.content);
        next.entries[relativePath] = {
          snapshot,
          existedBefore: baseline.existedBefore,
        };
      }

      next.acceptedLegacyPaths = accepted;
      await this.writeManifest(next);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    requireSessionId(sessionId);
    await this.serialize([sessionId], async () => {
      await rm(this.sessionRoot(sessionId), { recursive: true, force: true });
    });
  }

  private async effectivePaths(
    session: BaselineSession,
    manifest: BaselineManifestV2,
  ): Promise<string[]> {
    const paths = new Map<string, string>();
    for (const relativePath of Object.keys(manifest.entries)) {
      paths.set(pathComparisonKey(session, relativePath), relativePath);
    }
    const accepted = new Set(
      manifest.acceptedLegacyPaths.map((relativePath) =>
        pathComparisonKey(session, relativePath),
      ),
    );
    for (const relativePath of await this.listLegacyPaths(session)) {
      const key = pathComparisonKey(session, relativePath);
      if (!accepted.has(key) && !paths.has(key)) paths.set(key, relativePath);
    }
    return [...paths.values()].toSorted();
  }

  private async readEffectiveBaseline(
    session: BaselineSession,
    relativePath: string,
    manifest: BaselineManifestV2,
  ): Promise<BaselineValue | undefined> {
    const localPath = equivalentPath(session, Object.keys(manifest.entries), relativePath);
    const local = localPath === undefined ? undefined : manifest.entries[localPath];
    if (localPath !== undefined && local !== undefined) {
      const content = await this.readSnapshot(session.id, local.snapshot, localPath);
      return { content, existedBefore: local.existedBefore };
    }

    if (equivalentPath(session, manifest.acceptedLegacyPaths, relativePath) !== undefined) {
      return undefined;
    }
    return this.readLegacyBaseline(session, relativePath);
  }

  private async readManifest(session: BaselineSession): Promise<BaselineManifestV2> {
    requireSession(session);
    let text: string;
    try {
      text = await readFile(this.manifestPath(session.id), 'utf-8');
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return emptyManifest(session.id);
      throw new BaselineError(`Unable to read baseline manifest for session "${session.id}"`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new BaselineError(`Baseline manifest for session "${session.id}" is invalid JSON`, {
        cause: error,
      });
    }
    return parseManifest(parsed, session);
  }

  private async writeManifest(manifest: BaselineManifestV2): Promise<void> {
    if (
      Object.keys(manifest.entries).length === 0 &&
      manifest.acceptedLegacyPaths.length === 0 &&
      manifest.turns.length === 0
    ) {
      await rm(this.sessionRoot(manifest.sessionId), { recursive: true, force: true });
      return;
    }

    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await atomicWrite(this.manifestPath(manifest.sessionId), text);
  }

  private async writeSnapshot(sessionId: string, snapshot: string, content: string): Promise<void> {
    const snapshotPath = this.snapshotPath(sessionId, snapshot);
    try {
      const existing = await readFile(snapshotPath, 'utf-8');
      if (hash(existing) !== snapshot) {
        throw new BaselineError(
          `Baseline snapshot "${snapshot}" for session "${sessionId}" is corrupt`,
        );
      }
      return;
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        if (error instanceof BaselineError) throw error;
        throw new BaselineError(
          `Unable to inspect baseline snapshot "${snapshot}" for session "${sessionId}"`,
          { cause: error },
        );
      }
    }
    await atomicWrite(snapshotPath, content);
  }

  private async readSnapshot(
    sessionId: string,
    snapshot: string,
    relativePath: string,
  ): Promise<string> {
    let content: string;
    try {
      content = await readFile(this.snapshotPath(sessionId, snapshot), 'utf-8');
    } catch (error) {
      throw new BaselineError(
        `Unable to read baseline snapshot for "${relativePath}" in session "${sessionId}"`,
        { cause: error },
      );
    }
    if (hash(content) !== snapshot) {
      throw new BaselineError(
        `Baseline snapshot for "${relativePath}" in session "${sessionId}" is corrupt`,
      );
    }
    return content;
  }

  private async removeUnreferencedSnapshots(
    sessionId: string,
    manifest: BaselineManifestV2,
  ): Promise<void> {
    const snapshotsDir = this.snapshotsRoot(sessionId);
    let names: string[];
    try {
      names = await readdir(snapshotsDir);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return;
      throw new BaselineError(`Unable to clean baseline snapshots for session "${sessionId}"`, {
        cause: error,
      });
    }

    const referenced = new Set(Object.values(manifest.entries).map((entry) => entry.snapshot));
    for (const turn of manifest.turns) {
      for (const entry of Object.values(turn.files)) {
        referenced.add(entry.beforeSnapshot);
        if (entry.afterSnapshot !== undefined) referenced.add(entry.afterSnapshot);
      }
    }
    await Promise.all(
      names.map(async (name) => {
        if (referenced.has(name)) return;
        await rm(path.join(snapshotsDir, name), { force: true });
      }),
    );
  }

  private async listLegacyPaths(session: BaselineSession): Promise<string[]> {
    const root = legacyBaselineRoot(session);
    if (root === undefined) return [];

    const result: string[] = [];
    await walkLegacyBaselines(root, '', result);
    return result.toSorted();
  }

  private async hasLegacyBaseline(
    session: BaselineSession,
    relativePath: string,
  ): Promise<boolean> {
    const legacyPath = legacyBaselinePath(session, relativePath);
    if (legacyPath === undefined) return false;
    try {
      const info = await stat(legacyPath);
      if (!info.isFile()) {
        throw new BaselineError(`Legacy baseline "${relativePath}" is not a regular file`);
      }
      return true;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return false;
      if (error instanceof BaselineError) throw error;
      throw new BaselineError(`Unable to inspect legacy baseline "${relativePath}"`, {
        cause: error,
      });
    }
  }

  private async readLegacyBaseline(
    session: BaselineSession,
    relativePath: string,
  ): Promise<BaselineValue | undefined> {
    const legacyPath = legacyBaselinePath(session, relativePath);
    if (legacyPath === undefined) return undefined;

    let info;
    try {
      info = await stat(legacyPath);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return undefined;
      throw new BaselineError(`Unable to inspect legacy baseline "${relativePath}"`, {
        cause: error,
      });
    }
    if (!info.isFile()) {
      throw new BaselineError(`Legacy baseline "${relativePath}" is not a regular file`);
    }

    try {
      const content = await readFile(legacyPath, 'utf-8');
      return { content, existedBefore: content.length > 0 };
    } catch (error) {
      throw new BaselineError(`Unable to read legacy baseline "${relativePath}"`, {
        cause: error,
      });
    }
  }

  private async serialize<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(sessionIds)].toSorted();
    for (const id of ids) requireSessionId(id);

    const previous = ids.map((id) => this.updates.get(id) ?? Promise.resolve());
    const run = Promise.all(previous).then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    for (const id of ids) this.updates.set(id, settled);
    void settled.then(() => {
      for (const id of ids) {
        if (this.updates.get(id) === settled) this.updates.delete(id);
      }
    });
    return run;
  }

  private async waitForUpdates(sessionIds: readonly string[]): Promise<void> {
    await Promise.all(sessionIds.map((id) => this.updates.get(id) ?? Promise.resolve()));
  }

  private sessionRoot(sessionId: string): string {
    return path.join(this.baselinesRoot, hash(sessionId));
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.sessionRoot(sessionId), 'manifest.json');
  }

  private snapshotsRoot(sessionId: string): string {
    return path.join(this.sessionRoot(sessionId), 'snapshots');
  }

  private snapshotPath(sessionId: string, snapshot: string): string {
    if (!SNAPSHOT_HASH.test(snapshot)) {
      throw new BaselineError(`Invalid baseline snapshot hash "${snapshot}"`);
    }
    return path.join(this.snapshotsRoot(sessionId), snapshot);
  }
}

function emptyManifest(sessionId: string): BaselineManifestV2 {
  return {
    version: MANIFEST_VERSION,
    sessionId,
    entries: {},
    acceptedLegacyPaths: [],
    turns: [],
  };
}

function mutableManifest(manifest: BaselineManifestV2): MutableManifest {
  return {
    version: MANIFEST_VERSION,
    sessionId: manifest.sessionId,
    entries: { ...manifest.entries },
    acceptedLegacyPaths: [...manifest.acceptedLegacyPaths],
    turns: manifest.turns.map((turn) => ({ id: turn.id, files: { ...turn.files } })),
  };
}

function parseManifest(value: unknown, session: BaselineSession): BaselineManifestV2 {
  if (!isRecord(value) || (value['version'] !== 1 && value['version'] !== MANIFEST_VERSION)) {
    throw new BaselineError(`Unsupported baseline manifest for session "${session.id}"`);
  }
  if (value['sessionId'] !== session.id) {
    throw new BaselineError(`Baseline manifest does not belong to session "${session.id}"`);
  }

  const rawEntries = value['entries'];
  const rawAccepted = value['acceptedLegacyPaths'];
  if (!isRecord(rawEntries) || !Array.isArray(rawAccepted)) {
    throw new BaselineError(`Invalid baseline manifest for session "${session.id}"`);
  }

  const entries: Record<string, ManifestEntry> = {};
  const entryKeys = new Set<string>();
  for (const [rawPath, rawEntry] of Object.entries(rawEntries)) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry['snapshot'] !== 'string' ||
      !SNAPSHOT_HASH.test(rawEntry['snapshot']) ||
      typeof rawEntry['existedBefore'] !== 'boolean'
    ) {
      throw new BaselineError(`Invalid baseline entry "${rawPath}" in session "${session.id}"`);
    }
    const relativePath = resolveSessionFile(session, rawPath).relativePath;
    const comparisonKey = pathComparisonKey(session, relativePath);
    if (relativePath !== rawPath || entryKeys.has(comparisonKey)) {
      throw new BaselineError(`Unsafe baseline path "${rawPath}" in session "${session.id}"`);
    }
    entryKeys.add(comparisonKey);
    entries[relativePath] = {
      snapshot: rawEntry['snapshot'],
      existedBefore: rawEntry['existedBefore'],
    };
  }

  const acceptedLegacyPaths: string[] = [];
  for (const rawPath of rawAccepted) {
    if (typeof rawPath !== 'string') {
      throw new BaselineError(`Invalid accepted legacy path in session "${session.id}"`);
    }
    const relativePath = resolveSessionFile(session, rawPath).relativePath;
    if (relativePath !== rawPath) {
      throw new BaselineError(`Unsafe accepted legacy path "${rawPath}" in session "${session.id}"`);
    }
    if (equivalentPath(session, acceptedLegacyPaths, relativePath) === undefined) {
      acceptedLegacyPaths.push(relativePath);
    }
  }

  const rawTurns = value['version'] === 1 ? [] : value['turns'];
  if (!Array.isArray(rawTurns)) {
    throw new BaselineError(`Invalid turn snapshots for session "${session.id}"`);
  }
  const turns: Array<{ id: string; files: Record<string, TurnFileEntry> }> = [];
  const turnIds = new Set<string>();
  for (const rawTurn of rawTurns) {
    if (!isRecord(rawTurn) || typeof rawTurn['id'] !== 'string' || !isRecord(rawTurn['files'])) {
      throw new BaselineError(`Invalid turn snapshot in session "${session.id}"`);
    }
    requireTurnId(rawTurn['id']);
    if (turnIds.has(rawTurn['id'])) {
      throw new BaselineError(`Duplicate turn snapshot "${rawTurn['id']}" in session "${session.id}"`);
    }
    turnIds.add(rawTurn['id']);

    const files: Record<string, TurnFileEntry> = {};
    const fileKeys = new Set<string>();
    for (const [rawPath, rawEntry] of Object.entries(rawTurn['files'])) {
      if (
        !isRecord(rawEntry)
        || typeof rawEntry['beforeSnapshot'] !== 'string'
        || !SNAPSHOT_HASH.test(rawEntry['beforeSnapshot'])
        || typeof rawEntry['existedBefore'] !== 'boolean'
      ) {
        throw new BaselineError(`Invalid turn baseline entry "${rawPath}" in session "${session.id}"`);
      }
      const hasAfterSnapshot = rawEntry['afterSnapshot'] !== undefined;
      const hasExistedAfter = rawEntry['existedAfter'] !== undefined;
      if (
        hasAfterSnapshot !== hasExistedAfter
        || (hasAfterSnapshot
          && (typeof rawEntry['afterSnapshot'] !== 'string'
            || !SNAPSHOT_HASH.test(rawEntry['afterSnapshot'])
            || typeof rawEntry['existedAfter'] !== 'boolean'))
      ) {
        throw new BaselineError(`Invalid completed turn entry "${rawPath}" in session "${session.id}"`);
      }
      if (rawEntry['diverged'] !== undefined && typeof rawEntry['diverged'] !== 'boolean') {
        throw new BaselineError(`Invalid turn divergence for "${rawPath}" in session "${session.id}"`);
      }

      const relativePath = resolveSessionFile(session, rawPath).relativePath;
      const comparisonKey = pathComparisonKey(session, relativePath);
      if (relativePath !== rawPath || fileKeys.has(comparisonKey)) {
        throw new BaselineError(`Unsafe turn baseline path "${rawPath}" in session "${session.id}"`);
      }
      fileKeys.add(comparisonKey);
      files[relativePath] = {
        beforeSnapshot: rawEntry['beforeSnapshot'],
        existedBefore: rawEntry['existedBefore'],
        afterSnapshot: hasAfterSnapshot ? rawEntry['afterSnapshot'] as string : undefined,
        existedAfter: hasExistedAfter ? rawEntry['existedAfter'] as boolean : undefined,
        diverged: rawEntry['diverged'],
      };
    }
    turns.push({ id: rawTurn['id'], files });
  }

  return {
    version: MANIFEST_VERSION,
    sessionId: session.id,
    entries,
    acceptedLegacyPaths: uniquePaths(session, acceptedLegacyPaths),
    turns,
  };
}

function equivalentPath(
  session: BaselineSession,
  paths: Iterable<string>,
  candidate: string,
): string | undefined {
  const candidateKey = pathComparisonKey(session, candidate);
  for (const existing of paths) {
    if (pathComparisonKey(session, existing) === candidateKey) return existing;
  }
  return undefined;
}

function hasTurnFile(
  session: BaselineSession,
  manifest: BaselineManifestV2,
  relativePath: string,
): boolean {
  return manifest.turns.some((turn) =>
    equivalentPath(session, Object.keys(turn.files), relativePath) !== undefined);
}

function removeTurnFile(
  session: BaselineSession,
  manifest: MutableManifest,
  relativePath: string,
): void {
  for (const turn of manifest.turns) {
    const existing = equivalentPath(session, Object.keys(turn.files), relativePath);
    if (existing !== undefined) delete turn.files[existing];
  }
}

function clearTurnFiles(manifest: MutableManifest): void {
  for (const turn of manifest.turns) turn.files = {};
}

function matchesTurnOutput(current: string | undefined, entry: TurnFileEntry): boolean {
  if (entry.afterSnapshot === undefined || entry.existedAfter === undefined) return false;
  if (current === undefined) return !entry.existedAfter;
  return entry.existedAfter && hash(current) === entry.afterSnapshot;
}

function matchesBaseline(current: string | undefined, baseline: BaselineValue): boolean {
  if (current === undefined) return !baseline.existedBefore;
  return baseline.existedBefore && current === baseline.content;
}

function emptyUndoResult(status: UndoFileChangesResult['status']): UndoFileChangesResult {
  return { status, restored: [], removed: [], conflicted: [], failed: [] };
}

function uniquePaths(session: BaselineSession, paths: Iterable<string>): string[] {
  const unique = new Map<string, string>();
  for (const relativePath of paths) {
    const key = pathComparisonKey(session, relativePath);
    if (!unique.has(key)) unique.set(key, relativePath);
  }
  return [...unique.values()].toSorted();
}

function pathComparisonKey(session: BaselineSession, relativePath: string): string {
  return isWindowsAbsolute(session.workDir) ? relativePath.toLowerCase() : relativePath;
}

export function resolveSessionFile(session: BaselineSession, filePath: string): ResolvedFile {
  requireSession(session);
  if (filePath.length === 0) throw new BaselineError('The baseline file path is empty');

  const windows = isWindowsAbsolute(session.workDir);
  if (!windows && isWindowsAbsolute(filePath)) {
    throw new BaselineError(`File "${filePath}" is outside workspace "${session.workDir}"`);
  }

  const paths = windows ? path.win32 : path;
  const root = paths.resolve(session.workDir);
  const absolutePath = paths.resolve(root, filePath);
  const relativePath = paths.relative(root, absolutePath);
  const parentPrefix = `..${paths.sep}`;
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(parentPrefix) ||
    paths.isAbsolute(relativePath)
  ) {
    throw new BaselineError(`File "${filePath}" is outside workspace "${session.workDir}"`);
  }

  return {
    absolutePath,
    relativePath: windows ? relativePath.replaceAll('\\', '/') : relativePath,
  };
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function legacyBaselineRoot(session: BaselineSession): string | undefined {
  const source = session.metadata?.['kimi_cli_source_path'];
  if (typeof source !== 'string' || source.length === 0) return undefined;

  const sourceIsWindows = isWindowsAbsolute(source);
  if (sourceIsWindows !== (process.platform === 'win32')) return undefined;
  if (!path.isAbsolute(source)) return undefined;
  return path.join(source, 'baseline');
}

function legacyBaselinePath(
  session: BaselineSession,
  relativePath: string,
): string | undefined {
  const root = legacyBaselineRoot(session);
  if (root === undefined) return undefined;
  const resolved = resolveSessionFile(session, relativePath);
  return path.join(root, ...resolved.relativePath.split('/'));
}

async function walkLegacyBaselines(
  directory: string,
  relativeDirectory: string,
  result: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') && relativeDirectory.length === 0) return;
    throw new BaselineError(`Unable to list legacy baseline directory "${directory}"`, {
      cause: error,
    });
  }

  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      await walkLegacyBaselines(path.join(directory, entry.name), relativePath, result);
    } else if (entry.isFile()) {
      result.push(relativePath);
    }
  }
}

function captureOriginal(absolutePath: string): BaselineValue {
  let info;
  try {
    info = statSync(absolutePath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { content: '', existedBefore: false };
    throw new BaselineError(`Unable to inspect original file "${absolutePath}"`, {
      cause: error,
    });
  }
  if (!info.isFile()) {
    throw new BaselineError(`Original path "${absolutePath}" is not a regular file`);
  }

  try {
    return { content: readFileSync(absolutePath, 'utf-8'), existedBefore: true };
  } catch (error) {
    throw new BaselineError(`Unable to capture original file "${absolutePath}"`, {
      cause: error,
    });
  }
}

async function readCurrentFile(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, 'utf-8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined;
    throw new BaselineError(`Unable to read current file "${absolutePath}"`, { cause: error });
  }
}

async function restoreFile(
  workDir: string,
  absolutePath: string,
  baseline: BaselineValue,
): Promise<void> {
  await requireContainedRestorePath(workDir, absolutePath);
  if (!baseline.existedBefore) {
    try {
      await unlink(absolutePath);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        throw new BaselineError(`Unable to remove newly created file "${absolutePath}"`, {
          cause: error,
        });
      }
    }
    return;
  }

  try {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, baseline.content, 'utf-8');
  } catch (error) {
    throw new BaselineError(`Unable to restore file "${absolutePath}"`, { cause: error });
  }
}

async function requireContainedRestorePath(workDir: string, absolutePath: string): Promise<void> {
  try {
    const [realWorkDir, realTarget] = await Promise.all([
      realpath(workDir),
      realExistingPath(absolutePath),
    ]);
    if (relativeFsPath(realWorkDir, realTarget) === undefined) {
      throw new BaselineError(`Refusing to restore path outside the session workspace: "${absolutePath}"`);
    }
  } catch (error) {
    if (error instanceof BaselineError) throw error;
    throw new BaselineError(`Unable to validate restore path "${absolutePath}"`, { cause: error });
  }
}

async function realExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      let isDanglingSymlink = false;
      try {
        isDanglingSymlink = (await lstat(current)).isSymbolicLink();
      } catch (lstatError) {
        if (!isErrorCode(lstatError, 'ENOENT')) throw lstatError;
      }
      if (isDanglingSymlink) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf-8', mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new BaselineError(`Unable to atomically write "${targetPath}"`, { cause: error });
  }
}

function requireSession(session: BaselineSession): void {
  requireSessionId(session.id);
  if (session.workDir.length === 0) throw new BaselineError('The session workspace path is empty');
}

function requireSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new BaselineError('The baseline session id is empty');
}

function requireTurnId(turnId: string): void {
  if (turnId.length === 0) throw new BaselineError('The baseline turn id is empty');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replaceAll('\r\n', '\n').split('\n').length;
}

function computeLineDiff(
  oldContent: string,
  newContent: string,
): { additions: number; deletions: number } {
  const lines = (content: string): string[] =>
    content.length === 0 ? [] : content.replaceAll('\r\n', '\n').split('\n');
  const oldLines = lines(oldContent);
  const newLines = lines(newContent);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    additions: newLines.filter((line) => !oldSet.has(line)).length,
    deletions: oldLines.filter((line) => !newSet.has(line)).length,
  };
}
