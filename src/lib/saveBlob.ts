/**
 * Save a Blob as a real file — not a `blob:` URL string.
 *
 * Instagram / Facebook / TikTok in-app browsers ignore `<a download>` for
 * blob: links and often hand the literal `blob:https://…` string to Share /
 * Messages. Prefer the Web Share Level-2 file API there so the bytes leave
 * the tab; fall back to a classic download anchor elsewhere.
 */

export type SaveBlobResult = "shared" | "downloaded";

/** UA patterns for webviews that break blob downloads into a URL string. */
const RESTRICTED_IN_APP_UA =
  /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|Line\/|TikTok|BytedanceWebview|Snapchat|Twitter|LinkedInApp|Pinterest|MicroMessenger/i;

export function isRestrictedInAppBrowser(
  ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  if (RESTRICTED_IN_APP_UA.test(ua)) return true;
  // Android System WebView marker when not Chrome/Firefox/Edge/Samsung.
  if (/\bwv\b/.test(ua) && /Android/i.test(ua) && !/Chrome\/\d|Firefox\/\d|EdgA\/\d|SamsungBrowser/i.test(ua)) {
    return true;
  }
  return false;
}

function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function asFile(blob: Blob, filename: string): File {
  if (typeof File !== "undefined" && blob instanceof File && blob.name === filename) {
    return blob;
  }
  const type = blob.type || mimeFromFilename(filename);
  return new File([blob], filename, { type });
}

function canShareFiles(file: File): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  const canShare = navigator.canShare;
  if (typeof canShare !== "function") return false;
  try {
    return canShare.call(navigator, { files: [file] });
  } catch {
    return false;
  }
}

function triggerAnchorDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  // Some WebViews ignore clicks on detached anchors.
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Persist `blob` under `filename`.
 *
 * In restricted in-app browsers, shares the File when the UA supports it so
 * the recipient gets video bytes instead of a dead `blob:` string. Elsewhere
 * triggers a normal download. User-cancelled share throws `AbortError`.
 */
export async function saveBlob(blob: Blob, filename: string): Promise<SaveBlobResult> {
  if (blob.size === 0) {
    throw new Error("empty file — nothing to save");
  }

  const file = asFile(blob, filename);
  const preferShare = isRestrictedInAppBrowser();

  if (preferShare) {
    if (canShareFiles(file)) {
      try {
        await navigator.share({ files: [file], title: filename });
        return "shared";
      } catch (error) {
        // User dismissed the sheet — do not fall through to a broken blob download.
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new Error(
          "Could not share the file from this in-app browser. Open visio in Safari or Chrome (⋯ → Open in browser), then try again.",
        );
      }
    }
    throw new Error(
      "This in-app browser cannot save files. Open visio in Safari or Chrome (⋯ → Open in browser), then try again.",
    );
  }

  triggerAnchorDownload(blob, filename);
  return "downloaded";
}
