import { useEffect, useRef } from "react";
import {
  clearOpenMediaLocation,
  openMediaFromLocation,
  subscribeOpenMedia,
} from "../lib/openMedia";

/**
 * Calls back with a disk path whenever another app asks Visio to open a file —
 * once on boot for a `?media=` link, then for every push on the dev channel.
 * The callback is held in a ref so a fresh closure does not resubscribe.
 */
export function useOpenMedia(onPath: (fsPath: string) => void | Promise<void>): void {
  const handler = useRef(onPath);
  handler.current = onPath;

  useEffect(() => {
    const opened = openMediaFromLocation();
    if (opened) {
      clearOpenMediaLocation();
      void handler.current(opened);
    }
    return subscribeOpenMedia((fsPath) => {
      void handler.current(fsPath);
    });
  }, []);
}
