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

/**
 * Which Media mode a file belongs in. The extension is the fallback because a
 * drag from the desktop often arrives with an empty `type` (Windows has no MIME
 * for `.mov`, and some file managers send none at all).
 */
export function mediaKind(file: File): MediaKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  const lower = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/.test(lower)) return "image";
  if (/\.(mp4|webm|mov|m4v|ogg)$/.test(lower)) return "video";
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(lower)) return "audio";
  return null;
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

/** Stock audio shown in the Media inspector library (audio mode). */
export const BUNDLED_AUDIO_FILES: readonly { file: FileParam; label: string }[] = [
  { file: DEFAULT_AUDIO_FILE, label: "Track 4" },
  { file: EXAMPLE_AUDIO_03_FILE, label: "Track 3" },
  { file: EXAMPLE_AUDIO_02_FILE, label: "Track 2" },
  { file: EXAMPLE_AUDIO_01_FILE, label: "Track 1" },
];
