/**
 * Minimal single-file ZIP extraction for the native staged update.
 *
 * The release pipeline packages each native binary as a one-entry zip
 * (`scripts/native/package.mjs`), so this parser deliberately supports only
 * what that producer emits: store/deflate entries, no ZIP64, no encryption.
 * Anything outside that envelope is rejected — a corrupt staged binary must
 * fail here, before it can replace the running executable.
 *
 * No third-party dependency：Node >= 20.15 provides `zlib.crc32`.
 */

import { crc32, inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** A staged exe is a Node SEA binary (~150 MB today); cap far above that. */
const MAX_ENTRIES = 16;
const MAX_UNCOMPRESSED_SIZE = 1024 * 1024 * 1024; // 1 GiB
/** EOCD record (22 B) + the largest legal comment (64 KiB). */
const EOCD_SEARCH_WINDOW = 22 + 0xffff;

const ZIP64_MARKER = 0xffffffff;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('invalid zip: end of central directory not found');
}

export interface UnzipFirstFileOptions {
  /** Drop directory entries while scanning for the first regular file. */
  readonly maxUncompressedSize?: number;
}

/**
 * Extract the first regular file entry. **Throws** on any structural or
 * integrity problem (bad signature, ZIP64, unsupported method, multi-entry
 * archive, size cap, crc mismatch) — callers must treat this as "the staged
 * download is corrupt" and discard it.
 */
export function unzipFirstFile(
  buffer: Buffer,
  options: UnzipFirstFileOptions = {},
): { readonly name: string; readonly data: Buffer } {
  const maxUncompressedSize = options.maxUncompressedSize ?? MAX_UNCOMPRESSED_SIZE;
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount < 1 || entryCount > MAX_ENTRIES) {
    throw new Error(`invalid zip: unexpected entry count ${entryCount}`);
  }
  if (centralOffset >= eocdOffset) {
    throw new Error('invalid zip: central directory out of bounds');
  }

  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocdOffset || buffer.readUInt32LE(offset) !== CENTRAL_ENTRY_SIGNATURE) {
      throw new Error('invalid zip: malformed central directory entry');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf-8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    // Directory entry.
    if (name.endsWith('/')) continue;

    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localHeaderOffset === ZIP64_MARKER
    ) {
      throw new Error('unsupported zip: ZIP64 entries are not handled');
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new Error(`unsupported zip: compression method ${method}`);
    }
    if (uncompressedSize > maxUncompressedSize) {
      throw new Error(`unsupported zip: entry too large (${uncompressedSize} bytes)`);
    }
    if (localHeaderOffset + 30 > centralOffset) {
      throw new Error('invalid zip: local header out of bounds');
    }
    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error('invalid zip: malformed local header');
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) {
      throw new Error('invalid zip: entry data out of bounds');
    }

    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === METHOD_STORE ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) {
      throw new Error(
        `corrupt zip: size mismatch (expected ${uncompressedSize}, got ${data.length})`,
      );
    }
    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `corrupt zip: crc32 mismatch (expected ${expectedCrc.toString(16)}, got ${actualCrc.toString(16)})`,
      );
    }
    return { name, data };
  }

  throw new Error('invalid zip: no file entry found');
}
