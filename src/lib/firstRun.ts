/**
 * First-run chrome tour: blink +Node / Presets / Render a few times after the
 * empty screen becomes a graph. Separate from analytics `first_visit` — that
 * key is set on PostHog init and must not gate UI.
 */
const HINTS_KEY = "visio.firstRun.hints.v1";

/** In the 5–7 range the passport asked for. */
export const CHROME_HINT_CYCLES = 6;
export const CHROME_HINT_MS = 1000;

export function chromeHintsPending(): boolean {
  try {
    return localStorage.getItem(HINTS_KEY) !== "1";
  } catch {
    return true;
  }
}

export function markChromeHintsDone(): void {
  try {
    localStorage.setItem(HINTS_KEY, "1");
  } catch {
    /* private mode / quota */
  }
}

export function chromeHintDurationMs(): number {
  return CHROME_HINT_CYCLES * CHROME_HINT_MS;
}
