import { isStandalone } from "./displayMode";

/**
 * Window sizing for the installed app.
 *
 * There is no manifest field for a preferred window size — the only lever is
 * `resizeTo`, and browsers honour it for installed / script-opened windows
 * only. In a tab every call here is a no-op.
 */

const FITTED_KEY = "visio.windowFitted";

export interface WindowBounds {
  width: number;
  height: number;
  left: number;
  top: number;
}

interface ScreenArea {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
}

/**
 * Outer bounds for a window showing a `patchW × patchH` canvas, centred and
 * shrunk to keep the patch aspect when it does not fit — 1080×1920 asks for
 * more height than a 1080p monitor has, and clamping only the tall axis would
 * leave the window the wrong shape.
 */
export function fitWindowBounds(
  patchW: number,
  patchH: number,
  screen: ScreenArea,
  chrome: { width: number; height: number },
): WindowBounds {
  const maxW = Math.max(1, screen.availWidth - chrome.width);
  const maxH = Math.max(1, screen.availHeight - chrome.height);
  const scale = Math.min(1, maxW / patchW, maxH / patchH);
  const width = Math.round(patchW * scale) + chrome.width;
  const height = Math.round(patchH * scale) + chrome.height;
  return {
    width,
    height,
    left: Math.round((screen.availLeft ?? 0) + (screen.availWidth - width) / 2),
    top: Math.round((screen.availTop ?? 0) + (screen.availHeight - height) / 2),
  };
}

/** Returns false when the window cannot be resized (i.e. a browser tab). */
export function fitAppWindowToPatch(patchW: number, patchH: number): boolean {
  if (typeof window === "undefined" || !isStandalone()) return false;
  const bounds = fitWindowBounds(patchW, patchH, window.screen, {
    width: Math.max(0, window.outerWidth - window.innerWidth),
    height: Math.max(0, window.outerHeight - window.innerHeight),
  });
  window.resizeTo(bounds.width, bounds.height);
  window.moveTo(bounds.left, bounds.top);
  return true;
}

/**
 * First run of the installed app, where Chrome would otherwise pick an
 * arbitrary fraction of the screen. Only once: later launches reopen at
 * whatever size the window was dragged to, and overriding that every time
 * would be a fight the app cannot win politely.
 */
export function fitAppWindowOnFirstLaunch(patchW: number, patchH: number): void {
  if (!isStandalone()) return;
  try {
    if (localStorage.getItem(FITTED_KEY) === "1") return;
  } catch {
    return;
  }
  if (!fitAppWindowToPatch(patchW, patchH)) return;
  try {
    localStorage.setItem(FITTED_KEY, "1");
  } catch {
    // Private mode — the worst case is fitting again next launch.
  }
}
