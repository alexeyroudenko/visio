/**
 * Persist dropped Media files so a restore-on-reload can revive blob: URLs.
 * When Reset-on-visit is on, boot clears the store instead.
 */

import type { FileParam } from "../nodes/shared/fileParam";

const DB_NAME = "visio.mediaFiles.v1";
const DB_VERSION = 1;
const STORE = "files";

export type StoredMediaMode = "image" | "video" | "audio";

export interface StoredMediaFile {
  mode: StoredMediaMode;
  name: string;
  mime: string;
  sizeBytes: number;
  blob: Blob;
  /** When this entry was last written. */
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "mode" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

export async function putMediaFile(record: StoredMediaFile): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).put(record));
  } finally {
    db.close();
  }
}

export async function getMediaFile(mode: StoredMediaMode): Promise<StoredMediaFile | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const row = await idbReq(tx.objectStore(STORE).get(mode));
    return (row as StoredMediaFile | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function getAllMediaFiles(): Promise<StoredMediaFile[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const rows = await idbReq(tx.objectStore(STORE).getAll());
    return (rows as StoredMediaFile[]) ?? [];
  } finally {
    db.close();
  }
}

export async function deleteMediaFile(mode: StoredMediaMode): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).delete(mode));
  } finally {
    db.close();
  }
}

/** Drop every stored file. Used when Reset-on-visit is on, and by Reset. */
export async function clearAllMediaFiles(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).clear());
  } finally {
    db.close();
  }
}

/** Turn a live FileParam (usually a blob: URL) into an IndexedDB row. */
export async function persistFileParam(
  mode: StoredMediaMode,
  file: FileParam,
  fileObj?: File | null,
): Promise<StoredMediaFile | null> {
  // Only blob: URLs need this — http(s)/public paths already survive a reload
  // via the saved patch. test:// etc. are selftest fixtures.
  if (!file.url.startsWith("blob:")) return null;

  let blob: Blob;
  let mime = file.mime ?? "";
  let sizeBytes = file.sizeBytes ?? 0;

  if (fileObj) {
    blob = fileObj;
    mime = fileObj.type || mime;
    sizeBytes = fileObj.size || sizeBytes;
  } else {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`persist fetch ${res.status}`);
    blob = await res.blob();
    mime = mime || blob.type;
    sizeBytes = sizeBytes || blob.size;
  }

  const record: StoredMediaFile = {
    mode,
    name: file.name,
    mime,
    sizeBytes,
    blob,
    savedAt: Date.now(),
  };
  await putMediaFile(record);
  return record;
}

/** Rebuild a FileParam + File from a stored row. */
export function reviveStoredFile(record: StoredMediaFile): {
  param: FileParam;
  fileObj: File;
} {
  const fileObj = new File([record.blob], record.name, {
    type: record.mime || record.blob.type || undefined,
    lastModified: record.savedAt,
  });
  const param: FileParam = {
    name: record.name,
    url: URL.createObjectURL(fileObj),
    mime: record.mime || fileObj.type || undefined,
    sizeBytes: record.sizeBytes || fileObj.size,
  };
  return { param, fileObj };
}
