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
import { stageNativeUpdate } from '#/cli/update/native-stage';
import { detectNativeInstall } from '#/cli/update/source';

export async function runUpdateDownloadCommand(version: string): Promise<number> {
  if (!detectNativeInstall()) {
    process.stderr.write('error: update download is only available in the native build\n');
    return 1;
  }
  let lock = await tryAcquireUpdateInstallLock({ version });
  if (lock === null) {
    // Another instance holds the lock. Same target version → its outcome is
    // ours, exit quietly. A different version (or a lock that vanished
    // between acquire and read) must not surface as a successful download.
    const holderVersion = await readUpdateInstallLockVersion();
    if (holderVersion === version) return 0;
    if (holderVersion === undefined) {
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
  const out = process.stdout;
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
