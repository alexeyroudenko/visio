import { useCallback, useRef, useState } from "react";
import { appLog } from "../store/consoleStore";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType(): string {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
}

/**
 * Records the engine canvas straight off its capture stream. The engine keeps
 * preserveDrawingBuffer on, so frames survive long enough to be grabbed.
 */
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

    const stream = canvas.captureStream(60);
    const recorder = new MediaRecorder(stream, {
      mimeType: pickMimeType(),
      videoBitsPerSecond: 12_000_000,
    });
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `visio-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      link.click();
      // Give the download a tick to start before dropping the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setRecording(false);
      appLog("ok", "record", `saved ${link.download}`);
    };

    recorder.start(1000);
    recorderRef.current = recorder;
    setRecording(true);
    appLog("info", "record", "started");
  }, [getCanvas]);

  const toggle = useCallback(() => {
    if (recorderRef.current) stop();
    else start();
  }, [start, stop]);

  return { recording, toggle };
}
