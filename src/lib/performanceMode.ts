/**
 * Live / performance view: the graph is hidden and published knobs drive the
 * patch. Default on — a performer opens the mixer, not the node editor.
 */
const STORAGE_KEY = "visio.performance.v1";

export function loadPerformanceMode(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return true;
    return raw !== "0";
  } catch {
    return true;
  }
}

export function savePerformanceMode(on: boolean): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
  return on;
}
