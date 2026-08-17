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

const fsMocks = vi.hoisted(() => ({
  /** Records chmod/rename calls (path-based) so tests can assert ordering. */
  calls: [] as Array<{ readonly op: 'chmod' | 'rename'; readonly path: string; readonly dst?: string }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (
      path: Parameters<typeof actual.chmod>[0],
      mode: Parameters<typeof actual.chmod>[1],
    ) => {
      fsMocks.calls.push({ op: 'chmod', path: String(path) });
      return actual.chmod(path, mode);
    },
    rename: async (
      src: Parameters<typeof actual.rename>[0],
      dst: Parameters<typeof actual.rename>[1],
    ) => {
      fsMocks.calls.push({ op: 'rename', path: String(src), dst: String(dst) });
      return actual.rename(src, dst);
    },
  };
});

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
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => '',
        headers: {
          get: (name: string): string | null =>
            name === 'content-length' ? String(options.payload.length) : null,
        },
        body: [options.payload],
      };
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
    fsMocks.calls.length = 0;
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

  it('makes the download executable before publishing it at the staged name', async () => {
    // A concurrent swap may move the staged exe into place the instant it
    // appears at its published name, so the chmod must land on the private
    // .part file first — a later chmod could hit an already-moved path.
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    const stagedExe = stagedExePath(exePath, result.staged);
    const partPath = `${stagedExe}.part`;
    const chmodIndex = fsMocks.calls.findIndex(
      (call) => call.op === 'chmod' && call.path === partPath,
    );
    const publishIndex = fsMocks.calls.findIndex(
      (call) => call.op === 'rename' && call.path === partPath && call.dst === stagedExe,
    );
    expect(chmodIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(chmodIndex).toBeLessThan(publishIndex);
  });

  it('reports download progress with the Content-Length total', async () => {
    const progress: Array<readonly [number, number | null]> = [];
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      onProgress: (downloaded, total) => {
        progress.push([downloaded, total]);
      },
    });
    // One frame per chunk; the mock stream delivers the payload in one piece.
    expect(progress).toEqual([[PAYLOAD.length, PAYLOAD.length]]);
  });

  it('aborts a stalled download after the idle timeout', async () => {
    const manifestBody = JSON.stringify({
      version: VERSION,
      platforms: {
        'linux-x64': { filename: BINARY_FILENAME, checksum: 'a'.repeat(64) },
      },
    });
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === nativeManifestUrl(VERSION)) {
        return { ok: true, status: 200, text: async () => manifestBody, body: null };
      }
      if (url === nativeBinaryUrl(VERSION, BINARY_FILENAME)) {
        const signal = init?.signal;
        const body = (async function* (): AsyncGenerator<Buffer> {
          yield Buffer.from('first-chunk');
          // Stall forever — only the idle timeout's abort can end this.
          await new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            }, { once: true });
          });
        })();
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => '',
          headers: { get: (): string | null => null },
          body,
        };
      }
      return { ok: false, status: 404, text: async (): Promise<string> => '', body: null };
    }) as unknown as typeof fetch;

    // Real timers with a 50 ms test override — fake timers interact badly
    // with async-generator suspension, so the idle timeout is injectable.
    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'linux',
        arch: 'x64',
        fetchImpl,
        idleTimeoutMs: 50,
      }),
    ).rejects.toThrow(/stalled/);
    // The failed attempt cleans up after itself.
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
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
