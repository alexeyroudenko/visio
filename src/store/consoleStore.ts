import { create } from "zustand";
import { scrub, track } from "../lib/analytics";

export type LogLevel = "info" | "ok" | "warn" | "error";

export interface LogEntry {
  id: number;
  t: number;
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_ENTRIES = 400;

interface ConsoleState {
  entries: LogEntry[];
  open: boolean;
  unread: number;
  push: (level: LogLevel, source: string, message: string) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

let seq = 0;

declare global {
  interface Window {
    /** Survives Vite HMR so log UI and producers share one console. */
    __visioConsoleStore?: ReturnType<typeof createConsoleStore>;
  }
}

function createConsoleStore() {
  return create<ConsoleState>((set, get) => ({
    entries: [],
    open: false,
    unread: 0,

    push(level, source, message) {
      const entry: LogEntry = {
        id: ++seq,
        t: Date.now(),
        level,
        source,
        message,
      };
      const entries = [...get().entries, entry];
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      set({
        entries,
        unread: get().open ? 0 : get().unread + 1,
      });
    },

    clear() {
      set({ entries: [], unread: 0 });
    },

    setOpen(open) {
      set({ open, unread: open ? 0 : get().unread });
    },
  }));
}

export const useConsoleStore =
  typeof window !== "undefined" && window.__visioConsoleStore
    ? window.__visioConsoleStore
    : createConsoleStore();

if (typeof window !== "undefined") {
  window.__visioConsoleStore = useConsoleStore;
}

/** `circles-3` → `circles`: node ids would otherwise explode the breakdown. */
function sourceGroup(source: string): string {
  return source.replace(/-\d+$/, "");
}

export function appLog(level: LogLevel, source: string, message: string): void {
  useConsoleStore.getState().push(level, source, message);
  if (level === "error") {
    // Catch-all net under the hand-written events: anything that reaches the
    // app console as an error is a session that went wrong somewhere.
    track("app_error", { source: sourceGroup(source), message: scrub(message) });
  }
}
