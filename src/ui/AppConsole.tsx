import { useEffect, useRef } from "react";
import { useConsoleStore, type LogEntry } from "../store/consoleStore";

function formatTime(t: number): string {
  const d = new Date(t);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className={`app-console__line app-console__line--${entry.level}`}>
      <span className="app-console__time">{formatTime(entry.t)}</span>
      <span className="app-console__level">{entry.level}</span>
      <span className="app-console__source">{entry.source}</span>
      <span className="app-console__msg">{entry.message}</span>
    </div>
  );
}

export function AppConsole() {
  const open = useConsoleStore((state) => state.open);
  const unread = useConsoleStore((state) => state.unread);
  const entries = useConsoleStore((state) => state.entries);
  const setOpen = useConsoleStore((state) => state.setOpen);
  const clear = useConsoleStore((state) => state.clear);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const last = entries[entries.length - 1];

  useEffect(() => {
    if (!open) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, entries.length]);

  return (
    <div className={`app-console ${open ? "app-console--open" : ""}`}>
      <button
        type="button"
        className="app-console__bar"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="app-console__chevron">{open ? "▾" : "▴"}</span>
        <strong>Console</strong>
        {unread > 0 && !open ? <span className="app-console__badge">{unread}</span> : null}
        {last && !open ? (
          <span className={`app-console__preview app-console__line--${last.level}`}>
            <em>{last.source}</em> {last.message}
          </span>
        ) : (
          <span className="app-console__preview app-console__preview--muted">
            {entries.length === 0 ? "no events yet" : `${entries.length} events`}
          </span>
        )}
      </button>

      {open ? (
        <div className="app-console__panel">
          <div className="app-console__toolbar">
            <button type="button" className="button button--small" onClick={clear}>
              Clear
            </button>
          </div>
          <div className="app-console__scroll" ref={scrollerRef}>
            {entries.length === 0 ? (
              <div className="app-console__empty">Events will appear here.</div>
            ) : (
              entries.map((entry) => <LogLine key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
