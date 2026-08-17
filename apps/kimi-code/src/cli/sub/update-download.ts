/**
 * Hidden `kimi __update_download <version>` sub-command: the self-spawned
 * worker behind native staged updates. Preflight spawns it detached in the
 * background (and the `upgrade` command in the foreground); it downloads,
 * verifies and stages the binary next to the running exe. The swap into
 * place happens on the next startup (see `cli/update/native-swap.ts`).
 */

import { log } from '@moonshot-ai/kimi-code-sdk';

import {
  readUpdateInstallLockVersion,
  tryAcquireUpdateInstallLock,
} from '#/cli/update/install-lock';
import { readStagedNativeUpdate, stageNativeUpdate } from '#/cli/update/native-stage';
import { detectNativeInstall } from '#/cli/update/source';

const LOCK_HELD_POLL_INTERVAL_MS = 2_000;

/**
 * Another worker holds the install lock for the SAME version. Returning right
 * away would report a success that has not happened yet — the in-flight
 * download may still fail — so wait for it: resolves true once its staged
 * update is verified on disk, false when the holder finished without staging
 * (the caller then takes over the download itself).
 */
async function waitForStagedUpdate(version: string, exePath: string): Promise<boolean> {
  for (;;) {
    const staged = await readStagedNativeUpdate(exePath);
    if (staged !== null && staged.version === version) return true;
    // staged.json lands before the holder releases its lock, so a lock that
    // is gone (or changed hands) with nothing staged means the holder failed.
    const holderVersion = await readUpdateInstallLockVersion();
    if (holderVersion !== version) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, LOCK_HELD_POLL_INTERVAL_MS);
    });
  }
}

export async function runUpdateDownloadCommand(version: string): Promise<number> {
  if (!detectNativeInstall()) {
    process.stderr.write('error: update download is only available in the native build\n');
    return 1;
  }
  const out = process.stdout;
  let lock = await tryAcquireUpdateInstallLock({ version });
  if (lock === null) {
    const holderVersion = await readUpdateInstallLockVersion();
    if (holderVersion === version) {
      // Another worker is already downloading this exact version: wait for it
      // and adopt its verified result instead of exiting on a maybe.
      out.write(
        `A download of Kimi Code ${version} is already in progress; waiting for it to finish…\n`,
      );
      if (await waitForStagedUpdate(version, process.execPath)) {
        out.write(`Kimi Code ${version} is downloaded; it applies on the next start.\n`);
        return 0;
      }
      // The holder finished without staging (failed or crashed): take over.
      lock = await tryAcquireUpdateInstallLock({ version });
    } else if (holderVersion === undefined) {
      // The lock was released between the two reads — retry the acquire once.
      lock = await tryAcquireUpdateInstallLock({ version });
    }
    if (lock === null) {
      process.stderr.write(
        `error: another update (${holderVersion ?? 'unknown version'}) is already downloading\n`,
      );
      return 1;
    }
  }
  const label = `Downloading Kimi Code ${version} (${process.platform}-${process.arch})…`;
  const onProgress = createDownloadProgress(out, label);
  try {
    const result = await stageNativeUpdate({
      version,
      exePath: process.execPath,
      onProgress,
    });
    if (out.isTTY) out.write('\n');
    if (result.status === 'already-staged') {
      out.write(`Kimi Code ${version} is already downloaded; it applies on the next start.\n`);
    }
    return 0;
  } catch (error) {
    if (out.isTTY) out.write('\n');
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: failed to download update ${version}: ${message}\n`);
    log.warn('native update download failed', { version, error: message });
    return 1;
  } finally {
    await lock.release().catch(() => {});
  }
}

const PROGRESS_FRAME_INTERVAL_MS = 100;
const PROGRESS_LINE_INTERVAL_BYTES = 32 * 1024 * 1024;

function formatDownloadProgress(label: string, downloaded: number, total: number | null): string {
  const mb = Math.floor(downloaded / (1024 * 1024));
  if (total === null || total <= 0) return `${label} ${mb} MB`;
  const totalMb = Math.max(1, Math.round(total / (1024 * 1024)));
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return `${label} ${percent}% (${mb}/${totalMb} MB)`;
}

/**
 * Download progress renderer for the (foreground) downloader: a single
 * in-place line on a TTY (`\r` + clear-line, throttled to 10 fps, final frame
 * always rendered), or one line per 32 MB when piped to a file. The caller
 * owns the trailing newline.
 */
export function createDownloadProgress(
  out: NodeJS.WriteStream,
  label: string,
): (downloadedBytes: number, totalBytes: number | null) => void {
  const isTTY = out.isTTY;
  let lastFrameAt = 0;
  let lastLineAt = 0;
  if (!isTTY) out.write(`${label}\n`);
  return (downloaded, total) => {
    const done = total !== null && downloaded >= total;
    if (isTTY) {
      const now = Date.now();
      if (!done && now - lastFrameAt < PROGRESS_FRAME_INTERVAL_MS) return;
      lastFrameAt = now;
      out.write(`\r\u001B[K${formatDownloadProgress(label, downloaded, total)}`);
      return;
    }
    if (!done && downloaded - lastLineAt < PROGRESS_LINE_INTERVAL_BYTES) return;
    lastLineAt = downloaded;
    out.write(`${formatDownloadProgress(label, downloaded, total)}\n`);
  };
}
