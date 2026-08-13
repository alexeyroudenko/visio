import { useEffect, useRef, useState } from "react";

function carriesFiles(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types).includes("Files");
}

/**
 * Window-wide file drop: highlight while a file is over the app, hand the files
 * over when it lands.
 *
 * Listening on `window` rather than a drop target is what makes the whole app
 * catch the drop — panels, toolbar, timeline and all — and it is also the only
 * way to stop the browser's own handler, which would navigate the tab to the
 * dropped file and take the session with it.
 *
 * Enter/leave fire per element as the pointer crosses the tree, so the depth
 * counter is what tells "left a child" from "left the window".
 */
export function useFileDrop(onFiles: (files: File[]) => void): boolean {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setOver(false);
    };

    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current += 1;
      setOver(true);
    };

    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      // Without this the drop event never fires at all.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setOver(true);
    };

    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };

    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      reset();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) onFilesRef.current(files);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    // A drag cancelled with Escape, or one that ends outside, leaves no leave.
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return over;
}
