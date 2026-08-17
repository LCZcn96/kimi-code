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
  try {
    await stageNativeUpdate({ version, exePath: process.execPath, stdout: process.stdout });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: failed to download update ${version}: ${message}\n`);
    log.warn('native update download failed', { version, error: message });
    return 1;
  } finally {
    await lock.release().catch(() => {});
  }
}
