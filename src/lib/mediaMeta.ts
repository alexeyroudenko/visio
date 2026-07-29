/**
 * Best-effort media metadata from a blob:/http: URL.
 *
 * The browser does not expose codec/bitrate from HTMLVideoElement, so we:
 *  - read the file head and sniff MP4 / WebM / Ogg / RIFF containers
 *  - estimate overall bitrate from byte size ÷ duration
 *  - pull sample-rate / channels from a decoded AudioBuffer when available
 */

export interface MediaMeta {
  sizeBytes: number | null;
  /** Overall average bitrate from size/duration, bits per second. */
  bitrateBps: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
}

interface CacheEntry {
  meta: MediaMeta;
  status: "loading" | "ready" | "error";
}

const HEAD_BYTES = 4 * 1024 * 1024;
const cache = new Map<string, CacheEntry>();

const emptyMeta = (): MediaMeta => ({
  sizeBytes: null,
  bitrateBps: null,
  container: null,
  videoCodec: null,
  audioCodec: null,
  sampleRate: null,
  channels: null,
});

/** Sync peek — whatever we already know; kicks off a fetch if needed. */
export function ensureMediaMeta(
  url: string,
  hints?: { sizeBytes?: number | null; mime?: string | null },
): MediaMeta {
  const existing = cache.get(url);
  if (existing) {
    if (hints?.sizeBytes != null && existing.meta.sizeBytes == null) {
      existing.meta.sizeBytes = hints.sizeBytes;
    }
    return existing.meta;
  }

  const meta = emptyMeta();
  if (hints?.sizeBytes != null && hints.sizeBytes > 0) meta.sizeBytes = hints.sizeBytes;
  if (hints?.mime) {
    const fromMime = codecsFromMime(hints.mime);
    meta.container = fromMime.container ?? containerFromMime(hints.mime);
    meta.videoCodec = fromMime.videoCodec;
    meta.audioCodec = fromMime.audioCodec;
  }
  cache.set(url, { meta, status: "loading" });
  void probeUrl(url, meta);
  return meta;
}

/** Attach decoded-audio facts once `ensureAudioBuffer` has them. */
export function enrichMediaMetaAudio(
  url: string,
  info: { sampleRate: number; channels: number },
): void {
  const entry = cache.get(url);
  if (!entry) return;
  entry.meta.sampleRate = info.sampleRate;
  entry.meta.channels = info.channels;
}

/** Fill bitrate once duration is known (seconds). */
export function enrichMediaMetaDuration(url: string, durationSec: number): void {
  const entry = cache.get(url);
  if (!entry || !(durationSec > 0) || entry.meta.sizeBytes == null) return;
  entry.meta.bitrateBps = Math.round((entry.meta.sizeBytes * 8) / durationSec);
}

export function forgetMediaMeta(url: string): void {
  cache.delete(url);
}

async function probeUrl(url: string, meta: MediaMeta): Promise<void> {
  const entry = cache.get(url);
  if (!entry) return;
  try {
    const head = await readHead(url, HEAD_BYTES);
    if (meta.sizeBytes == null) {
      // Full size when the response told us; otherwise leave the File hint.
      const full = await tryContentLength(url);
      if (full != null) meta.sizeBytes = full;
      else if (head.complete) meta.sizeBytes = head.bytes.byteLength;
    }
    Object.assign(meta, sniffContainer(head.bytes, meta));
    entry.status = "ready";
  } catch {
    entry.status = "error";
  }
}

async function tryContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const len = res.headers.get("content-length");
    if (len) {
      const n = Number(len);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // blob: often has no HEAD — fall through
  }
  return null;
}

async function readHead(
  url: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const blob = await res.blob();
  const complete = blob.size <= maxBytes;
  const slice = complete ? blob : blob.slice(0, maxBytes);
  return { bytes: new Uint8Array(await slice.arrayBuffer()), complete };
}

function containerFromMime(mime: string): string | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.includes("mp4") || base.includes("quicktime") || base.includes("m4a")) return "mp4";
  if (base.includes("webm")) return "webm";
  if (base.includes("ogg")) return "ogg";
  if (base.includes("wav")) return "wav";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("png")) return "png";
  if (base.includes("jpeg") || base.includes("jpg")) return "jpeg";
  if (base.includes("webp")) return "webp";
  if (base.includes("gif")) return "gif";
  return base.split("/")[1] ?? null;
}

function codecsFromMime(mime: string): {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
} {
  const container = containerFromMime(mime);
  const match = /codecs=([^;]+)/i.exec(mime);
  if (!match?.[1]) return { container, videoCodec: null, audioCodec: null };
  const list = match[1]
    .replace(/"/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  for (const c of list) {
    const lower = c.toLowerCase();
    if (
      lower.startsWith("avc") ||
      lower.startsWith("hev") ||
      lower.startsWith("hvc") ||
      lower.startsWith("av01") ||
      lower.startsWith("vp8") ||
      lower.startsWith("vp9") ||
      lower.startsWith("vp09")
    ) {
      videoCodec = prettyCodec(c);
    } else if (
      lower.startsWith("mp4a") ||
      lower.includes("opus") ||
      lower.includes("vorbis") ||
      lower.includes("flac") ||
      lower.startsWith("ac-3") ||
      lower.startsWith("ec-3")
    ) {
      audioCodec = prettyCodec(c);
    }
  }
  return { container, videoCodec, audioCodec };
}

function sniffContainer(bytes: Uint8Array, prior: MediaMeta): Partial<MediaMeta> {
  if (bytes.length < 12) return {};
  // ISO BMFF (mp4 / mov / m4a)
  if (looksLikeMp4(bytes)) return sniffMp4(bytes, prior);
  // EBML / WebM / MKV
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return sniffWebm(bytes, prior);
  }
  // Ogg
  if (asciiAt(bytes, 0, 4) === "OggS") {
    return {
      container: prior.container ?? "ogg",
      audioCodec: prior.audioCodec ?? sniffOggCodec(bytes),
    };
  }
  // RIFF / WAV / AVI
  if (asciiAt(bytes, 0, 4) === "RIFF") {
    const form = asciiAt(bytes, 8, 4);
    if (form === "WAVE") {
      return { container: "wav", audioCodec: prior.audioCodec ?? sniffWavCodec(bytes) };
    }
    if (form === "AVI ") {
      return { container: "avi", videoCodec: prior.videoCodec ?? sniffAviCodec(bytes) };
    }
  }
  // ID3 / MP3
  if (asciiAt(bytes, 0, 3) === "ID3" || isMp3Frame(bytes)) {
    return { container: prior.container ?? "mp3", audioCodec: prior.audioCodec ?? "mp3" };
  }
  // PNG / JPEG / WebP / GIF
  if (bytes[0] === 0x89 && asciiAt(bytes, 1, 3) === "PNG") {
    return { container: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { container: "jpeg" };
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
    return { container: "webp" };
  }
  if (asciiAt(bytes, 0, 3) === "GIF") return { container: "gif" };

  return {};
}

function looksLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const type = asciiAt(bytes, 4, 4);
  return type === "ftyp" || type === "moov" || type === "mdat" || type === "free" || type === "wide";
}

function sniffMp4(bytes: Uint8Array, prior: MediaMeta): Partial<MediaMeta> {
  const brands: string[] = [];
  let videoCodec = prior.videoCodec;
  let audioCodec = prior.audioCodec;

  walkMp4(bytes, (type, data) => {
    if (type === "ftyp" && data.length >= 4) {
      brands.push(asciiAt(data, 0, 4).trim());
      for (let i = 8; i + 4 <= data.length; i += 4) {
        const b = asciiAt(data, i, 4).trim();
        if (b) brands.push(b);
      }
    }
    // Sample entries live under stsd; their type is the codec fourcc.
    if (type === "stsd" && data.length >= 16) {
      // version/flags (4) + entry_count (4) + first entry size (4) + type (4)
      const entryType = asciiAt(data, 12, 4);
      const mapped = mapSampleEntry(entryType);
      if (mapped.kind === "video" && !videoCodec) videoCodec = mapped.label;
      if (mapped.kind === "audio" && !audioCodec) audioCodec = mapped.label;
    }
    // Also catch fourccs that appear as box types deeper in the tree.
    const mapped = mapSampleEntry(type);
    if (mapped.kind === "video" && !videoCodec) videoCodec = mapped.label;
    if (mapped.kind === "audio" && !audioCodec) audioCodec = mapped.label;
  });

  const container =
    prior.container ??
    (brands.some((b) => /m4a|M4A/.test(b))
      ? "m4a"
      : brands.some((b) => /qt|QuickTime/i.test(b))
        ? "mov"
        : "mp4");

  return { container, videoCodec, audioCodec };
}

function walkMp4(
  bytes: Uint8Array,
  visit: (type: string, data: Uint8Array) => void,
  offset = 0,
  end = bytes.length,
): void {
  let i = offset;
  while (i + 8 <= end) {
    const size32 = readU32(bytes, i);
    const type = asciiAt(bytes, i + 4, 4);
    let header = 8;
    let size = size32;
    if (size32 === 1) {
      if (i + 16 > end) break;
      size = readU32(bytes, i + 8) * 0x100000000 + readU32(bytes, i + 12);
      header = 16;
    } else if (size32 === 0) {
      size = end - i;
    }
    if (size < header || i + size > end) break;

    const dataStart = i + header;
    const dataEnd = i + size;
    const data = bytes.subarray(dataStart, dataEnd);
    visit(type, data);

    // Boxes that contain other boxes.
    if (
      type === "moov" ||
      type === "trak" ||
      type === "mdia" ||
      type === "minf" ||
      type === "stbl" ||
      type === "edts" ||
      type === "udta" ||
      type === "meta" ||
      type === "dinf"
    ) {
      walkMp4(bytes, visit, dataStart, dataEnd);
    } else if (type === "stsd") {
      // stsd: version/flags + count, then sample entries (each a box).
      if (data.length >= 8) walkMp4(bytes, visit, dataStart + 8, dataEnd);
    }

    i += size;
  }
}

function mapSampleEntry(fourcc: string): { kind: "video" | "audio" | null; label: string | null } {
  switch (fourcc) {
    case "avc1":
    case "avc3":
    case "avc2":
    case "avc4":
      return { kind: "video", label: "H.264 / AVC" };
    case "hvc1":
    case "hev1":
      return { kind: "video", label: "H.265 / HEVC" };
    case "av01":
      return { kind: "video", label: "AV1" };
    case "vp09":
      return { kind: "video", label: "VP9" };
    case "vp08":
      return { kind: "video", label: "VP8" };
    case "mp4v":
      return { kind: "video", label: "MPEG-4 Visual" };
    case "mp4a":
      return { kind: "audio", label: "AAC" };
    case "Opus":
      return { kind: "audio", label: "Opus" };
    case "fLaC":
      return { kind: "audio", label: "FLAC" };
    case "ac-3":
      return { kind: "audio", label: "AC-3" };
    case "ec-3":
      return { kind: "audio", label: "E-AC-3" };
    case "alac":
      return { kind: "audio", label: "ALAC" };
    case "sowt":
    case "twos":
    case "raw ":
    case "lpcm":
      return { kind: "audio", label: "PCM" };
    default:
      return { kind: null, label: null };
  }
}

function sniffWebm(bytes: Uint8Array, prior: MediaMeta): Partial<MediaMeta> {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 512 * 1024)));
  let videoCodec = prior.videoCodec;
  let audioCodec = prior.audioCodec;
  const find = (id: string, label: string, kind: "video" | "audio") => {
    if (text.includes(id)) {
      if (kind === "video" && !videoCodec) videoCodec = label;
      if (kind === "audio" && !audioCodec) audioCodec = label;
    }
  };
  find("V_MPEG4/ISO/AVC", "H.264 / AVC", "video");
  find("V_MPEGH/ISO/HEVC", "H.265 / HEVC", "video");
  find("V_AV1", "AV1", "video");
  find("V_VP9", "VP9", "video");
  find("V_VP8", "VP8", "video");
  find("A_OPUS", "Opus", "audio");
  find("A_VORBIS", "Vorbis", "audio");
  find("A_AAC", "AAC", "audio");
  find("A_FLAC", "FLAC", "audio");
  find("A_PCM", "PCM", "audio");
  return { container: prior.container ?? "webm", videoCodec, audioCodec };
}

function sniffOggCodec(bytes: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  if (text.includes("OpusHead")) return "Opus";
  if (text.includes("vorbis")) return "Vorbis";
  if (text.includes("FLAC")) return "FLAC";
  if (text.includes("theora")) return "Theora";
  return null;
}

function sniffWavCodec(bytes: Uint8Array): string | null {
  // fmt chunk audio format at offset after 'fmt '
  for (let i = 12; i + 8 < bytes.length; i += 1) {
    if (asciiAt(bytes, i, 4) !== "fmt ") continue;
    const format = bytes[i + 8]! | (bytes[i + 9]! << 8);
    if (format === 1) return "PCM";
    if (format === 3) return "IEEE float";
    if (format === 0xfffe) return "extensible";
    return `format ${format}`;
  }
  return "PCM";
}

function sniffAviCodec(bytes: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
  for (const tag of ["H264", "X264", "avc1", "HEVC", "hvc1", "MJPG", "DIVX", "XVID", "VP80", "VP90"]) {
    if (text.includes(tag)) return prettyCodec(tag);
  }
  return null;
}

function isMp3Frame(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

function prettyCodec(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.startsWith("avc") || lower === "h264" || lower === "x264") return "H.264 / AVC";
  if (lower.startsWith("hev") || lower.startsWith("hvc") || lower === "hevc") return "H.265 / HEVC";
  if (lower.startsWith("av01") || lower === "av1") return "AV1";
  if (lower.startsWith("vp09") || lower === "vp9" || lower === "vp90") return "VP9";
  if (lower.startsWith("vp08") || lower === "vp8" || lower === "vp80") return "VP8";
  if (lower.startsWith("mp4a")) return "AAC";
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("vorbis")) return "Vorbis";
  if (lower.includes("flac")) return "FLAC";
  if (lower === "mjpg" || lower === "mjpeg") return "MJPEG";
  return raw;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const c = bytes[offset + i];
    if (c == null) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatBitrate(bps: number): string {
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(0)} kbps`;
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}
