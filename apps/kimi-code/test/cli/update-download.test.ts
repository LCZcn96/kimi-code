import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runUpdateDownloadCommand } from '#/cli/sub/update-download';

const mocks = vi.hoisted(() => ({
  detectNativeInstall: vi.fn(() => true),
  tryAcquireUpdateInstallLock: vi.fn(),
  stageNativeUpdate: vi.fn(),
}));

vi.mock('#/cli/update/source', () => ({
  detectNativeInstall: mocks.detectNativeInstall,
}));

vi.mock('#/cli/update/install-lock', () => ({
  tryAcquireUpdateInstallLock: mocks.tryAcquireUpdateInstallLock,
}));

vi.mock('#/cli/update/native-stage', () => ({
  stageNativeUpdate: mocks.stageNativeUpdate,
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-sdk')>(
    '@moonshot-ai/kimi-code-sdk',
  );
  return {
    ...actual,
    log: { ...actual.log, warn: vi.fn() },
  };
});

describe('runUpdateDownloadCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectNativeInstall.mockReturnValue(true);
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/install.lock',
      release: vi.fn(async () => {}),
    });
    mocks.stageNativeUpdate.mockResolvedValue({ status: 'staged', staged: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses on non-native installs', async () => {
    mocks.detectNativeInstall.mockReturnValue(false);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('native build'));
  });

  it('exits quietly when another instance holds the install lock', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
  });

  it('stages against the running exe and releases the lock', async () => {
    const release = vi.fn(async () => {});
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({ filePath: '/tmp/install.lock', release });
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0', exePath: process.execPath }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reports staging failures with a non-zero exit code', async () => {
    mocks.stageNativeUpdate.mockRejectedValue(new Error('sha256 mismatch'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('sha256 mismatch'));
  });
});
