/**
 * Native staged update: download + verify into `<exe dir>/.staging/`,
 * without touching the running executable. The actual swap happens on the
 * next startup (see `native-swap.ts`).
 *
 * The CDN serves the bare platform binary (e.g. `kimi-code-win32-x64.exe`),
 * whose sha256 comes from the per-release manifest over HTTPS — a staged
 * binary is byte-exact what the release pipeline produced.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { valid } from 'semver';
import { z } from 'zod';

import { KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME } from '#/constant/app';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';
import { writeJsonFile } from '#/utils/persistence';

import {
  fetchNativeReleaseManifest,
  nativeBinaryUrl,
  selectPlatformEntry,
} from './native-manifest';

const StagedNativeUpdateSchema = z
  .object({
    version: z.string().min(1),
    target: z.string().min(1),
    /** Base name of the staged executable inside `.staging/`. */
    exeFileName: z
      .string()
      .min(1)
      .refine((value) => basename(value) === value, { error: 'must be a plain file name' }),
    /** sha256 of the staged binary (the manifest's checksum). */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    exeSize: z.number().int().min(1),
    stagedAt: z.string().min(1),
    /**
     * True when the stage was produced by an explicit user-initiated
     * `kimi upgrade` (vs the passive background downloader): manual stages
     * still apply when automatic updates are opted out via env.
     */
    manual: z.boolean().optional(),
  })
  .strict();

export type StagedNativeUpdate = z.infer<typeof StagedNativeUpdateSchema>;

export function stagedExeFileName(version: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `kimi-${version}.exe` : `kimi-${version}`;
}

export function stagedExePath(exePath: string, staged: StagedNativeUpdate): string {
  return join(getNativeStagingDir(exePath), staged.exeFileName);
}

/**
 * Read the staged-update metadata, returning null when anything is off:
 * missing/corrupt `staged.json`, or the staged exe went away / changed size.
 * A null result makes callers behave as if no update was ever staged.
 */
export async function readStagedNativeUpdate(
  exePath: string,
  filePath: string = getNativeStagedStateFile(exePath),
): Promise<StagedNativeUpdate | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StagedNativeUpdateSchema.safeParse(json);
  if (!parsed.success) return null;
  const staged = parsed.data;
  const info = await stat(stagedExePath(exePath, staged)).catch(() => null);
  if (info === null || info.size !== staged.exeSize) return null;
  return staged;
}

/**
 * Mark the currently staged update as manual, confirming the marker actually
 * persisted. Used when an explicit `kimi upgrade` adopts a payload the
 * passive downloader staged (already on disk, or still downloading): the
 * marker lets the startup swap apply it even under the env opt-out.
 *
 * Returns false when the stage is concurrently claimed by a startup swap
 * (nothing to promote) or a confirming read never sees the marker — callers
 * must NOT report adoption for a promotion that never landed. The write and
 * the confirmation use the same atomic metadata path as staging; a swap that
 * claims the PROMOTED file proceeds with the marker, which is the desired
 * outcome anyway.
 */
export async function promoteStagedUpdateToManual(exePath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const staged = await readStagedNativeUpdate(exePath);
    if (staged === null) return false;
    if (staged.manual === true) return true;
    await writeJsonFile(getNativeStagedStateFile(exePath), StagedNativeUpdateSchema, {
      ...staged,
      manual: true,
    });
    // Confirm: a concurrent claim/restore cycle could leave unpromoted
    // content behind (the restore never overwrites, so a confirmed marker
    // cannot be displaced afterwards).
    const confirmed = await readStagedNativeUpdate(exePath);
    if (confirmed?.manual === true) return true;
  }
  return false;
}

/** Stream a file's sha256 as hex; null when the file cannot be read. */
export async function hashFileSha256(filePath: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Whether a `.staging/` entry is an updater-owned artifact: a staged
 * executable (`kimi-<version>[.exe]`) or a download intermediate
 * (`kimi-<version>[.exe][.<pid>.<n>].part`). Ownership derives from the
 * semver/file-name contract (prerelease and build metadata included), so
 * foreign files in the directory are never matched.
 */
function isUpdaterOwnedStagingFile(entry: string): boolean {
  if (!entry.startsWith('kimi-')) return false;
  let name = entry.slice('kimi-'.length);
  const isPart = name.endsWith('.part');
  if (isPart) name = name.slice(0, -'.part'.length);
  const candidates = isPart
    ? // New-style intermediates carry a unique worker infix (.<pid>.<n>)
      // after any .exe — try with and without stripping it (the infix is
      // itself dot-numeric, which is ambiguous with prerelease suffixes).
      [name, name.replace(/\.\d+\.\d+$/, '')]
    : [name];
  return candidates.some((candidate) => {
    const base = candidate.endsWith('.exe') ? candidate.slice(0, -'.exe'.length) : candidate;
    return valid(base) !== null;
  });
}

/**
 * An unreferenced artifact is only deleted once it is older than this. A
 * concurrent worker's payload publishes BEFORE its metadata, so a freshly
 * renamed staged exe can look like an orphan for a moment; publication takes
 * milliseconds, so anything unreferenced AND old is definitively abandoned.
 */
const STAGING_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Remove files in `.staging/` that nothing references: interrupted downloads
 * (`.part`), and staged exes whose `staged.json` never landed (downloader
 * killed between the two writes) — each such orphan is ~180 MB and would
 * otherwise accumulate forever. Swap claim files (`staged.json.swap-*`) and
 * the exes they reference are preserved: another instance may be mid-swap.
 */
async function cleanupStagingOrphans(stagingDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch {
    return;
  }
  const keep = new Set<string>([KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME]);
  for (const entry of entries) {
    if (!entry.startsWith(`${KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME}.swap-`)) continue;
    keep.add(entry);
    const raw = await readFile(join(stagingDir, entry), 'utf-8').catch(() => null);
    if (raw === null) continue;
    try {
      const exeFileName: unknown = (JSON.parse(raw) as { exeFileName?: unknown }).exeFileName;
      if (typeof exeFileName === 'string' && exeFileName.length > 0) {
        // basename(): the metadata contract is a plain file name — never let
        // a hand-crafted path escape the staging dir.
        keep.add(basename(exeFileName));
      }
    } catch {
      // Unparseable claim: keep the claim file itself, touch nothing else.
    }
  }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    // Only ever unlink updater-owned artifact names (files, never
    // directories): the staging dir sits next to the exe and may contain
    // data that is not ours.
    if (!isUpdaterOwnedStagingFile(entry)) continue;
    const full = join(stagingDir, entry);
    const info = await stat(full).catch(() => null);
    if (info === null) continue;
    // Too young to be abandoned — a concurrent worker may be about to
    // publish its metadata.
    if (Date.now() - info.mtimeMs < STAGING_ORPHAN_GRACE_MS) continue;
    await unlink(full).catch(() => {});
  }
}

export interface StageNativeUpdateOptions {
  readonly version: string;
  /** Path of the installed executable the staged binary will later replace. */
  readonly exePath: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: typeof fetch;
  /** Download progress (bytes so far, Content-Length total when known). */
  readonly onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
  /** Test hook: override the download idle timeout (default 30 s). */
  readonly idleTimeoutMs?: number;
  /** True when the stage answers an explicit user-initiated `kimi upgrade`. */
  readonly manual?: boolean;
}

export type StageNativeUpdateStatus = 'already-staged' | 'staged';

export interface StageNativeUpdateResult {
  readonly status: StageNativeUpdateStatus;
  readonly staged: StagedNativeUpdate;
}

/**
 * Idle timeout for the binary stream: any 30 s without a arriving chunk
 * aborts the download. Total duration is intentionally unbounded — slow
 * networks may take as long as they need as long as bytes keep flowing.
 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/** Uniquifies the .part path across concurrent in-process workers. */
let stageTempCounter = 0;

async function downloadAndHash(
  url: string,
  partPath: string,
  expectedSha256: string,
  fetchImpl: typeof fetch,
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<number> {
  const controller = new AbortController();
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimeout = (): void => {
    if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      controller.abort(new Error(`download stalled: no data for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  };
  armIdleTimeout();
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    clearTimeout(idleTimeout);
    throw error;
  }
  if (!response.ok || response.body === null) {
    clearTimeout(idleTimeout);
    throw new Error(`native binary download returned HTTP ${response.status}`);
  }
  const contentLength = response.headers.get('content-length');
  const total =
    contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  const hash = createHash('sha256');
  let size = 0;
  const file = await open(partPath, 'w');
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      armIdleTimeout();
      hash.update(chunk);
      size += chunk.length;
      // FileHandle.write may persist FEWER bytes than requested (a short
      // write, e.g. near disk exhaustion) while the hash and size above
      // already account for the whole chunk — an unretried short write would
      // publish a truncated binary under a valid checksum. Loop until the
      // chunk is fully on disk.
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset);
        if (bytesWritten === 0) {
          throw new Error('failed to write the native binary to disk (disk full?)');
        }
        offset += bytesWritten;
      }
      onProgress?.(size, total);
    }
  } finally {
    clearTimeout(idleTimeout);
    await file.close();
  }
  const digest = hash.digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }
  return size;
}

/**
 * Download + verify `version` next to the running executable.
 *
 * Short-circuits with `already-staged` when the same version is ready on
 * disk (repeat `kimi upgrade`, or foreground/background overlap). **Throws**
 * on any failure after cleaning up this version's leftovers — the caller
 * records an install failure.
 */
export async function stageNativeUpdate(
  options: StageNativeUpdateOptions,
): Promise<StageNativeUpdateResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  // Validate BEFORE anything derives a filesystem path from the version: the
  // hidden download command takes it from argv, and a non-semver could carry
  // path traversal into the cleanup paths below.
  if (valid(options.version) === null) {
    throw new Error(`invalid semver for native staging: ${JSON.stringify(options.version)}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = `${platform}-${arch}`;
  const exeFileName = stagedExeFileName(options.version, platform);

  const existing = await readStagedNativeUpdate(options.exePath);
  if (existing !== null && existing.version === options.version) {
    // An explicit upgrade adopts an auto-staged payload — but only report
    // the adoption once the manual marker is confirmed persisted. A stage
    // currently being claimed by a startup swap cannot be promoted here;
    // fall through and stage afresh instead.
    if (options.manual === true && existing.manual !== true) {
      if (await promoteStagedUpdateToManual(options.exePath)) {
        return { status: 'already-staged', staged: { ...existing, manual: true } };
      }
    } else {
      return { status: 'already-staged', staged: existing };
    }
  }

  // A different version was staged earlier and never swapped (skipped
  // rollout, user stayed offline, …). Only its metadata record is removed —
  // the exe stays: deleting it could pull the payload from a live swap that
  // claimed the old stage, and an unreferenced exe is reaped by a later
  // orphan cleanup. The metadata write below atomically replaces the record.
  if (existing !== null) {
    await rm(getNativeStagedStateFile(options.exePath), { force: true }).catch(() => {});
  }
  const stagingDir = getNativeStagingDir(options.exePath);
  await mkdir(stagingDir, { recursive: true });
  // Drop orphans from interrupted earlier runs before writing ours.
  await cleanupStagingOrphans(stagingDir);

  const staged: StagedNativeUpdate = {
    version: options.version,
    target,
    exeFileName,
    sha256: '',
    exeSize: 0,
    stagedAt: new Date().toISOString(),
    manual: options.manual === true ? true : undefined,
  };

  // Unique .part name per worker: a same-version downloader may overlap a
  // swap claim (and, in the irreducible residual of pathname-level locking, a
  // second lock holder) — a shared .part path would interleave writes into
  // garbage that fails verification, with each side's cleanup deleting the
  // other's payload.
  const partPath = join(
    stagingDir,
    `${exeFileName}.${process.pid}.${stageTempCounter}.part`,
  );
  stageTempCounter += 1;
  try {
    const manifest = await fetchNativeReleaseManifest(options.version, fetchImpl);
    const entry = selectPlatformEntry(manifest, platform, arch);
    const size = await downloadAndHash(
      nativeBinaryUrl(options.version, entry.filename),
      partPath,
      entry.checksum,
      fetchImpl,
      options.onProgress,
      options.idleTimeoutMs,
    );
    // sha256 matched the manifest. Make the private .part file executable
    // BEFORE publishing it: a concurrent swap may move the staged exe into
    // the install path the instant it appears at its published name, so a
    // post-publish chmod could land on a path that is already gone — leaving
    // a non-executable installation behind.
    await chmod(partPath, 0o755);
    await rename(partPath, stagedExePath(options.exePath, staged));

    staged.sha256 = entry.checksum;
    staged.exeSize = size;
    // Atomic write: staged.json only ever appears complete and consistent.
    await writeJsonFile(
      getNativeStagedStateFile(options.exePath),
      StagedNativeUpdateSchema,
      staged,
    );
    return { status: 'staged', staged };
  } catch (error) {
    // Remove only what THIS attempt privately owns: its unique .part file.
    // The shared staged-exe path is never deleted on failure — every
    // reference check is a snapshot, and a concurrent worker may have just
    // renamed its verified payload onto that path (payloads publish before
    // their metadata). An unreferenced exe is reaped by the age-gated
    // orphan cleanup.
    await rm(partPath, { force: true }).catch(() => {});
    // Best effort: drop the staging dir itself when empty (a concurrent
    // worker's files keep it around — rmdir only removes empty dirs).
    await rmdir(getNativeStagingDir(options.exePath)).catch(() => {});
    throw error;
  }
}
