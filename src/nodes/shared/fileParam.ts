import { IMAGE_LIBRARY_FILES } from "virtual:image-library";

/** The UI stores a picked / dropped file as this shape (blob: or public URL). */
export interface FileParam {
  name: string;
  url: string;
  /** MIME from the File picker when available. */
  mime?: string;
  /** Byte length from the File picker when available. */
  sizeBytes?: number;
  /**
   * Transient File for IndexedDB persistence and re-filling the Inspector
   * input after restore. Never written to localStorage / patch JSON.
   */
  fileObj?: File;
}

export function fileParam(params: Record<string, unknown>, key = "file"): FileParam | null {
  const value = params[key];
  if (value && typeof value === "object" && typeof (value as FileParam).url === "string") {
    return value as FileParam;
  }
  return null;
}

export type MediaKind = "image" | "video" | "audio";

/** Dev/preview endpoint that reads a local media file off disk. */
export const LOCAL_FILE_ENDPOINT = "/__visio/local-file";

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const VIDEO_NAME = /\.(mp4|webm|mov|m4v|ogg)$/i;
const AUDIO_NAME = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;

const MIME_FROM_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogg: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
};

/** Strip Explorer "Copy as path" quotes and surrounding whitespace. */
export function normalizeMediaPath(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

export function mediaPathLeaf(value: string): string {
  const stripped = value.replace(/[\\/]+$/, "");
  const parts = stripped.split(/[\\/]/);
  return parts[parts.length - 1] || stripped;
}

export function mimeFromName(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  return MIME_FROM_EXT[name.slice(dot + 1).toLowerCase()];
}

export function mediaKindFromName(name: string): MediaKind | null {
  if (IMAGE_NAME.test(name)) return "image";
  if (VIDEO_NAME.test(name)) return "video";
  if (AUDIO_NAME.test(name)) return "audio";
  return null;
}

/**
 * Absolute disk path (Windows drive, UNC, file://, POSIX home/volumes).
 * Site-relative URLs (`/imgs/foo.jpg`, `./clip.mp4`) stay URLs.
 */
export function isFilesystemPath(value: string): boolean {
  if (/^(https?:|blob:|data:)/i.test(value)) return false;
  if (/^file:/i.test(value)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  return /^\/(Users|home|Volumes|mnt|media|opt|var|tmp|private|data)\b/.test(value);
}

/** `file:///Y:/clip.mp4` → `Y:/clip.mp4`; POSIX file URLs keep the leading slash. */
export function fileUrlToPath(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return url;
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    return url;
  }
}

export function localFileRequestUrl(fsPath: string): string {
  return `${LOCAL_FILE_ENDPOINT}?path=${encodeURIComponent(fsPath)}`;
}

/**
 * Which Media mode a file belongs in. The extension is the fallback because a
 * drag from the desktop often arrives with an empty `type` (Windows has no MIME
 * for `.mov`, and some file managers send none at all).
 */
export function mediaKind(file: File): MediaKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return mediaKindFromName(file.name);
}

/** A picked / dropped File as a param. The blob URL lives until nothing recalls it. */
export function fileParamFromFile(file: File): FileParam {
  return {
    name: file.name,
    url: URL.createObjectURL(file),
    mime: file.type || undefined,
    sizeBytes: file.size,
    fileObj: file,
  };
}

function resolveFetchUrl(value: string): string {
  if (/^(https?:|blob:|data:)/i.test(value)) return value;
  try {
    return new URL(value, window.location.href).href;
  } catch {
    return value;
  }
}

async function fileParamFromResponse(response: Response, name: string, fallback: string): Promise<FileParam> {
  const headerType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (headerType.includes("html")) throw new Error(fallback);
  if (!response.ok) {
    const text = (await response.text()).trim().slice(0, 160);
    throw new Error(text || fallback);
  }
  const blob = await response.blob();
  const mime = headerType || mimeFromName(name) || blob.type;
  if (mime.includes("html")) throw new Error(fallback);
  const file = new File([blob], name, { type: mime || undefined });
  return fileParamFromFile(file);
}

/**
 * Open a pasted full path or URL as a Media file. Disk paths go through the
 * Vite `/__visio/local-file` endpoint (`npm run dev`); http(s) and site paths
 * are fetched. Explorer quotes are stripped.
 */
export async function fileParamFromPath(raw: string): Promise<FileParam> {
  const path = normalizeMediaPath(raw);
  if (!path) throw new Error("empty path");
  const fsPath = /^file:/i.test(path) ? fileUrlToPath(path) : path;
  const name = mediaPathLeaf(fsPath);
  if (!mediaKindFromName(name)) throw new Error("not an image, video or audio file");

  if (isFilesystemPath(path) || isFilesystemPath(fsPath)) {
    try {
      const response = await fetch(localFileRequestUrl(fsPath));
      return await fileParamFromResponse(
        response,
        name,
        "local files need npm run dev (or paste an http URL)",
      );
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("local files need npm run dev (or paste an http URL)");
      }
      throw error;
    }
  }

  try {
    const response = await fetch(resolveFetchUrl(path));
    return await fileParamFromResponse(response, name, `failed to load ${name}`);
  } catch (error) {
    // CORS / network — still try the URL as a direct <img>/<video> src.
    if (error instanceof TypeError) {
      return { name, url: resolveFetchUrl(path), mime: mimeFromName(name) };
    }
    throw error;
  }
}

function publicFile(name: string): FileParam {
  return {
    name,
    url: `${import.meta.env.BASE_URL}${name}`,
    mime: "image/png",
  };
}

/** Bundled starter still — served from Vite `public/`. */
export const DEFAULT_IMAGE_FILE: FileParam = publicFile("default-frame.png");

/** Full-body still for pose / hands / skeleton tracking demos. */
export const POSE_IMAGE_FILE: FileParam = publicFile("default-pose.png");

/** Close-up still for face-mesh tracking demos. */
export const FACE_IMAGE_FILE: FileParam = publicFile("default-face.png");

/** Bundled starter audio — served from Vite `public/`. */
export const DEFAULT_AUDIO_FILE: FileParam = {
  name: "default-audio.mp3",
  url: `${import.meta.env.BASE_URL}default-audio.mp3`,
  mime: "audio/mpeg",
};

/** Extra stock tracks for the Media inspector library. */
export const EXAMPLE_AUDIO_01_FILE: FileParam = {
  name: "example-audio-01.mp3",
  url: `${import.meta.env.BASE_URL}example-audio-01.mp3`,
  mime: "audio/mpeg",
};

export const EXAMPLE_AUDIO_02_FILE: FileParam = {
  name: "example-audio-02.mp3",
  url: `${import.meta.env.BASE_URL}example-audio-02.mp3`,
  mime: "audio/mpeg",
};

export const EXAMPLE_AUDIO_03_FILE: FileParam = {
  name: "example-audio-03.mp3",
  url: `${import.meta.env.BASE_URL}example-audio-03.mp3`,
  mime: "audio/mpeg",
};

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/**
 * Stock images shown in the Media inspector library — whatever sits in
 * `public/imgs`, listed by the imageLibrary Vite plugin.
 */
export const BUNDLED_IMAGE_FILES: readonly { file: FileParam; label: string }[] =
  IMAGE_LIBRARY_FILES.map((name) => {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return {
      file: {
        name,
        url: `${import.meta.env.BASE_URL}imgs/${encodeURIComponent(name)}`,
        mime: IMAGE_MIME[ext],
      },
      label: name.replace(/\.[^.]+$/, ""),
    };
  });

/**
 * A library still by file name, for presets that want a specific one. The
 * folder is the user's, so a missing name falls back rather than breaking the
 * patch: first the library's first image, then the bundled frame.
 */
export function libraryImage(name: string): FileParam {
  const match = BUNDLED_IMAGE_FILES.find((entry) => entry.file.name === name);
  return match?.file ?? BUNDLED_IMAGE_FILES[0]?.file ?? DEFAULT_IMAGE_FILE;
}

function bundledFileByName(name: string): FileParam | null {
  if (!name) return null;
  if (name === DEFAULT_IMAGE_FILE.name) return DEFAULT_IMAGE_FILE;
  if (name === POSE_IMAGE_FILE.name) return POSE_IMAGE_FILE;
  if (name === FACE_IMAGE_FILE.name) return FACE_IMAGE_FILE;
  if (name === DEFAULT_AUDIO_FILE.name) return DEFAULT_AUDIO_FILE;
  if (name === EXAMPLE_AUDIO_01_FILE.name) return EXAMPLE_AUDIO_01_FILE;
  if (name === EXAMPLE_AUDIO_02_FILE.name) return EXAMPLE_AUDIO_02_FILE;
  if (name === EXAMPLE_AUDIO_03_FILE.name) return EXAMPLE_AUDIO_03_FILE;
  const image = BUNDLED_IMAGE_FILES.find((entry) => entry.file.name === name);
  return image?.file ?? null;
}

/**
 * Rewrites a saved public file onto `BASE_URL`. Old patches baked root-absolute
 * `/imgs/…` / `/default-frame.png` when Vite's base was `/`; those 404 if the
 * app is ever served from a subpath. Name wins over URL so a library still
 * follows the folder even after a rename of the public prefix.
 */
export function resolveBundledFile(file: FileParam): FileParam {
  if (!file.url || file.url.startsWith("blob:") || file.url.startsWith("data:")) return file;
  if (/^https?:\/\//i.test(file.url)) return file;

  const byName = bundledFileByName(file.name);
  if (byName) {
    return { ...byName, ...(file.sizeBytes != null ? { sizeBytes: file.sizeBytes } : {}), fileObj: file.fileObj };
  }

  const path = file.url.replace(/^\.\//, "");
  if (!path.startsWith("/")) return file;
  const trimmed = path.slice(1);
  const leaf = decodeURIComponent(trimmed.replace(/^imgs\//, "").split("/").pop() ?? "");
  const byUrl = bundledFileByName(leaf);
  if (byUrl) {
    return { ...byUrl, ...(file.sizeBytes != null ? { sizeBytes: file.sizeBytes } : {}), fileObj: file.fileObj };
  }
  return { ...file, url: `${import.meta.env.BASE_URL}${trimmed}` };
}

/** Stock audio shown in the Media inspector library (audio mode). */
export const BUNDLED_AUDIO_FILES: readonly { file: FileParam; label: string }[] = [
  { file: DEFAULT_AUDIO_FILE, label: "Track 4" },
  { file: EXAMPLE_AUDIO_03_FILE, label: "Track 3" },
  { file: EXAMPLE_AUDIO_02_FILE, label: "Track 2" },
  { file: EXAMPLE_AUDIO_01_FILE, label: "Track 1" },
];
