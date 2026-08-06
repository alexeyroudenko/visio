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

/** Stock images shown in the Media inspector library. */
export const BUNDLED_IMAGE_FILES: readonly { file: FileParam; label: string }[] = [
  { file: DEFAULT_IMAGE_FILE, label: "Frame" },
  { file: POSE_IMAGE_FILE, label: "Pose" },
  { file: FACE_IMAGE_FILE, label: "Face" },
];

/** Stock audio shown in the Media inspector library (audio mode). */
export const BUNDLED_AUDIO_FILES: readonly { file: FileParam; label: string }[] = [
  { file: DEFAULT_AUDIO_FILE, label: "Track 4" },
  { file: EXAMPLE_AUDIO_03_FILE, label: "Track 3" },
  { file: EXAMPLE_AUDIO_02_FILE, label: "Track 2" },
  { file: EXAMPLE_AUDIO_01_FILE, label: "Track 1" },
];
