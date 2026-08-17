/**
 * Hidden `kimi __update_download <version>` sub-command: the self-spawned
 * worker behind native staged updates. Preflight spawns it detached in the
 * background (and the `upgrade` command in the foreground); it downloads,
 * verifies and stages the binary next to the running exe. The swap into
 * place happens on the next startup (see `cli/update/native-swap.ts`).
 */

import { log } from '@moonshot-ai/kimi-code-sdk';

import { tryAcquireUpdateInstallLock } from '#/cli/update/install-lock';
import { stageNativeUpdate } from '#/cli/update/native-stage';
import { detectNativeInstall } from '#/cli/update/source';

export async function runUpdateDownloadCommand(version: string): Promise<number> {
  if (!detectNativeInstall()) {
    process.stderr.write('error: update download is only available in the native build\n');
    return 1;
  }
  // Another instance is already staging this version (30-min stale window
  // covers crashed downloaders): the outcome is equivalent, exit quietly.
  const lock = await tryAcquireUpdateInstallLock({ version });
  if (lock === null) return 0;
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
