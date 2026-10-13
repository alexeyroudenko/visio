import { GIT_TAG, GIT_TAG_AT } from "virtual:app-version";

/** Shown on the empty screen and next to fps. Comes from the latest git tag. */
export const APP_VERSION = GIT_TAG.replace(/^v/i, "");
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

/**
 * Compact stamp from the annotated tag date (`YYYY-MM-DD HH:mm` in the
 * tagger's offset). Empty when git tags are unavailable at build time.
 */
export function formatVersionAt(iso: string): string {
  const match = iso.trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!match) return "";
  return `${match[1]} ${match[2]}:${match[3]}`;
}

export const APP_VERSION_AT = formatVersionAt(GIT_TAG_AT);
/** Version plus tag time when known — toolbar / welcome / title card. */
export const APP_VERSION_DISPLAY = APP_VERSION_AT
  ? `${APP_VERSION_LABEL} · ${APP_VERSION_AT}`
  : APP_VERSION_LABEL;
/** Wordmark on the drop screen — zero, not o. */
export const APP_MARK = "visi0";
export const AUTHOR_HANDLE = "arthew0";
export const AUTHOR_FULL = "Alexey Roudenko";
export const WELCOME_HINT = "drop vertical video or image here...";
export const WELCOME_DESKTOP_NOTE = "works even better on desktop for now";
/** Empty-graph + where the Output node / right preview will sit. */
export const WELCOME_PLUS_LABEL = "+";
/** Label under the welcome + circle. */
export const WELCOME_UPLOAD_LABEL = "Upload video";
/** Portrait / iPhone empty screen — under the upload control, thumb reach. */
export const WELCOME_CAMERA_LABEL = "enable camera";
/** Portrait shutter: flip front ↔ back once camera is live. */
export const SWITCH_CAMERA_LABEL = "Switch camera";

export function welcomeCameraParams(): {
  mode: "camera";
  facing: "environment";
  mirror: false;
} {
  return { mode: "camera", facing: "environment", mirror: false };
}

/**
 * Credit link. UTMs so GA on the site tags the session as in-app;
 * `noopener` without `noreferrer` still sends the HTTP Referer as a fallback.
 */
export const AUTHOR_URL =
  "https://alexeyroudenko.net/?utm_source=visi0&utm_medium=app&utm_campaign=welcome";

/** Default copy for the Text node — same stack as the empty-screen overlay. */
export function welcomeText(): string {
  return [
    APP_MARK,
    APP_VERSION_DISPLAY,
    `by ${AUTHOR_HANDLE} (${AUTHOR_FULL})`,
    WELCOME_HINT,
    WELCOME_DESKTOP_NOTE,
  ].join("\n");
}
