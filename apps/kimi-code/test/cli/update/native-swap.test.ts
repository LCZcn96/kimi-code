import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readUpdateInstallState } from '#/cli/update/install-state';
import { readStagedNativeUpdate, stagedExeFileName } from '#/cli/update/native-stage';
import {
  maybeRelaunchWithStagedNativeUpdate,
  type NativeSwapDeps,
} from '#/cli/update/native-swap';
import { KIMI_CODE_UPDATE_REEXEC_ENV } from '#/constant/app';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';

const fsMocks = vi.hoisted(() => ({
  /** When set, renames matching the predicate fail with an injected error. */
  renameBlocker: null as null | ((src: string, dst: string) => boolean),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (
      src: Parameters<typeof actual.rename>[0],
      dst: Parameters<typeof actual.rename>[1],
    ) => {
      if (fsMocks.renameBlocker?.(String(src), String(dst)) === true) {
        throw new Error('injected rename failure');
      }
      return actual.rename(src, dst);
    },
  };
});

const CURRENT_VERSION = '0.6.0';
const STAGED_VERSION = '0.7.0';
const STAGED_EXE_SIZE = 42;

interface FakeChildHandlers {
  readonly onEvent: (event: 'error' | 'exit' | 'close', cb: (...args: unknown[]) => void) => void;
  readonly child: unknown;
}

function fakeChild(options: {
  readonly code?: number | null;
  readonly stdout?: string;
  readonly error?: Error;
  readonly signal?: NodeJS.Signals | null;
}): FakeChildHandlers {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const stdoutChunks: string[] = [];
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const child = {
    once(event: string, cb: (...args: unknown[]) => void) {
      listeners.set(event, cb);
    },
    stdout: {
      on(_event: 'data', cb: (chunk: Buffer) => void) {
        stdoutListeners.push(cb);
      },
    },
    kill: vi.fn(),
  };
  queueMicrotask(() => {
    if (options.error !== undefined) {
      listeners.get('error')?.(options.error);
      return;
    }
    if (options.stdout !== undefined) {
      for (const cb of stdoutListeners) cb(Buffer.from(options.stdout));
    }
    const code = options.code === undefined ? 0 : options.code;
    const signal = options.signal ?? null;
    // The smoke check listens on 'close', the re-exec waiter on 'exit'.
    listeners.get('close')?.(code, signal);
    listeners.get('exit')?.(code, signal);
  });
  void stdoutChunks;
  return { onEvent: () => {}, child };
}

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

function createSpawnMock(routes: {
  readonly smokeCode?: number;
  readonly smokeStdout?: string;
  readonly reexecCode?: number;
  readonly reexecError?: Error;
  readonly reexecSignal?: NodeJS.Signals;
}): { readonly calls: SpawnCall[]; readonly spawnImpl: NativeSwapDeps['spawnImpl'] } {
  const calls: SpawnCall[] = [];
  const spawnImpl = ((cmd: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    if (args[0] === '--version') {
      return fakeChild({
        code: routes.smokeCode ?? 0,
        stdout: routes.smokeStdout ?? `${STAGED_VERSION}\n`,
      }).child;
    }
    return fakeChild({
      code: routes.reexecSignal !== undefined ? null : (routes.reexecCode ?? 0),
      error: routes.reexecError,
      signal: routes.reexecSignal ?? null,
    }).child;
  }) as unknown as NativeSwapDeps['spawnImpl'];
  return { calls, spawnImpl };
}

async function seedStagedUpdate(exePath: string, version: string): Promise<void> {
  const stagingDir = getNativeStagingDir(exePath);
  await mkdir(stagingDir, { recursive: true });
  await writeFile(
    join(stagingDir, stagedExeFileName(version, 'linux')),
    Buffer.alloc(STAGED_EXE_SIZE, 1),
  );
  await writeFile(
    getNativeStagedStateFile(exePath),
    `${JSON.stringify({
      version,
      target: 'linux-x64',
      exeFileName: stagedExeFileName(version, 'linux'),
      sha256: 'a'.repeat(64),
      exeSize: STAGED_EXE_SIZE,
      stagedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf-8',
  );
}

function makeDeps(
  exePath: string,
  overrides: Partial<NativeSwapDeps> & { readonly spawnImpl: NativeSwapDeps['spawnImpl'] },
): NativeSwapDeps {
  return {
    exePath,
    argv: ['node', exePath, '--flag', 'value'],
    env: { PATH: '/usr/bin' },
    currentVersion: CURRENT_VERSION,
    isNative: true,
    exitImpl: vi.fn(),
    ...overrides,
  };
}

describe('maybeRelaunchWithStagedNativeUpdate', () => {
  let workDir: string;
  let exePath: string;
  let homeDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-swap-test-'));
    homeDir = join(workDir, 'home');
    exePath = join(workDir, 'bin', 'kimi');
    await mkdir(join(workDir, 'bin'), { recursive: true });
    await writeFile(exePath, 'old-binary');
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
    fsMocks.renameBlocker = null;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workDir, { recursive: true, force: true });
  });

  it('does nothing when the re-exec guard env is set', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const env = { [KIMI_CODE_UPDATE_REEXEC_ENV]: '1' };
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, env }),
    );
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // Read-once: the guard is dropped so children of this session do not inherit it.
    expect(env[KIMI_CODE_UPDATE_REEXEC_ENV]).toBeUndefined();
    // Staged files untouched for the "real" next launch.
    await expect(stat(getNativeStagedStateFile(exePath))).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('does nothing when not running as a native binary', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, isNative: false }),
    );
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('does nothing when nothing is staged', async () => {
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('discards a staged update that is not newer than the running version', async () => {
    await seedStagedUpdate(exePath, CURRENT_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
    // Staged artifacts are gone, so future launches do not retry the discard.
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });

  it('discards staged metadata whose exe is missing', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    await rm(join(getNativeStagingDir(exePath), stagedExeFileName(STAGED_VERSION, 'linux')));
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('swaps in the staged exe, re-execs with the original argv and forwards the exit code', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({ reexecCode: 3 });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );

    expect(relaunched).toBe(true);
    // Smoke check + re-exec.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(['--version']);
    expect(calls[1]?.cmd).toBe(exePath);
    expect(calls[1]?.args).toEqual(['--flag', 'value']);
    expect((calls[1]?.options['env'] as Record<string, string>)[KIMI_CODE_UPDATE_REEXEC_ENV]).toBe('1');
    expect(calls[1]?.options['stdio']).toBe('inherit');
    expect(exitImpl).toHaveBeenCalledWith(3);

    // The exe was replaced with the staged payload; backup and staging are gone.
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
    await expect(stat(`${exePath}.bak`)).rejects.toThrow();
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });

  it('rolls back when the smoke check fails and records an install failure', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({ smokeCode: 1 });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );

    expect(relaunched).toBe(false);
    expect(exitImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // smoke only, no re-exec
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();

    const state = await readUpdateInstallState();
    expect(state.lastFailure).toMatchObject({ version: STAGED_VERSION, attempts: 1 });
  });

  it('rolls back when the smoke output does not contain the staged version', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { spawnImpl } = createSpawnMock({ smokeStdout: '0.0.0-bogus\n' });
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('continues startup with the old in-memory code when the re-exec spawn fails', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { spawnImpl } = createSpawnMock({ reexecError: new Error('spawn EACCES') });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );
    expect(relaunched).toBe(false);
    expect(exitImpl).not.toHaveBeenCalled();
    // The binary on disk is already the new version; the next launch picks it up.
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });

  it('forwards a signal-derived nonzero exit code when the re-exec child is killed', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { spawnImpl } = createSpawnMock({ reexecSignal: 'SIGKILL' });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );
    expect(relaunched).toBe(true);
    // 128 + 9 (SIGKILL), never a success-looking 0.
    expect(exitImpl).toHaveBeenCalledWith(137);
  });

  it('restores the staged metadata when the exe cannot be moved aside', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // rename(exe → bak) fails when the in-service exe is gone.
    await rm(exePath);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    // The smoke check runs before anything is moved; only the re-exec is absent.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['--version']);
    // The staged update is restored, not dropped: a later launch retries the swap.
    const restored = await readStagedNativeUpdate(exePath);
    expect(restored).toMatchObject({ version: STAGED_VERSION });
    await expect(
      stat(join(getNativeStagingDir(exePath), stagedExeFileName(STAGED_VERSION, 'linux'))),
    ).resolves.toBeDefined();
  });

  it('falls back to a pid-named backup when the plain .bak cannot be removed', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // A directory at `${exePath}.bak` cannot be removed via unlink → pid fallback.
    await mkdir(`${exePath}.bak`);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(true);
    expect(calls).toHaveLength(2);
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
    // The pid-named backup was cleaned after the swap; the directory is untouched.
    const names = await readdir(join(workDir, 'bin'));
    expect(names.toSorted()).toEqual(['kimi', 'kimi.bak']);
    expect((await stat(`${exePath}.bak`)).isDirectory()).toBe(true);
  });

  it('sweeps stale backups from earlier swaps on startup', async () => {
    await writeFile(`${exePath}.bak`, 'stale-backup');
    await writeFile(`${exePath}.12345.bak`, 'stale-backup');
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
    await expect(stat(`${exePath}.bak`)).rejects.toThrow();
    await expect(stat(`${exePath}.12345.bak`)).rejects.toThrow();
  });

  it('leaves every artifact alone while another instance holds a fresh swap claim', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const claimPath = join(stagingDir, 'staged.json.swap-4242');
    await writeFile(claimPath, '{}\n', 'utf-8');
    await writeFile(`${exePath}.bak`, 'in-use-backup');
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // A mid-swap instance owns these: nothing is touched.
    await expect(stat(claimPath)).resolves.toBeDefined();
    await expect(stat(`${exePath}.bak`)).resolves.toBeDefined();
  });

  it('does not claim a newly staged update while another instance is mid-swap', async () => {
    // Instance A holds a fresh claim; a downloader has since published a new
    // staged.json. Claiming it here would start a second concurrent swap.
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const claimPath = join(stagingDir, 'staged.json.swap-4242');
    await writeFile(claimPath, '{}\n', 'utf-8');
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // The staged update and the claim stay put; the launch after the
    // in-flight swap ends picks the update up.
    await expect(stat(getNativeStagedStateFile(exePath))).resolves.toBeDefined();
    await expect(stat(claimPath)).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('cleans up stale swap claims and their orphaned staged exe', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const exeFileName = stagedExeFileName(STAGED_VERSION, 'linux');
    const orphanedExe = join(stagingDir, exeFileName);
    await writeFile(orphanedExe, Buffer.alloc(STAGED_EXE_SIZE, 1));
    const claimPath = join(stagingDir, 'staged.json.swap-4242');
    await writeFile(
      claimPath,
      `${JSON.stringify({
        version: STAGED_VERSION,
        target: 'linux-x64',
        exeFileName,
        sha256: 'a'.repeat(64),
        exeSize: STAGED_EXE_SIZE,
        stagedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      }, null, 2)}\n`,
      'utf-8',
    );
    // Crash residue: the claim is older than the stale window.
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(claimPath, past, past);

    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(stat(claimPath)).rejects.toThrow();
    await expect(stat(orphanedExe)).rejects.toThrow();
  });

  it('keeps recovery artifacts when both the swap-in rename and the rollback fail', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // Every rename INTO the install path fails: the staged exe cannot move
    // in, and the backup cannot move back (transient lock, AV, …).
    fsMocks.renameBlocker = (_src, dst) => dst === exePath;
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(1); // smoke check only, no re-exec
    // The install path stays absent, but both recovery copies survive: the
    // `.bak` IS the old exe, and the staged payload plus its claim are not
    // discarded.
    await expect(stat(exePath)).rejects.toThrow();
    expect(await readFile(`${exePath}.bak`, 'utf-8')).toBe('old-binary');
    const stagingDir = getNativeStagingDir(exePath);
    await expect(
      stat(join(stagingDir, stagedExeFileName(STAGED_VERSION, 'linux'))),
    ).resolves.toBeDefined();
    await expect(
      stat(join(stagingDir, `staged.json.swap-${process.pid}`)),
    ).resolves.toBeDefined();
  });

  it('stamps the claim with a fresh mtime so a concurrent launch does not misread it as stale', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // The metadata may have been staged long before this launch (background
    // download finished hours ago); rename alone would keep that old mtime.
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(getNativeStagedStateFile(exePath), longAgo, longAgo);

    // Instance A: park inside the smoke check, holding the claim mid-swap.
    let releaseSmoke!: () => void;
    const smokeGate = new Promise<void>((resolve) => {
      releaseSmoke = resolve;
    });
    const spawnImplA = ((cmd: string, args: readonly string[]) => {
      if (args[0] !== '--version') return fakeChild({ code: 0 }).child; // re-exec
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const stdoutListeners: Array<(chunk: Buffer) => void> = [];
      const child = {
        once(event: string, cb: (...args: unknown[]) => void) {
          listeners.set(event, cb);
        },
        stdout: {
          on(_event: 'data', cb: (chunk: Buffer) => void) {
            stdoutListeners.push(cb);
          },
        },
        kill: vi.fn(),
      };
      const emitSmokeSuccess = (): void => {
        for (const cb of stdoutListeners) cb(Buffer.from(`${STAGED_VERSION}\n`));
        listeners.get('close')?.(0, null);
        listeners.get('exit')?.(0, null);
      };
      queueMicrotask(() => {
        void smokeGate.then(emitSmokeSuccess);
      });
      return child;
    }) as unknown as NativeSwapDeps['spawnImpl'];
    const promiseA = maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl: spawnImplA }));

    // Wait until A holds the claim.
    const stagingDir = getNativeStagingDir(exePath);
    const claimPath = join(stagingDir, `staged.json.swap-${process.pid}`);
    await vi.waitFor(() => {
      expect(existsSync(claimPath)).toBe(true);
    });
    // The claim carries the claim time, not the staged file's old mtime.
    expect((await stat(claimPath)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);

    // Instance B: its sweep must treat A's claim as live and touch nothing.
    const { calls: callsB, spawnImpl: spawnImplB } = createSpawnMock({});
    const relaunchedB = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl: spawnImplB }),
    );
    expect(relaunchedB).toBe(false);
    expect(callsB).toHaveLength(0);
    await expect(stat(claimPath)).resolves.toBeDefined();
    await expect(
      stat(join(stagingDir, stagedExeFileName(STAGED_VERSION, 'linux'))),
    ).resolves.toBeDefined();

    // A finishes the swap unharmed.
    releaseSmoke();
    await expect(promiseA).resolves.toBe(true);
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });
});
