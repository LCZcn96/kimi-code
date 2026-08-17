/**
 * Native staged update: download + verify + unpack into `<exe dir>/.staging/`,
 * without touching the running executable. The actual swap happens on the
 * next startup (see `native-swap.ts`).
 *
 * Trust chain: the zip's sha256 comes from the per-release manifest (served
 * over HTTPS), and the unpacked exe is re-checked against the zip entry's
 * crc32, so a staged binary is byte-exact what the release pipeline produced.
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';
import { writeJsonFile } from '#/utils/persistence';

import {
  fetchNativeReleaseManifest,
  nativeBinaryUrl,
  selectPlatformEntry,
} from './native-manifest';
import { unzipFirstFile } from './unzip';

const StagedNativeUpdateSchema = z
  .object({
    version: z.string().min(1),
    target: z.string().min(1),
    /** Base name of the staged executable inside `.staging/`. */
    exeFileName: z.string().min(1),
    /** sha256 of the zip the exe was unpacked from. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    exeSize: z.number().int().min(1),
    stagedAt: z.string().min(1),
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

/** Remove staged.json + the staged exe; used on downgrade-guard discards and swap failures. */
export async function removeStagedNativeUpdate(
  exePath: string,
  knownStaged?: StagedNativeUpdate,
): Promise<void> {
  const stagingDir = getNativeStagingDir(exePath);
  // The swap flow claims staged.json by renaming it away first, so callers
  // there must pass the already-read metadata — discovering it from the
  // (now missing) state file would find nothing and leak the staged exe.
  const staged = knownStaged ?? (await readStagedNativeUpdate(exePath).catch(() => null));
  if (staged !== null) {
    await rm(stagedExePath(exePath, staged), { force: true }).catch(() => {});
  }
  await rm(getNativeStagedStateFile(exePath), { force: true }).catch(() => {});
  // Best effort: drop the staging dir itself when empty (leftover `.part`
  // files keep it around; the downloader truncates those on the next run).
  await rmdir(stagingDir).catch(() => {});
}

export interface StageNativeUpdateOptions {
  readonly version: string;
  /** Path of the installed executable the staged binary will later replace. */
  readonly exePath: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: typeof fetch;
  readonly stdout?: { write(chunk: string): boolean };
}

export type StageNativeUpdateStatus = 'already-staged' | 'staged';

export interface StageNativeUpdateResult {
  readonly status: StageNativeUpdateStatus;
  readonly staged: StagedNativeUpdate;
}

async function downloadAndHash(
  url: string,
  partPath: string,
  expectedSha256: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok || response.body === null) {
    throw new Error(`native binary download returned HTTP ${response.status}`);
  }
  const hash = createHash('sha256');
  const file = await open(partPath, 'w');
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  const digest = hash.digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }
}

/**
 * Download + verify + unpack `version` next to the running executable.
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = `${platform}-${arch}`;
  const exeFileName = stagedExeFileName(options.version, platform);

  const existing = await readStagedNativeUpdate(options.exePath);
  if (existing !== null && existing.version === options.version) {
    return { status: 'already-staged', staged: existing };
  }

  // A different version was staged earlier and never swapped (skipped
  // rollout, user stayed offline, …): supersede it before writing ours.
  if (existing !== null) {
    await removeStagedNativeUpdate(options.exePath);
  }
  const stagingDir = getNativeStagingDir(options.exePath);
  await mkdir(stagingDir, { recursive: true });

  const staged: StagedNativeUpdate = {
    version: options.version,
    target,
    exeFileName,
    sha256: '',
    exeSize: 0,
    stagedAt: new Date().toISOString(),
  };

  try {
    const manifest = await fetchNativeReleaseManifest(options.version, fetchImpl);
    const entry = selectPlatformEntry(manifest, platform, arch);
    const partPath = join(stagingDir, `${entry.filename}.part`);
    options.stdout?.write(`Downloading Kimi Code ${options.version} (${target})…\n`);
    await downloadAndHash(
      nativeBinaryUrl(options.version, entry.filename),
      partPath,
      entry.checksum,
      fetchImpl,
    );
    options.stdout?.write('Verifying and unpacking…\n');
    const { data } = unzipFirstFile(await readFile(partPath));
    await writeFile(stagedExePath(options.exePath, staged), data, { mode: 0o755 });
    await rm(partPath, { force: true });

    staged.sha256 = entry.checksum;
    staged.exeSize = data.length;
    // Atomic write: staged.json only ever appears complete and consistent.
    await writeJsonFile(
      getNativeStagedStateFile(options.exePath),
      StagedNativeUpdateSchema,
      staged,
    );
    return { status: 'staged', staged };
  } catch (error) {
    await removeStagedNativeUpdate(options.exePath);
    throw error;
  }
}
