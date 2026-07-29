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

/** Bundled starter still — served from Vite `public/`. */
export const DEFAULT_IMAGE_FILE: FileParam = {
  name: "default-frame.png",
  url: `${import.meta.env.BASE_URL}default-frame.png`,
};
