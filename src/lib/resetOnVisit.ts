/**
 * Whether a visit (reload / reopen) starts empty like Reset, or restores the
 * last autosaved patch. Production defaults on; `npm run dev` defaults off so a
 * refresh keeps the graph you were editing.
 */
const STORAGE_KEY = "visio.resetOnVisit.v1";

export const DEFAULT_RESET_ON_VISIT = !import.meta.env.DEV;

export function loadResetOnVisit(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_RESET_ON_VISIT;
    return raw !== "0";
  } catch {
    return DEFAULT_RESET_ON_VISIT;
  }
}

export function saveResetOnVisit(on: boolean): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
  return on;
}
