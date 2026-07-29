/**
 * One AudioContext for the whole patch.
 *
 * Browsers refuse to start it without a user gesture, so the first node that
 * needs sound arms a one-shot listener: the context resumes on the next click
 * or keypress anywhere in the app and every node hears it at once.
 */

declare global {
  interface Window {
    /** Survives Vite HMR — a second AudioContext per reload would leak. */
    __visioAudioContext?: AudioContext;
  }
}

let armed = false;

function armResume(target: AudioContext): void {
  if (armed || typeof window === "undefined") return;
  armed = true;

  const kick = (): void => {
    window.removeEventListener("pointerdown", kick);
    window.removeEventListener("keydown", kick);
    armed = false;
    void target.resume().catch(() => undefined);
  };

  window.addEventListener("pointerdown", kick);
  window.addEventListener("keydown", kick);
  // The patch may well have been loaded by a click already — try straight away.
  void target.resume().catch(() => undefined);
}

/** The shared context, created on first use. Resumes itself when allowed. */
export function audioContext(): AudioContext {
  let ctx = typeof window !== "undefined" ? window.__visioAudioContext : undefined;
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext();
    if (typeof window !== "undefined") window.__visioAudioContext = ctx;
  }
  if (ctx.state !== "running") armResume(ctx);
  return ctx;
}

/** False while the autoplay policy still has the context suspended. */
export function audioRunning(): boolean {
  const ctx = typeof window !== "undefined" ? window.__visioAudioContext : undefined;
  return ctx?.state === "running";
}
