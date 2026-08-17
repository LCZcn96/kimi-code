import { crc32, deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { unzipFirstFile } from '#/cli/update/unzip';

interface TestEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly method: 0 | 8;
}

/** Build a minimal well-formed zip in memory (store/deflate, no ZIP64). */
function buildZip(entries: readonly TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const compressed =
      entry.method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, Buffer.from(name));

    offset += 30 + name.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

describe('unzipFirstFile', () => {
  it('extracts a stored entry', () => {
    const zip = buildZip([{ name: 'kimi', data: Buffer.from('hello store'), method: 0 }]);
    expect(unzipFirstFile(zip)).toEqual({ name: 'kimi', data: Buffer.from('hello store') });
  });

  it('extracts a deflated entry', () => {
    const payload = Buffer.alloc(64 * 1024, 7);
    const zip = buildZip([{ name: 'kimi.exe', data: payload, method: 8 }]);
    const out = unzipFirstFile(zip);
    expect(out.name).toBe('kimi.exe');
    expect(out.data.equals(payload)).toBe(true);
  });

  it('skips directory entries and returns the first file', () => {
    const zip = buildZip([
      { name: 'bin/', data: Buffer.alloc(0), method: 0 },
      { name: 'bin/kimi', data: Buffer.from('x'), method: 0 },
    ]);
    expect(unzipFirstFile(zip).name).toBe('bin/kimi');
  });

  it('rejects a buffer without an EOCD record', () => {
    expect(() => unzipFirstFile(Buffer.from('not a zip'))).toThrow(
      /end of central directory not found/,
    );
  });

  it('rejects an unsupported compression method', () => {
    const zip = buildZip([{ name: 'kimi', data: Buffer.from('data'), method: 0 }]);
    // Central directory starts at local header (30) + name (4) + data (4) = 38;
    // its method field sits at +10. Patch it to 9 (unsupported).
    zip.writeUInt16LE(9, 38 + 10);
    expect(() => unzipFirstFile(zip)).toThrow(/compression method 9/);
  });

  it('rejects when the central directory claims an implausible entry count', () => {
    const zip = buildZip([{ name: 'kimi', data: Buffer.from('data'), method: 0 }]);
    const eocdOffset = zip.length - 22;
    zip.writeUInt16LE(17, eocdOffset + 10); // beyond MAX_ENTRIES
    expect(() => unzipFirstFile(zip)).toThrow(/unexpected entry count/);
  });

  it('rejects a corrupt payload (crc32 mismatch)', () => {
    const zip = buildZip([{ name: 'kimi', data: Buffer.from('original payload'), method: 0 }]);
    // Flip a byte inside the stored data (right after the 30-byte local header + name).
    const dataOffset = 30 + 4 + 1;
    zip.writeUInt8(zip.readUInt8(dataOffset) ^ 0xff, dataOffset);
    expect(() => unzipFirstFile(zip)).toThrow(/crc32 mismatch/);
  });

  it('rejects a corrupt deflated payload', () => {
    const payload = Buffer.alloc(4096, 1);
    const zip = buildZip([{ name: 'kimi', data: payload, method: 8 }]);
    // Corrupt one byte of the deflate stream.
    const dataOffset = 30 + 4 + 10;
    zip.writeUInt8(zip.readUInt8(dataOffset) ^ 0xff, dataOffset);
    expect(() => unzipFirstFile(zip)).toThrow();
  });

  it('rejects entries above the uncompressed size cap', () => {
    const zip = buildZip([{ name: 'kimi', data: Buffer.from('payload'), method: 0 }]);
    expect(() => unzipFirstFile(zip, { maxUncompressedSize: 4 })).toThrow(/entry too large/);
  });

  it('rejects ZIP64 markers', () => {
    const zip = buildZip([{ name: 'kimi', data: Buffer.from('payload'), method: 0 }]);
    // Patch the central entry's uncompressed size to the ZIP64 sentinel.
    // Layout: local header (30) + name (4) + data (7) → central starts at 41; size field at +24.
    zip.writeUInt32LE(0xffffffff, 41 + 24);
    expect(() => unzipFirstFile(zip)).toThrow(/ZIP64/);
  });

  it('rejects an archive with no file entries', () => {
    const zip = buildZip([{ name: 'bin/', data: Buffer.alloc(0), method: 0 }]);
    expect(() => unzipFirstFile(zip)).toThrow(/no file entry/);
  });
});
