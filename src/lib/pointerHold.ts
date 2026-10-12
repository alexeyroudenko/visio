/**
 * Global pointer/touch hold against the patch output (preview canvas or
 * detached output window). Nodes like Datamosh4 read this each frame via
 * EngineContext.pointerHeld.
 */
let held = false;
const listeners = new Set<() => void>();

export function isPointerHeld(): boolean {
  return held;
}

export function setPointerHeld(next: boolean): void {
  if (held === next) return;
  held = next;
  for (const listener of listeners) listener();
}

/** Subscribe to hold changes (UI / debug). */
export function subscribePointerHeld(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Bind primary-button / touch down→up on an element. Returns an unbind.
 * Also clears hold on window blur / lost pointer capture.
 */
export function bindPointerHoldTarget(el: HTMLElement): () => void {
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    el.setPointerCapture(event.pointerId);
    setPointerHeld(true);
  };
  const onUp = () => setPointerHeld(false);
  const onBlur = () => setPointerHeld(false);

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("lostpointercapture", onUp);
  window.addEventListener("blur", onBlur);

  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("lostpointercapture", onUp);
    window.removeEventListener("blur", onBlur);
    setPointerHeld(false);
  };
}
