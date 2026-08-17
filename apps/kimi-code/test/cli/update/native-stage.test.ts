import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchNativeReleaseManifest,
  nativeBinaryUrl,
  nativeManifestUrl,
} from '#/cli/update/native-manifest';
import {
  readStagedNativeUpdate,
  removeStagedNativeUpdate,
  stagedExePath,
  stageNativeUpdate,
} from '#/cli/update/native-stage';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';

const VERSION = '0.7.0';
const PAYLOAD = Buffer.from('fake-sea-binary-payload');

/** Same minimal zip builder as unzip.test.ts (single deflated entry). */
function buildZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf-8');
  const compressed = deflateRawSync(data);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);

  const centralBuf = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + compressed.length, 16);

  return Buffer.concat([local, nameBuf, compressed, centralBuf, eocd]);
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface MockCdnOptions {
  readonly version?: string;
  readonly zip: Buffer;
  readonly checksum?: string;
}

function mockCdnFetch(options: MockCdnOptions): typeof fetch {
  const version = options.version ?? VERSION;
  const manifestBody = JSON.stringify({
    version,
    tag: `v${version}`,
    platforms: {
      'linux-x64': {
        filename: 'kimi-code-linux-x64.zip',
        checksum: options.checksum ?? sha256Hex(options.zip),
      },
    },
  });
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === nativeManifestUrl(version)) {
      return { ok: true, status: 200, text: async () => manifestBody, body: null };
    }
    if (url === nativeBinaryUrl(version, 'kimi-code-linux-x64.zip')) {
      return { ok: true, status: 200, text: async () => '', body: [options.zip] };
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

  it('downloads, verifies, unpacks and records the staged metadata', async () => {
    const zip = buildZip('kimi', PAYLOAD);
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ zip }),
    });

    expect(result.status).toBe('staged');
    expect(result.staged).toMatchObject({
      version: VERSION,
      target: 'linux-x64',
      exeFileName: `kimi-${VERSION}`,
      sha256: sha256Hex(zip),
      exeSize: PAYLOAD.length,
    });

    const stagedOnDisk = await readStagedNativeUpdate(exePath);
    expect(stagedOnDisk).toEqual(result.staged);
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
    // The zip intermediate is gone once unpacking succeeded.
    await expect(stat(join(getNativeStagingDir(exePath), 'kimi-code-linux-x64.zip.part'))).rejects.toThrow();
  });

  it('short-circuits when the same version is already staged', async () => {
    const zip = buildZip('kimi', PAYLOAD);
    const firstFetch = mockCdnFetch({ zip });
    await stageNativeUpdate({ version: VERSION, exePath, platform: 'linux', arch: 'x64', fetchImpl: firstFetch });

    const secondFetch = mockCdnFetch({ zip });
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
    const zip = buildZip('kimi', PAYLOAD);
    const first = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ zip }),
    });
    // The metadata stays but the exe is deleted → not trustworthy, re-stage.
    await rm(stagedExePath(exePath, first.staged));
    expect(await readStagedNativeUpdate(exePath)).toBeNull();

    const second = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ zip }),
    });
    expect(second.status).toBe('staged');
  });

  it('throws on a checksum mismatch and cleans up leftovers', async () => {
    const zip = buildZip('kimi', PAYLOAD);
    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'linux',
        arch: 'x64',
        fetchImpl: mockCdnFetch({ zip, checksum: 'f'.repeat(64) }),
      }),
    ).rejects.toThrow(/sha256 mismatch/);

    expect(await readStagedNativeUpdate(exePath)).toBeNull();
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
  });

  it('throws when the platform is missing from the manifest', async () => {
    const zip = buildZip('kimi', PAYLOAD);
    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'win32',
        arch: 'arm64',
        fetchImpl: mockCdnFetch({ zip }),
      }),
    ).rejects.toThrow(/win32-arm64 not found/);
  });

  it('supersedes a staged older version', async () => {
    const oldZip = buildZip('kimi', Buffer.from('old-payload'));
    await stageNativeUpdate({
      version: '0.6.0',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ version: '0.6.0', zip: oldZip }),
    });

    const newZip = buildZip('kimi', PAYLOAD);
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ zip: newZip }),
    });

    expect(result.status).toBe('staged');
    expect(result.staged.version).toBe(VERSION);
    await expect(
      stat(join(getNativeStagingDir(exePath), 'kimi-0.6.0')),
    ).rejects.toThrow();
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
    const stagingDir = getNativeStagingDir(exePath);
    await rm(stagingDir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(stagingDir, { recursive: true });
    await writeFile(getNativeStagedStateFile(exePath), '{not json', 'utf-8');
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('returns null when the exe size drifted from the metadata', async () => {
    const zip = buildZip('kimi', PAYLOAD);
    const { staged } = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ zip }),
    });
    await writeFile(stagedExePath(exePath, staged), Buffer.alloc(PAYLOAD.length + 1));
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('removes staged artifacts', async () => {
    const zip = buildZip('kimi', PAYLOAD);
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ zip }),
    });
    await removeStagedNativeUpdate(exePath);
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });
});
