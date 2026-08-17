import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativeBinaryUrl, nativeManifestUrl } from '#/cli/update/native-manifest';
import {
  readStagedNativeUpdate,
  removeStagedNativeUpdate,
  stagedExePath,
  stageNativeUpdate,
} from '#/cli/update/native-stage';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';

const VERSION = '0.7.0';
const PAYLOAD = Buffer.from('fake-sea-binary-payload');
// The CDN serves the bare platform binary; the manifest checksum is its sha256.
const BINARY_FILENAME = 'kimi-code-linux-x64';

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface MockCdnOptions {
  readonly version?: string;
  readonly payload: Buffer;
  readonly checksum?: string;
}

function mockCdnFetch(options: MockCdnOptions): typeof fetch {
  const version = options.version ?? VERSION;
  const manifestBody = JSON.stringify({
    version,
    tag: `v${version}`,
    platforms: {
      'linux-x64': {
        filename: BINARY_FILENAME,
        checksum: options.checksum ?? sha256Hex(options.payload),
      },
    },
  });
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === nativeManifestUrl(version)) {
      return { ok: true, status: 200, text: async () => manifestBody, body: null };
    }
    if (url === nativeBinaryUrl(version, BINARY_FILENAME)) {
      return { ok: true, status: 200, text: async () => '', body: [options.payload] };
    }
    return { ok: false, status: 404, text: async () => '', body: null };
  }) as unknown as typeof fetch;
}

describe('stageNativeUpdate', () => {
  let workDir: string;
  let exePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-stage-test-'));
    exePath = join(workDir, 'bin', 'kimi');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('downloads, verifies and records the staged metadata', async () => {
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });

    expect(result.status).toBe('staged');
    expect(result.staged).toMatchObject({
      version: VERSION,
      target: 'linux-x64',
      exeFileName: `kimi-${VERSION}`,
      sha256: sha256Hex(PAYLOAD),
      exeSize: PAYLOAD.length,
    });

    const stagedOnDisk = await readStagedNativeUpdate(exePath);
    expect(stagedOnDisk).toEqual(result.staged);
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
    // The .part intermediate is gone once the download was promoted.
    await expect(
      stat(join(getNativeStagingDir(exePath), `kimi-${VERSION}.part`)),
    ).rejects.toThrow();
  });

  it('marks the staged exe executable', async () => {
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    const info = await stat(stagedExePath(exePath, result.staged));
    expect(info.mode & 0o111).not.toBe(0);
  });

  it('short-circuits when the same version is already staged', async () => {
    const firstFetch = mockCdnFetch({ payload: PAYLOAD });
    await stageNativeUpdate({ version: VERSION, exePath, platform: 'linux', arch: 'x64', fetchImpl: firstFetch });

    const secondFetch = mockCdnFetch({ payload: PAYLOAD });
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: secondFetch,
    });

    expect(result.status).toBe('already-staged');
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('re-stages when the staged exe went missing', async () => {
    const first = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    // The metadata stays but the exe is deleted → not trustworthy, re-stage.
    await rm(stagedExePath(exePath, first.staged));
    expect(await readStagedNativeUpdate(exePath)).toBeNull();

    const second = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(second.status).toBe('staged');
  });

  it('throws on a checksum mismatch and cleans up leftovers', async () => {
    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'linux',
        arch: 'x64',
        fetchImpl: mockCdnFetch({ payload: PAYLOAD, checksum: 'f'.repeat(64) }),
      }),
    ).rejects.toThrow(/sha256 mismatch/);

    expect(await readStagedNativeUpdate(exePath)).toBeNull();
    // Both the staged metadata and the .part download are gone.
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });

  it('throws when the platform is missing from the manifest', async () => {
    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'win32',
        arch: 'arm64',
        fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      }),
    ).rejects.toThrow(/win32-arm64 not found/);
  });

  it('supersedes a staged older version', async () => {
    await stageNativeUpdate({
      version: '0.6.0',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ version: '0.6.0', payload: Buffer.from('old-payload') }),
    });

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });

    expect(result.status).toBe('staged');
    expect(result.staged.version).toBe(VERSION);
    await expect(
      stat(join(getNativeStagingDir(exePath), 'kimi-0.6.0')),
    ).rejects.toThrow();
  });

  it('cleans orphaned staging files before downloading, preserving live swap claims', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(stagingDir, { recursive: true });
    // Orphans from interrupted earlier runs: a referenced-by-nothing exe and
    // a stale .part download.
    await writeFile(join(stagingDir, 'kimi-9.9.9'), Buffer.from('orphan-exe'));
    await writeFile(join(stagingDir, 'kimi-9.9.9.part'), Buffer.from('partial'));
    // A live swap claim referencing its own staged exe must survive.
    const claimExe = 'kimi-8.8.8';
    await writeFile(join(stagingDir, claimExe), Buffer.from('swap-in-progress'));
    await writeFile(
      join(stagingDir, 'staged.json.swap-1234'),
      JSON.stringify({ exeFileName: claimExe }),
    );

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(result.status).toBe('staged');

    await expect(stat(join(stagingDir, 'kimi-9.9.9'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'kimi-9.9.9.part'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'staged.json.swap-1234'))).resolves.toBeDefined();
    await expect(stat(join(stagingDir, claimExe))).resolves.toBeDefined();
  });
});

describe('readStagedNativeUpdate / removeStagedNativeUpdate', () => {
  let workDir: string;
  let exePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-staged-read-test-'));
    exePath = join(workDir, 'bin', 'kimi');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns null for malformed staged.json content', async () => {
    const { mkdir } = await import('node:fs/promises');
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(getNativeStagedStateFile(exePath), '{not json', 'utf-8');
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('returns null when the exe size drifted from the metadata', async () => {
    const { staged } = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    await writeFile(stagedExePath(exePath, staged), Buffer.alloc(PAYLOAD.length + 1));
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('removes staged artifacts', async () => {
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    await removeStagedNativeUpdate(exePath);
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });
});
