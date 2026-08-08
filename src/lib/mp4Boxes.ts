/**
 * ISO-BMFF / QuickTime box primitives, shared by the container sniff and the
 * capture-metadata reader.
 *
 * Everything here works on bytes already in memory. Finding the box worth
 * reading is a separate job (`findTopLevelBox`), because on a phone recording
 * the interesting one sits behind a few hundred megabytes of samples.
 */

export function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const c = bytes[offset + i];
    if (c == null) break;
    out += String.fromCharCode(c);
  }
  return out;
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 8) | bytes[offset + 1]!) >>> 0;
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/** Signed 32-bit, for the fixed-point entries in a track matrix. */
export function readI32(bytes: Uint8Array, offset: number): number {
  return readU32(bytes, offset) | 0;
}

/** 64-bit sizes and timestamps. Precision beyond 2^53 is not a real case here. */
export function readU64(bytes: Uint8Array, offset: number): number {
  return readU32(bytes, offset) * 0x100000000 + readU32(bytes, offset + 4);
}

export interface BoxHeader {
  type: string;
  /** Total box size including the header. */
  size: number;
  headerBytes: number;
}

/**
 * `size === 1` means the real size is a 64-bit value after the type; `size === 0`
 * means the box runs to the end of its parent.
 */
export function readBoxHeader(
  bytes: Uint8Array,
  offset: number,
  end = bytes.length,
): BoxHeader | null {
  if (offset + 8 > end) return null;
  const size32 = readU32(bytes, offset);
  const type = asciiAt(bytes, offset + 4, 4);
  if (size32 === 1) {
    if (offset + 16 > end) return null;
    return { type, size: readU64(bytes, offset + 8), headerBytes: 16 };
  }
  if (size32 === 0) return { type, size: end - offset, headerBytes: 8 };
  return { type, size: size32, headerBytes: 8 };
}

/** Boxes whose payload is just more boxes. */
const CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "udta",
  "dinf",
]);

function isPrintableType(type: string): boolean {
  for (let i = 0; i < type.length; i += 1) {
    const code = type.charCodeAt(i);
    // 0xA9 is the © that starts the legacy QuickTime user-data atoms.
    if (code !== 0xa9 && (code < 0x20 || code > 0x7e)) return false;
  }
  return type.length === 4;
}

/**
 * `meta` is a plain container in QuickTime but a FullBox in ISO-BMFF, where four
 * bytes of version/flags come first. Guessing wrong turns the whole subtree into
 * noise, so look at which offset actually has a box header on it.
 */
function metaChildOffset(bytes: Uint8Array, dataStart: number, dataEnd: number): number {
  if (dataStart + 8 <= dataEnd && isPrintableType(asciiAt(bytes, dataStart + 4, 4))) {
    return dataStart;
  }
  return dataStart + 4;
}

/** Depth-first walk. `visit` gets each box's type and its payload slice. */
export function walkMp4(
  bytes: Uint8Array,
  visit: (type: string, data: Uint8Array) => void,
  offset = 0,
  end = bytes.length,
): void {
  let i = offset;
  while (i + 8 <= end) {
    const header = readBoxHeader(bytes, i, end);
    if (!header) break;
    const { type, size, headerBytes } = header;
    if (size < headerBytes || i + size > end) break;

    const dataStart = i + headerBytes;
    const dataEnd = i + size;
    visit(type, bytes.subarray(dataStart, dataEnd));

    if (CONTAINER_BOXES.has(type)) {
      walkMp4(bytes, visit, dataStart, dataEnd);
    } else if (type === "meta") {
      walkMp4(bytes, visit, metaChildOffset(bytes, dataStart, dataEnd), dataEnd);
    } else if (type === "stsd") {
      // version/flags + entry count, then the sample entries as boxes.
      if (dataEnd - dataStart >= 8) walkMp4(bytes, visit, dataStart + 8, dataEnd);
    }

    i += size;
  }
}

export function looksLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const type = asciiAt(bytes, 4, 4);
  return (
    type === "ftyp" || type === "moov" || type === "mdat" || type === "free" || type === "wide"
  );
}

/**
 * Byte range of a top-level box, found by hopping header to header.
 *
 * iPhone writes `ftyp` / `wide` / `mdat` / `moov`, so everything worth reading
 * is behind the samples — a head-only read finds nothing at all. Hopping costs
 * one small slice per top-level box, four or five in practice, instead of
 * pulling the file in to search it.
 */
export async function findTopLevelBox(
  blob: Blob,
  wanted: string,
): Promise<{ start: number; size: number } | null> {
  let pos = 0;
  while (pos + 8 <= blob.size) {
    const header = readBoxHeader(
      new Uint8Array(await blob.slice(pos, Math.min(pos + 16, blob.size)).arrayBuffer()),
      0,
      Math.min(16, blob.size - pos),
    );
    if (!header) return null;
    const { size } = header;
    if (size < header.headerBytes || pos + size > blob.size) return null;
    if (header.type === wanted) return { start: pos, size };
    pos += size;
  }
  return null;
}
