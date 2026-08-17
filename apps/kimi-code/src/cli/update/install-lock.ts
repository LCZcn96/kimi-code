import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getUpdateInstallLockFile } from '#/utils/paths';

const UPDATE_INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * A takeover's critical section is a few syscalls (microseconds), so a
 * takeover lock older than this is crash residue and may be swept freely.
 */
const TAKEOVER_LOCK_STALE_MS = 60_000;

/** Uniquifies the publish-temp path across concurrent in-process acquirers. */
let lockTempCounter = 0;

export interface UpdateInstallLockRequest {
  readonly version: string;
  readonly now?: Date;
}

export interface UpdateInstallLockHandle {
  readonly filePath: string;
  /** The exact contents this handle published — its ownership identity. */
  readonly content: string;
  release(): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST'
  );
}

/**
 * Liveness probe for the lock holder. Signal 0 delivers nothing; ESRCH means
 * the process is gone, EPERM means it exists but may not be signalled — which
 * still counts as alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Staleness check over the lock file's CONTENTS. Unparseable or shapeless
 * content counts as stale (crash residue). Past the age threshold the
 * holder's liveness decides: a native download is idle-bounded but
 * intentionally not duration-bounded, so a slow link legitimately exceeds it;
 * sweeping that lock would let a second downloader write the same `.staging`
 * paths concurrently. (A pid reused by an unrelated process can pin the lock
 * until that process exits — a delayed update, never a corrupt one.)
 */
function isStaleLockContent(raw: string, now: Date): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null) return true;
  const lock = parsed as { readonly startedAt?: unknown; readonly pid?: unknown };
  if (typeof lock.startedAt !== 'string') return true;
  const startedAt = Date.parse(lock.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  if (now.getTime() - startedAt <= UPDATE_INSTALL_LOCK_STALE_MS) return false;
  return typeof lock.pid === 'number' ? !isProcessAlive(lock.pid) : true;
}

async function createLockFile(
  filePath: string,
  request: UpdateInstallLockRequest,
): Promise<UpdateInstallLockHandle> {
  const now = request.now ?? new Date();
  const content = `${JSON.stringify({
    version: request.version,
    pid: process.pid,
    startedAt: now.toISOString(),
  }, null, 2)}\n`;
  // Publish atomically: hard-link a fully-written temp file into place (link
  // fails when the destination already exists, same exclusivity as 'wx'). A
  // plain 'wx' open would expose a momentarily EMPTY lock file, and a
  // concurrent acquirer could misread it as corrupt, sweep it, and also win —
  // two "holders" then write the same `.staging` paths.
  const tempPath = `${filePath}.${process.pid}.${lockTempCounter}.tmp`;
  lockTempCounter += 1;
  await writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    await link(tempPath, filePath);
  } finally {
    await unlink(tempPath).catch(() => {});
  }

  return {
    filePath,
    content,
    release: async (): Promise<void> => {
      // Release only the lock instance we own: a stale takeover may have
      // replaced the file since we published it.
      const current = await readFile(filePath, 'utf-8').catch(() => null);
      if (current !== content) return;
      await unlink(filePath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },
  };
}

export async function tryAcquireUpdateInstallLock(
  request: UpdateInstallLockRequest,
  filePath: string = getUpdateInstallLockFile(),
): Promise<UpdateInstallLockHandle | null> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    return await createLockFile(filePath, request);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  // A lock file exists. Inspect it once to decide whether it is stale.
  const inspected = await readFile(filePath, 'utf-8').catch(() => null);
  if (inspected !== null && !isStaleLockContent(inspected, request.now ?? new Date())) {
    return null;
  }
  if (inspected === null) {
    // Vanished between create and read — retry the create once.
    try {
      return await createLockFile(filePath, request);
    } catch (error) {
      if (isAlreadyExists(error)) return null;
      throw error;
    }
  }

  // Stale lock. A pathname-level delete can never be conditioned on the file
  // still being the inspected instance, so delete+publish MUST NOT run
  // concurrently: serialize takeovers through a secondary create-if-absent
  // lock and re-validate staleness inside that section.
  const takeoverPath = `${filePath}.takeover`;
  if (!(await acquireTakeoverLock(takeoverPath))) return null;
  try {
    const current = await readFile(filePath, 'utf-8').catch(() => null);
    if (current !== null && !isStaleLockContent(current, request.now ?? new Date())) {
      // A fresh lock appeared while we waited for the takeover section.
      return null;
    }
    if (current !== null) {
      await unlink(filePath).catch(() => {});
    }
    try {
      // A fast-path creator may still win the briefly-free path — its lock is
      // legitimate (the path really was free), we simply lose.
      return await createLockFile(filePath, request);
    } catch (error) {
      if (isAlreadyExists(error)) return null;
      throw error;
    }
  } finally {
    await unlink(takeoverPath).catch(() => {});
  }
}

/**
 * The takeover lock serializes stale-lock recovery. create-if-absent via hard
 * link; an ancient holder is crash residue (a live section lasts microseconds)
 * and is swept, then retried once.
 */
async function acquireTakeoverLock(takeoverPath: string): Promise<boolean> {
  if (await linkLockFile(takeoverPath)) return true;
  const info = await stat(takeoverPath).catch(() => null);
  if (info !== null && Date.now() - info.mtimeMs <= TAKEOVER_LOCK_STALE_MS) return false;
  await unlink(takeoverPath).catch(() => {});
  return linkLockFile(takeoverPath);
}

/** Create-if-absent publish of a small lock marker file. */
async function linkLockFile(target: string): Promise<boolean> {
  const tempPath = `${target}.${process.pid}.${lockTempCounter}.tmp`;
  lockTempCounter += 1;
  await writeFile(tempPath, String(process.pid), { encoding: 'utf-8', mode: 0o600 });
  try {
    await link(tempPath, target);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Return the version recorded in the held lock file, or undefined when the
 * lock is gone or unreadable. Lets a downloader that failed to acquire the
 * lock distinguish "another instance is staging the SAME version" (its
 * outcome is ours — report success) from "a different version is in flight"
 * (must not be reported as success to a foreground `kimi upgrade`).
 */
export async function readUpdateInstallLockVersion(
  filePath: string = getUpdateInstallLockFile(),
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}
