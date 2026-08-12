/**
 * Best-effort media metadata from a blob:/http: URL.
 *
 * The browser does not expose codec/bitrate from HTMLVideoElement, so we:
 *  - read the file head and sniff MP4 / WebM / Ogg / RIFF containers
 *  - locate `moov` wherever it sits and read codecs plus capture metadata
 *  - estimate overall bitrate from byte size ÷ duration
 *  - pull sample-rate / channels from a decoded AudioBuffer when available
 */
import { emptyCaptureMeta, readCaptureMeta, type CaptureMeta } from "./captureMeta";
import { asciiAt, findTopLevelBox, looksLikeMp4, walkMp4 } from "./mp4Boxes";

export interface MediaMeta {
  sizeBytes: number | null;
  /** Overall average bitrate from size/duration, bits per second. */
  bitrateBps: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** When / where / on what it was shot; all-null until the probe lands. */
  capture: CaptureMeta;
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
  capture: emptyCaptureMeta(),
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const blob = await res.blob();
    if (meta.sizeBytes == null && blob.size > 0) meta.sizeBytes = blob.size;

    // The head answers "what kind of file is this" for every format we know.
    const head = new Uint8Array(
      await blob.slice(0, Math.min(blob.size, HEAD_BYTES)).arrayBuffer(),
    );
    Object.assign(meta, sniffContainer(head, meta));

    // Everything else about an MP4 lives in `moov`, which a phone writes after
    // the samples — reading only the head finds the brand and nothing more.
    if (looksLikeMp4(head)) {
      const found = await findTopLevelBox(blob, "moov");
      if (found) {
        const moov = new Uint8Array(
          await blob.slice(found.start, found.start + found.size).arrayBuffer(),
        );
        Object.assign(meta, sniffMp4(moov, meta));
        meta.capture = readCaptureMeta(moov);
      }
    }
    entry.status = "ready";
  } catch {
    entry.status = "error";
  }
}

function containerFromMime(mime: string): string | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.includes("quicktime")) return "mov";
  if (base.includes("mp4") || base.includes("m4a")) return "mp4";
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

  // A brand is a stronger statement than the MIME type the browser guessed, so
  // it wins when present. Walking `moov` finds no brands and keeps the earlier
  // answer.
  const brandContainer = brands.some((b) => /^m4a$/i.test(b))
    ? "m4a"
    : brands.some((b) => /^qt$/i.test(b))
      ? "mov"
      : brands.length > 0
        ? "mp4"
        : null;

  return {
    container: brandContainer ?? prior.container ?? "mp4",
    videoCodec,
    audioCodec,
  };
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
