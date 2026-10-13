import { useCallback, useEffect, useRef } from "react";
import { bindPointerHoldTarget } from "../lib/pointerHold";

const WINDOW_NAME = "visio-output";

/**
 * Detached output window — the "perform window" idiom: drag it to a projector
 * or second screen and it shows the patch output full-bleed.
 *
 * It mirrors the engine canvas through captureStream() into a <video>, so the
 * WebGL context stays in the main document and nothing has to be re-rendered.
 */
export function useOutputWindow(getCanvas: () => HTMLCanvasElement | null) {
  const windowRef = useRef<Window | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const unbindHoldRef = useRef<(() => void) | null>(null);

  const close = useCallback(() => {
    unbindHoldRef.current?.();
    unbindHoldRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    windowRef.current?.close();
    windowRef.current = null;
  }, []);

  const open = useCallback(() => {
    const canvas = getCanvas();
    if (!canvas) return;

    // Already open — just bring it forward.
    if (windowRef.current && !windowRef.current.closed) {
      windowRef.current.focus();
      return;
    }

    const popup = window.open("", WINDOW_NAME, "width=1280,height=720");
    if (!popup) {
      window.alert("Browser blocked the output window — allow pop-ups for this site.");
      return;
    }

    popup.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>visio — output</title>
    <style>
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
      body { position: relative; display: grid; place-items: center; cursor: crosshair; }
      video { width: 100%; height: 100%; object-fit: contain; display: block; touch-action: none; }
      .pointer-hold-frame {
        position: absolute; inset: 5%; border: 2px solid rgb(255 255 255 / 55%);
        box-sizing: border-box; pointer-events: none; z-index: 5; display: none;
      }
      .pointer-hold-frame[data-active] { display: block; }
      #hint {
        position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
        color: #6b7280; font: 12px ui-sans-serif, system-ui, sans-serif;
        transition: opacity .4s; pointer-events: none;
      }
    </style>
  </head>
  <body>
    <video id="out" autoplay playsinline muted></video>
    <div id="hint">double-click for fullscreen</div>
  </body>
</html>`);
    popup.document.close();

    const video = popup.document.getElementById("out") as HTMLVideoElement | null;
    if (!video) return;

    const stream = canvas.captureStream(60);
    streamRef.current = stream;
    video.srcObject = stream;
    void video.play().catch(() => undefined);

    video.addEventListener("dblclick", () => {
      if (popup.document.fullscreenElement) void popup.document.exitFullscreen();
      else void popup.document.documentElement.requestFullscreen().catch(() => undefined);
    });

    unbindHoldRef.current?.();
    unbindHoldRef.current = bindPointerHoldTarget(video);

    const hint = popup.document.getElementById("hint");
    popup.setTimeout(() => hint?.style.setProperty("opacity", "0"), 2500);

    // If the user closes the window, drop the stream with it.
    popup.addEventListener("pagehide", () => {
      unbindHoldRef.current?.();
      unbindHoldRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      windowRef.current = null;
    });

    windowRef.current = popup;
  }, [getCanvas]);

  // Never leave an orphaned window behind when the app unmounts.
  useEffect(() => close, [close]);

  return { open, close };
}
