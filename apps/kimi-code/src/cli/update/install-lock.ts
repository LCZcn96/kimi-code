import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getUpdateInstallLockFile } from '#/utils/paths';

const UPDATE_INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;

export interface UpdateInstallLockRequest {
  readonly version: string;
  readonly now?: Date;
}

export interface UpdateInstallLockHandle {
  readonly filePath: string;
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

async function isStaleLock(filePath: string, now: Date): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return true;
    const lock = parsed as { readonly startedAt?: unknown; readonly pid?: unknown };
    if (typeof lock.startedAt !== 'string') return true;
    const startedAt = Date.parse(lock.startedAt);
    if (!Number.isFinite(startedAt)) return true;
    if (now.getTime() - startedAt <= UPDATE_INSTALL_LOCK_STALE_MS) return false;
    // Past the age threshold the holder's liveness decides. A native download
    // is idle-bounded but intentionally not duration-bounded, so a slow link
    // legitimately exceeds it; sweeping that lock would let a second
    // downloader write the same `.staging` paths concurrently. (A pid reused
    // by an unrelated process can pin the lock until that process exits — a
    // delayed update, never a corrupt one.)
    return typeof lock.pid === 'number' ? !isProcessAlive(lock.pid) : true;
  } catch (error) {
    if (isNotFound(error)) return true;
    if (error instanceof SyntaxError) return true;
    return false;
  }
}

async function createLockFile(
  filePath: string,
  request: UpdateInstallLockRequest,
): Promise<UpdateInstallLockHandle> {
  const now = request.now ?? new Date();
  const file = await open(filePath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify({
      version: request.version,
      pid: process.pid,
      startedAt: now.toISOString(),
    }, null, 2)}\n`, 'utf-8');
  } finally {
    await file.close();
  }

  return {
    filePath,
    release: async (): Promise<void> => {
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

  if (!(await isStaleLock(filePath, request.now ?? new Date()))) return null;
  await unlink(filePath).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });

  try {
    return await createLockFile(filePath, request);
  } catch (error) {
    if (isAlreadyExists(error)) return null;
    throw error;
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
