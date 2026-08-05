/**
 * Records the engine canvas straight off its capture stream. The engine keeps
 * preserveDrawingBuffer on, so frames survive long enough to be grabbed.
 *
 * MIME order prefers WebM where available; Safari/iOS often only offers mp4 —
 * we try that next and surface a clear error when nothing is supported.
 */
import { useCallback, useRef, useState } from "react";
import { withSourcePrefix } from "../lib/mediaName";
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
    const canvas = getCanvas();
    if (!canvas) {
      appLog("warn", "record", "no canvas to capture");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      appLog("error", "record", "MediaRecorder is not supported in this browser");
      return;
    }
    if (typeof canvas.captureStream !== "function") {
      appLog("error", "record", "canvas.captureStream is not supported in this browser");
      return;
    }

    const mimeType = pickRecorderMimeType();
    if (mimeType === null) {
      appLog("error", "record", "no supported video MIME for MediaRecorder");
      return;
    }

    let stream: MediaStream;
    try {
      stream = canvas.captureStream(60);
    } catch (error) {
      appLog(
        "error",
        "record",
        error instanceof Error ? error.message : "captureStream failed",
      );
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 })
        : new MediaRecorder(stream, { videoBitsPerSecond: 12_000_000 });
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      appLog(
        "error",
        "record",
        error instanceof Error
          ? `MediaRecorder failed: ${error.message}`
          : "MediaRecorder failed to start",
      );
      return;
    }

    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      appLog("error", "record", "MediaRecorder error — recording stopped");
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setRecording(false);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      if (blob.size === 0) {
        appLog("error", "record", "empty recording — nothing saved");
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        link.download = `${withSourcePrefix(stamp)}.${extensionForMime(type)}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        appLog("ok", "record", `saved ${link.download}`);
      }
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setRecording(false);
    };

    try {
      recorder.start(1000);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      appLog(
        "error",
        "record",
        error instanceof Error ? error.message : "MediaRecorder.start failed",
      );
      return;
    }

    recorderRef.current = recorder;
    setRecording(true);
    appLog("info", "record", `started · ${recorder.mimeType || mimeType || "default"}`);
  }, [getCanvas]);

  const toggle = useCallback(() => {
    if (recorderRef.current) stop();
    else start();
  }, [start, stop]);

  return { recording, toggle };
}
