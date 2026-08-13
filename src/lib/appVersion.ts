/** Shown on the empty screen and next to fps. Keep in lockstep with package.json. */
export const APP_VERSION = "0.0.1";
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
/** Wordmark on the drop screen — zero, not o. */
export const APP_MARK = "visi0";
export const AUTHOR_HANDLE = "arthew0";
export const AUTHOR_FULL = "Alexey Roudenko";
export const WELCOME_HINT = "drop vertical video or image here...";
export const WELCOME_TEMPLATE_LABEL = "use template";
export const WELCOME_DESKTOP_NOTE = "works even better on desktop for now";
/** Empty-graph + where the Output node / right preview will sit. */
export const WELCOME_PLUS_LABEL = "+";
/** Portrait / iPhone empty screen — under the template link, thumb reach. */
export const WELCOME_CAMERA_LABEL = "enable camera";

export function welcomeCameraParams(): {
  mode: "camera";
  facing: "user";
  mirror: true;
} {
  return { mode: "camera", facing: "user", mirror: true };
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
    APP_VERSION_LABEL,
    `by ${AUTHOR_HANDLE} (${AUTHOR_FULL})`,
    WELCOME_HINT,
    WELCOME_TEMPLATE_LABEL,
    WELCOME_DESKTOP_NOTE,
  ].join("\n");
}
