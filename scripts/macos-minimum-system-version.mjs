import fs from 'node:fs';
import zlib from 'node:zlib';

// electron-updater compares `minimumSystemVersion` with `semver.lt(os.release(), value)`.
// On macOS os.release() is the Darwin kernel version, not the marketing version,
// and a non-semver value makes the comparison throw, which allows the update.
// Only explicitly verified pairs are listed; anything else must fail the build.
export const MACOS_TO_DARWIN_MINIMUM = Object.freeze({
  '13.0': '22.0.0',
  '14.0': '23.0.0',
  '15.0': '24.0.0',
  '26.0': '25.0.0',
});

const STRICT_DARWIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function darwinMinimumForMacos(lsMinimumSystemVersion) {
  const darwin = Object.hasOwn(MACOS_TO_DARWIN_MINIMUM, lsMinimumSystemVersion)
    ? MACOS_TO_DARWIN_MINIMUM[lsMinimumSystemVersion]
    : undefined;
  if (!darwin) {
    throw new Error(
      `LSMinimumSystemVersion ${JSON.stringify(lsMinimumSystemVersion)} has no verified Darwin mapping; `
      + `add it to MACOS_TO_DARWIN_MINIMUM after checking the real kernel version`,
    );
  }
  return darwin;
}

export function isStrictDarwinVersion(value) {
  return typeof value === 'string' && STRICT_DARWIN_VERSION.test(value);
}

export function compareDarwinVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function readLsMinimumSystemVersion(plist) {
  const text = Buffer.isBuffer(plist) ? plist.toString('utf8') : String(plist);
  if (text.startsWith('bplist')) {
    throw new Error('Info.plist is a binary plist; expected the XML plist electron-builder writes');
  }
  const matches = [...text.matchAll(/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]*)<\/string>/g)];
  if (matches.length !== 1) {
    throw new Error(`Info.plist must declare LSMinimumSystemVersion exactly once, found ${matches.length}`);
  }
  const value = matches[0][1].trim();
  if (!value) throw new Error('Info.plist LSMinimumSystemVersion is empty');
  return value;
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  if (read !== length) throw new Error('Unexpected end of ZIP archive');
  return buffer;
}

function zip64Extra(extra, wanted) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (id === 0x0001) {
      const values = [];
      for (let cursor = offset + 4; cursor + 8 <= offset + 4 + size; cursor += 8) {
        values.push(Number(extra.readBigUInt64LE(cursor)));
      }
      return values;
    }
    offset += 4 + size;
  }
  if (wanted) throw new Error('ZIP64 entry is missing its extended information field');
  return [];
}

function readCentralDirectory(fd, fileSize) {
  const tailLength = Math.min(fileSize, 65_557);
  const tail = readAt(fd, fileSize - tailLength, tailLength);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');
  let entries = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) {
      throw new Error('ZIP64 end-of-central-directory locator not found');
    }
    const zip64Offset = Number(tail.readBigUInt64LE(locator + 8));
    const zip64 = readAt(fd, zip64Offset, 56);
    if (zip64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 end-of-central-directory record not found');
    entries = Number(zip64.readBigUInt64LE(32));
    size = Number(zip64.readBigUInt64LE(40));
    offset = Number(zip64.readBigUInt64LE(48));
  }
  return { entries, directory: readAt(fd, offset, size) };
}

export function listZipEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const { entries, directory } = readCentralDirectory(fd, fs.fstatSync(fd).size);
    const result = [];
    let cursor = 0;
    for (let index = 0; index < entries; index += 1) {
      if (directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Malformed ZIP central directory');
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      let localOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const needsZip64 = uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff;
      const values = zip64Extra(extra, needsZip64);
      let next = 0;
      if (uncompressedSize === 0xffffffff) uncompressedSize = values[next++];
      if (compressedSize === 0xffffffff) compressedSize = values[next++];
      if (localOffset === 0xffffffff) localOffset = values[next++];
      result.push({ name, method, compressedSize, uncompressedSize, localOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

export function readZipEntry(zipPath, entry) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const header = readAt(fd, entry.localOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`Malformed ZIP local header for ${entry.name}`);
    const dataOffset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = readAt(fd, dataOffset, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  } finally {
    fs.closeSync(fd);
  }
}

export function readAppMinimumFromZip(zipPath) {
  const plists = listZipEntries(zipPath).filter((entry) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(entry.name));
  if (plists.length !== 1) {
    throw new Error(`${zipPath} must contain exactly one top-level app Info.plist, found ${plists.length}`);
  }
  const lsMinimumSystemVersion = readLsMinimumSystemVersion(readZipEntry(zipPath, plists[0]));
  return { lsMinimumSystemVersion, darwinMinimum: darwinMinimumForMacos(lsMinimumSystemVersion) };
}
