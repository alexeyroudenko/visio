/**
 * Records the engine canvas straight off its capture stream. The engine keeps
 * preserveDrawingBuffer on, so frames survive long enough to be grabbed.
 *
 * MIME order prefers WebM where available; Safari/iOS often only offers mp4 —
 * we try that next and surface a clear error when nothing is supported.
 */
import { useCallback, useRef, useState } from "react";
// Aliased: `track` is already a MediaStream track in this file.
import { scrub, track as trackEvent } from "../lib/analytics";
import { withSourcePrefix } from "../lib/mediaName";
import { formatBitrate, loadRenderBitrate } from "../lib/renderBitrate";
import { appLog } from "../store/consoleStore";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
];

export function pickRecorderMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* some engines throw on exotic mime strings */
    }
  }
  // Last resort: empty mime lets the UA pick — only if the ctor itself works.
  return "";
}

function extensionForMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  return "webm";
}

export function useRecorder(getCanvas: () => HTMLCanvasElement | null) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    // Recording is where browser support falls apart (Safari/iOS especially);
    // every bail-out reports so the gap shows up as a number, not a bug report.
    const fail = (message: string) => {
      appLog("error", "record", message);
      trackEvent("record_failed", { reason: scrub(message) });
    };

    const canvas = getCanvas();
    if (!canvas) {
      appLog("warn", "record", "no canvas to capture");
      trackEvent("record_failed", { reason: "no canvas" });
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      fail("MediaRecorder is not supported in this browser");
      return;
    }
    if (typeof canvas.captureStream !== "function") {
      fail("canvas.captureStream is not supported in this browser");
      return;
    }

    const mimeType = pickRecorderMimeType();
    if (mimeType === null) {
      fail("no supported video MIME for MediaRecorder");
      return;
    }

    let stream: MediaStream;
    try {
      stream = canvas.captureStream(60);
    } catch (error) {
      fail(error instanceof Error ? error.message : "captureStream failed");
      return;
    }

    const bitrate = loadRenderBitrate();

    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate })
        : new MediaRecorder(stream, { videoBitsPerSecond: bitrate });
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      fail(
        error instanceof Error
          ? `MediaRecorder failed: ${error.message}`
          : "MediaRecorder failed to start",
      );
      return;
    }

    chunksRef.current = [];
    /** Set once the recorder actually starts; onstop reads it for the duration. */
    let startedAt = 0;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      fail("MediaRecorder error — recording stopped");
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setRecording(false);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      const sec = Number(((performance.now() - startedAt) / 1000).toFixed(1));
      if (blob.size === 0) {
        fail("empty recording — nothing saved");
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        link.download = `${withSourcePrefix(stamp)}.${extensionForMime(type)}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        appLog("ok", "record", `saved ${link.download}`);
        trackEvent("record_saved", {
          sec,
          format: extensionForMime(type),
          size_mb: Number((blob.size / (1024 * 1024)).toFixed(1)),
        });
      }
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setRecording(false);
    };

    try {
      recorder.start(1000);
      startedAt = performance.now();
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      fail(error instanceof Error ? error.message : "MediaRecorder.start failed");
      return;
    }

    recorderRef.current = recorder;
    setRecording(true);
    appLog(
      "info",
      "record",
      `started · ${recorder.mimeType || mimeType || "default"} · ${formatBitrate(bitrate)}`,
    );
    trackEvent("record_started", { mime: recorder.mimeType || mimeType || "default", bitrate });
  }, [getCanvas]);

  const toggle = useCallback(() => {
    if (recorderRef.current) stop();
    else start();
  }, [start, stop]);

  return { recording, toggle };
}
