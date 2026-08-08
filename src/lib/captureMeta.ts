/**
 * When and where a clip was shot, read out of the `moov` box.
 *
 * Three sources, in descending order of trust:
 *  1. Apple's `keys` + `ilst` metadata (`com.apple.quicktime.*`) — the only one
 *     that carries a timezone offset and a GPS fix.
 *  2. Legacy QuickTime user-data atoms (`©day`, `©xyz`, `©mak`, `©mod`).
 *  3. `mvhd` creation_time — present in every file and therefore the fallback,
 *     but it is nominally UTC and cameras habitually write local time into it,
 *     so it is only used when nothing better turned up.
 */
import { asciiAt, readI32, readU32, readU64, walkMp4 } from "./mp4Boxes";

export interface CaptureMeta {
  /** ISO 8601 as recorded, offset included when the file knew one. */
  capturedAt: string | null;
  /** True when `capturedAt` came from a source that states its timezone. */
  capturedAtHasZone: boolean;
  latitude: number | null;
  longitude: number | null;
  altitudeM: number | null;
  make: string | null;
  model: string | null;
  software: string | null;
  lensModel: string | null;
  /** Track matrix rotation in degrees, 0 / 90 / 180 / 270. */
  rotationDeg: number | null;
}

export function emptyCaptureMeta(): CaptureMeta {
  return {
    capturedAt: null,
    capturedAtHasZone: false,
    latitude: null,
    longitude: null,
    altitudeM: null,
    make: null,
    model: null,
    software: null,
    lensModel: null,
    rotationDeg: null,
  };
}

/** Seconds since 1904-01-01 UTC, the epoch ISO-BMFF inherited from QuickTime. */
const MP4_EPOCH_OFFSET_SEC = 2_082_844_800;

/** `null` for the zero value and for anything that lands outside living memory. */
export function mp4EpochToIso(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = (seconds - MP4_EPOCH_OFFSET_SEC) * 1000;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(ms) || year < 1970 || year > 2200) return null;
  return date.toISOString();
}

/**
 * ISO 6709 as Apple writes it: `+55.7043+037.6393+141.339/`, signed decimal
 * degrees with an optional altitude. The sexagesimal forms the standard also
 * allows do not appear in camera output, and guessing at them would turn a
 * missing fix into a wrong one.
 */
export function parseIso6709(
  raw: string,
): { latitude: number; longitude: number; altitudeM: number | null } | null {
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/.exec(raw.trim());
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const altitude = match[3] != null ? Number(match[3]) : null;
  return {
    latitude,
    longitude,
    altitudeM: altitude != null && Number.isFinite(altitude) ? altitude : null,
  };
}

/**
 * Rotation from the first two 16.16 fixed-point entries of a track matrix.
 * Snapped to the quarter turns a camera actually writes.
 */
export function rotationFromMatrix(a: number, b: number): number {
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  const snapped = Math.round(degrees / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/\0+$/, "").trim();
}

/** `keys`: version/flags, count, then `size + namespace + name` per entry. */
function parseKeys(data: Uint8Array): string[] {
  const keys: string[] = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const size = readU32(data, offset);
    if (size < 8 || offset + size > data.length) break;
    keys.push(decodeUtf8(data.subarray(offset + 8, offset + size)));
    offset += size;
  }
  return keys;
}

/**
 * `ilst`: entries keyed by a 1-based index into `keys`, each wrapping a `data`
 * box whose type indicator says how to read the payload.
 */
function parseIlst(data: Uint8Array, keys: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset + 8 <= data.length) {
    const size = readU32(data, offset);
    const index = readU32(data, offset + 4);
    if (size < 8 || offset + size > data.length) break;

    const name = keys[index - 1];
    if (name) {
      const inner = data.subarray(offset + 8, offset + size);
      const value = readDataBox(inner);
      if (value != null) values.set(name, value);
    }
    offset += size;
  }
  return values;
}

function readDataBox(inner: Uint8Array): string | null {
  let offset = 0;
  while (offset + 16 <= inner.length) {
    const size = readU32(inner, offset);
    if (size < 16 || offset + size > inner.length) return null;
    if (asciiAt(inner, offset + 4, 4) !== "data") {
      offset += size;
      continue;
    }
    // 1 byte reserved + 3 bytes well-known type, then a 4-byte locale.
    const type = readU32(inner, offset + 8) & 0x00ffffff;
    const payload = inner.subarray(offset + 16, offset + size);
    switch (type) {
      case 1:
        return decodeUtf8(payload);
      case 21:
      case 22:
        return String(readIntPayload(payload, type === 21));
      case 23:
        return payload.length >= 4
          ? String(new DataView(payload.buffer, payload.byteOffset, 4).getFloat32(0, false))
          : null;
      case 24:
        return payload.length >= 8
          ? String(new DataView(payload.buffer, payload.byteOffset, 8).getFloat64(0, false))
          : null;
      default:
        return null;
    }
  }
  return null;
}

function readIntPayload(payload: Uint8Array, signed: boolean): number {
  let value = 0;
  for (const byte of payload) value = value * 256 + byte;
  if (signed && payload.length > 0 && (payload[0]! & 0x80) !== 0) {
    value -= 256 ** payload.length;
  }
  return value;
}

/** Legacy user-data text atom: 2-byte length + 2-byte language, then the text. */
function readUdtaText(data: Uint8Array): string | null {
  if (data.length <= 4) return null;
  const declared = (data[0]! << 8) | data[1]!;
  const end = declared > 0 && declared + 4 <= data.length ? 4 + declared : data.length;
  const text = decodeUtf8(data.subarray(4, end));
  return text || null;
}

const APPLE_KEYS = {
  creationDate: "com.apple.quicktime.creationdate",
  location: "com.apple.quicktime.location.ISO6709",
  make: "com.apple.quicktime.make",
  model: "com.apple.quicktime.model",
  software: "com.apple.quicktime.software",
  lens: "com.apple.quicktime.camera.lens_model",
} as const;

/** Reads a whole `moov` box, header included. */
export function readCaptureMeta(moov: Uint8Array): CaptureMeta {
  const meta = emptyCaptureMeta();
  // A `keys` table only indexes the `ilst` that follows it inside the same
  // `meta` box, and a file can carry one per track as well as one per movie.
  let pendingKeys: string[] = [];
  const tables: { keys: string[]; ilst: Uint8Array }[] = [];
  let mvhdSeconds: number | null = null;
  let legacyDate: string | null = null;
  let legacyLocation: string | null = null;

  walkMp4(moov, (type, data) => {
    switch (type) {
      case "keys":
        pendingKeys = parseKeys(data);
        break;
      case "ilst":
        if (pendingKeys.length > 0) tables.push({ keys: pendingKeys, ilst: data });
        break;
      case "mvhd":
        if (mvhdSeconds == null && data.length >= 12) {
          const version = data[0]!;
          mvhdSeconds = version === 1 ? readU64(data, 4) : readU32(data, 4);
        }
        break;
      case "tkhd": {
        // Audio and metadata tracks carry an identity matrix, so the first
        // non-zero rotation is the one the picture is stored with.
        const rotation = rotationFromTkhd(data);
        if (rotation != null && (meta.rotationDeg == null || meta.rotationDeg === 0)) {
          meta.rotationDeg = rotation;
        }
        break;
      }
      case "\u00A9day":
        legacyDate ??= readUdtaText(data);
        break;
      case "\u00A9xyz":
        legacyLocation ??= readUdtaText(data);
        break;
      case "\u00A9mak":
        meta.make ??= readUdtaText(data);
        break;
      case "\u00A9mod":
        meta.model ??= readUdtaText(data);
        break;
      case "\u00A9swr":
        meta.software ??= readUdtaText(data);
        break;
      default:
        break;
    }
  });

  const apple = new Map<string, string>();
  for (const table of tables) {
    for (const [key, value] of parseIlst(table.ilst, table.keys)) {
      if (!apple.has(key)) apple.set(key, value);
    }
  }

  const appleDate = apple.get(APPLE_KEYS.creationDate);
  if (appleDate) {
    meta.capturedAt = appleDate;
    meta.capturedAtHasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(appleDate);
  } else if (legacyDate) {
    meta.capturedAt = legacyDate;
    meta.capturedAtHasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(legacyDate);
  } else if (mvhdSeconds != null) {
    meta.capturedAt = mp4EpochToIso(mvhdSeconds);
    meta.capturedAtHasZone = false;
  }

  const rawLocation = apple.get(APPLE_KEYS.location) ?? legacyLocation;
  if (rawLocation) {
    const fix = parseIso6709(rawLocation);
    if (fix) {
      meta.latitude = fix.latitude;
      meta.longitude = fix.longitude;
      meta.altitudeM = fix.altitudeM;
    }
  }

  meta.make = apple.get(APPLE_KEYS.make) ?? meta.make;
  meta.model = apple.get(APPLE_KEYS.model) ?? meta.model;
  meta.software = apple.get(APPLE_KEYS.software) ?? meta.software;
  meta.lensModel = apple.get(APPLE_KEYS.lens) ?? meta.lensModel;

  return meta;
}

/**
 * The matrix sits at a fixed offset from the end of the variable-length part of
 * `tkhd`, which is 8 bytes longer in version 1.
 */
function rotationFromTkhd(data: Uint8Array): number | null {
  const version = data[0]!;
  const matrixOffset = version === 1 ? 52 : 40;
  if (data.length < matrixOffset + 36) return null;
  const a = readI32(data, matrixOffset) / 65536;
  const b = readI32(data, matrixOffset + 4) / 65536;
  if (a === 0 && b === 0) return null;
  return rotationFromMatrix(a, b);
}
