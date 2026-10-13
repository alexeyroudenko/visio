/**
 * Global pointer/touch hold against the patch output (preview canvas or
 * detached output window). Nodes like Datamosh4 read this each frame via
 * EngineContext.pointerHeld.
 *
 * While held, a semi-transparent white frame (5% inset, 2px) overlays the
 * content surface as press feedback.
 */

const HOLD_FRAME_CLASS = "pointer-hold-frame";

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

function attachHoldFrame(el: HTMLElement): { show: () => void; hide: () => void; dispose: () => void } {
  const parent = el.parentElement;
  if (!parent) {
    return { show: () => undefined, hide: () => undefined, dispose: () => undefined };
  }

  const computed = getComputedStyle(parent);
  let restoredPosition: string | null = null;
  if (computed.position === "static") {
    restoredPosition = parent.style.position;
    parent.style.position = "relative";
  }

  const frame = document.createElement("div");
  frame.className = HOLD_FRAME_CLASS;
  frame.setAttribute("aria-hidden", "true");
  parent.appendChild(frame);

  return {
    show: () => {
      frame.dataset.active = "true";
    },
    hide: () => {
      delete frame.dataset.active;
    },
    dispose: () => {
      frame.remove();
      if (restoredPosition !== null) parent.style.position = restoredPosition;
    },
  };
}

/**
 * Bind primary-button / touch down→up on an element. Returns an unbind.
 * Also clears hold on window blur / lost pointer capture.
 */
export function bindPointerHoldTarget(el: HTMLElement): () => void {
  const frame = attachHoldFrame(el);

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    el.setPointerCapture(event.pointerId);
    frame.show();
    setPointerHeld(true);
  };
  const onUp = () => {
    frame.hide();
    setPointerHeld(false);
  };
  const onBlur = () => {
    frame.hide();
    setPointerHeld(false);
  };

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
    frame.dispose();
    setPointerHeld(false);
  };
}
