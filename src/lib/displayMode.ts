/**
 * Standalone detection lives apart from `pwa.ts` so analytics can ask the
 * question without importing the install machinery (and creating a cycle).
 */

/** True in a home-screen / installed window, false in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches;
  // Safari predates display-mode and still only exposes this legacy flag.
  const legacy = (navigator as { standalone?: boolean }).standalone === true;
  return Boolean(displayMode || legacy);
}
