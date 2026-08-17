/**
 * Native staged swap, executed at the very top of startup.
 *
 * When a staged update is ready (`.staging/staged.json` next to the running
 * exe), swap it in atomically and re-exec so the user session runs the new
 * binary immediately. Everything here is best-effort: any failure leaves the
 * current exe intact (rollback from `.bak`) and startup continues normally.
 *
 * Windows semantics make this safe: a running exe can be renamed but not
 * overwritten, so the sequence is `rename exe→.bak` (the running process is
 * unaffected), `rename staged→exe`, then delete `.bak` (best effort — a
 * concurrent old instance keeps it locked until it exits). This is the same
 * mechanism install.ps1 already relies on, and the Squirrel/NSIS-style
 * "next launch performs the swap" pattern.
 */

import { spawn } from 'node:child_process';
import { readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { gt } from 'semver';

import { log } from '@moonshot-ai/kimi-code-sdk';

import { KIMI_CODE_UPDATE_REEXEC_ENV } from '#/constant/app';

import { readUpdateInstallState, writeUpdateInstallState } from './install-state';
import {
  readStagedNativeUpdate,
  removeStagedNativeUpdate,
  stagedExePath,
  type StagedNativeUpdate,
} from './native-stage';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';

export interface NativeSwapDeps {
  readonly exePath: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly currentVersion: string;
  readonly isNative: boolean;
  readonly spawnImpl?: typeof spawn;
  readonly exitImpl?: (code: number) => void;
}

export interface SpawnedChild {
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function logSwap(message: string, payload: Record<string, unknown>): void {
  try {
    log.info(`native update swap: ${message}`, payload);
  } catch {
    // Diagnostics must never affect startup.
  }
}

/** Record a swap failure so preflight stops re-staging the same bad version. */
async function recordSwapFailure(version: string): Promise<void> {
  try {
    const state = await readUpdateInstallState();
    const attempts =
      (state.lastFailure?.version === version ? state.lastFailure.attempts : 0) + 1;
    await writeUpdateInstallState({
      ...state,
      active: null,
      lastFailure: { version, failedAt: new Date().toISOString(), attempts },
    });
  } catch {
    // Never block startup on bookkeeping.
  }
}

/**
 * Run `exe --version` as a smoke check: exit code 0 and the staged version in
 * the output. A swapped binary that cannot even print its version must not
 * replace the known-good exe.
 */
function smokeCheck(
  exePath: string,
  staged: StagedNativeUpdate,
  spawnImpl: typeof spawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child: SpawnedChild & { readonly stdout?: NodeJS.ReadableStream | null; kill(): void };
    try {
      child = spawnImpl(exePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }) as unknown as typeof child;
    } catch {
      finish(false);
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(false);
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.once('error', () => {
      clearTimeout(timeout);
      finish(false);
    });
    // 'close', not 'exit': stdio may still be flushing when 'exit' fires, and
    // the check needs the complete version output.
    child.once('close', (code) => {
      clearTimeout(timeout);
      finish(code === 0 && stdout.includes(staged.version));
    });
  });
}

interface ClaimedStaged {
  readonly staged: StagedNativeUpdate;
  readonly claimedPath: string;
}

/**
 * Atomically claim the staged metadata file (rename is atomic on both NTFS
 * and POSIX, so exactly one of several concurrently starting instances wins).
 * Returns null when there is nothing staged, the file disappeared under us,
 * or the staged exe failed consistency checks.
 */
async function claimStagedUpdate(exePath: string): Promise<ClaimedStaged | null> {
  const stateFile = getNativeStagedStateFile(exePath);
  const staged = await readStagedNativeUpdate(exePath, stateFile);
  if (staged === null) return null;

  const claimedPath = `${stateFile}.swap-${process.pid}`;
  try {
    await rename(stateFile, claimedPath);
  } catch {
    return null;
  }
  return { staged, claimedPath };
}

async function rollback(bakPath: string, exePath: string): Promise<void> {
  await rename(bakPath, exePath).catch(() => {});
}

/**
 * Remove leftover `.bak` siblings of the exe from earlier swaps/installs.
 * A `.bak` still mapped by a running old instance cannot be deleted on
 * Windows — it is simply left for a later launch.
 */
async function cleanupBackups(exePath: string, keepPath: string): Promise<void> {
  const dir = dirname(exePath);
  const base = basename(exePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.`) || !entry.endsWith('.bak')) continue;
    const full = join(dir, entry);
    if (full === keepPath) continue;
    await unlink(full).catch(() => {});
  }
}

/**
 * Re-exec the (newly swapped) exe with the original argv, forwarding its exit
 * code so the swap is invisible to the caller. Returns false when the spawn
 * itself failed — the caller then continues startup with the old in-memory
 * code; the binary on disk is already the new version.
 */
function reexec(
  deps: NativeSwapDeps & { readonly spawnImpl: typeof spawn },
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: SpawnedChild;
    try {
      child = deps.spawnImpl(deps.exePath, deps.argv.slice(2), {
        stdio: 'inherit',
        env: { ...deps.env, [KIMI_CODE_UPDATE_REEXEC_ENV]: '1' },
      }) as unknown as SpawnedChild;
    } catch (error) {
      logSwap('re-exec spawn threw', { error: String(error) });
      resolve(false);
      return;
    }
    child.once('error', (error) => {
      logSwap('re-exec spawn failed', { error: error.message });
      resolve(false);
    });
    child.once('exit', (code, _signal) => {
      resolve(true);
      const exitImpl = deps.exitImpl ?? ((exitCode: number) => process.exit(exitCode));
      exitImpl(code ?? 0);
    });
  });
}

/**
 * Swap in a staged native update and re-exec when one is ready.
 *
 * Returns true only when the process was re-launched (the caller must not
 * continue startup — the exit handler fires once the child exits). Every
 * other outcome returns false so startup proceeds untouched.
 */
export async function maybeRelaunchWithStagedNativeUpdate(
  deps: NativeSwapDeps,
): Promise<boolean> {
  if (isTruthy(deps.env[KIMI_CODE_UPDATE_REEXEC_ENV])) return false;
  if (!deps.isNative) return false;

  const claimed = await claimStagedUpdate(deps.exePath);
  if (claimed === null) return false;
  const { staged, claimedPath } = claimed;
  const spawnImpl = deps.spawnImpl ?? spawn;

  const discard = async (): Promise<boolean> => {
    // claimedPath lives inside `.staging/` — remove it first so the
    // best-effort rmdir in removeStagedNativeUpdate can actually succeed.
    // The staged metadata must be passed along: claiming already renamed the
    // state file away, so rediscovery would find nothing and leak the exe.
    await unlink(claimedPath).catch(() => {});
    await removeStagedNativeUpdate(deps.exePath, staged);
    return false;
  };

  // Downgrade guard: the staged version must be newer than what is running.
  // (The user may have installed a newer build manually after we staged.)
  if (!gt(staged.version, deps.currentVersion)) {
    logSwap('discarding staged update (not newer)', {
      staged: staged.version,
      current: deps.currentVersion,
    });
    return discard();
  }

  const stagedExe = stagedExePath(deps.exePath, staged);

  // 1. Smoke-check the staged exe BEFORE touching the install path: a staged
  //    binary that cannot start (or lies about its version) is discarded with
  //    the running exe never moved — the safest possible failure shape.
  if (!(await smokeCheck(stagedExe, staged, spawnImpl))) {
    logSwap('smoke check failed, discarding staged update', { version: staged.version });
    await recordSwapFailure(staged.version);
    return discard();
  }

  // 2. Pick a backup slot and move the running exe aside (rename of a running
  //    exe is legal on Windows and POSIX alike; overwriting is not).
  //
  //    Crash window: if the process dies between this rename and step 3, the
  //    install path is left empty and no CLI code can run to self-heal. Each
  //    rename is atomic, the window is two adjacent syscalls, and recovery is
  //    `mv <exe>.bak <exe>` or re-running the install script.
  let bakPath = `${deps.exePath}.bak`;
  const oldBakCleared = await unlink(bakPath)
    .then(() => true)
    .catch(() => false);
  if (!oldBakCleared) {
    // The leftover `.bak` is locked by a still-running old instance (or
    // undeletable for another reason) — take a unique backup name, the same
    // fallback install.ps1 uses. It is best-effort cleaned up on later runs.
    bakPath = `${deps.exePath}.${process.pid}.bak`;
  }
  try {
    await rename(deps.exePath, bakPath);
  } catch (error) {
    // Nothing was moved: startup continues with the old exe. Keep the staged
    // files so a later launch can retry (transient locks clear on reboot).
    logSwap('failed to move exe aside', { exePath: deps.exePath, error: String(error) });
    await unlink(claimedPath).catch(() => {});
    return false;
  }

  // 3. Move the staged exe into place; roll back on failure.
  if ((await rename(stagedExe, deps.exePath).catch(() => null)) === null) {
    logSwap('failed to move staged exe into place, rolling back', { exePath: deps.exePath });
    await rollback(bakPath, deps.exePath);
    await recordSwapFailure(staged.version);
    return discard();
  }

  // 4. Success: clean up and re-exec into the new binary.
  await unlink(claimedPath).catch(() => {});
  await unlink(bakPath).catch(() => {});
  await cleanupBackups(deps.exePath, bakPath);
  await rmdir(getNativeStagingDir(deps.exePath)).catch(() => {});
  logSwap('swap succeeded, re-launching', { version: staged.version });
  return reexec({ ...deps, spawnImpl });
}
