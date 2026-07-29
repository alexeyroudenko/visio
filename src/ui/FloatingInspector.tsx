import { useCallback, useEffect, useRef, useState } from "react";
import { useGraphStore } from "../store/graphStore";
import { Inspector } from "./Inspector";

const PANEL_WIDTH = 320;
const PANEL_HEIGHT_VH = 25;

function defaultPosition(): { x: number; y: number } {
  const w = Math.min(PANEL_WIDTH, window.innerWidth - 24);
  return {
    x: Math.max(12, Math.round((window.innerWidth - w) / 2)),
    y: Math.max(48, Math.round(window.innerHeight * 0.06)),
  };
}

/**
 * Portrait layout: node params in a floating, draggable panel.
 * Spawns centred near the top at ~25% viewport height.
 */
export function FloatingInspector() {
  const selectedId = useGraphStore((state) => state.selectedId);
  const select = useGraphStore((state) => state.select);
  const [pos, setPos] = useState(defaultPosition);
  const wasOpenRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Centre only when the panel first opens (null → selected).
  useEffect(() => {
    if (selectedId && !wasOpenRef.current) {
      setPos(defaultPosition());
    }
    wasOpenRef.current = !!selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const onResize = () => {
      setPos((prev) => {
        const w = Math.min(PANEL_WIDTH, window.innerWidth - 24);
        const ph = window.innerHeight * (PANEL_HEIGHT_VH / 100);
        return {
          x: Math.min(Math.max(12, prev.x), Math.max(12, window.innerWidth - w - 12)),
          y: Math.min(Math.max(12, prev.y), Math.max(12, window.innerHeight - ph - 12)),
        };
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [selectedId]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, textarea, a")) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: pos.x,
      origY: pos.y,
    };
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const el = panelRef.current;
    const pw = el?.offsetWidth ?? PANEL_WIDTH;
    const ph = el?.offsetHeight ?? window.innerHeight * (PANEL_HEIGHT_VH / 100);
    const maxX = Math.max(12, window.innerWidth - pw - 12);
    const maxY = Math.max(12, window.innerHeight - ph - 12);
    setPos({
      x: Math.min(maxX, Math.max(12, drag.origX + dx)),
      y: Math.min(maxY, Math.max(12, drag.origY + dy)),
    });
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  if (!selectedId) return null;

  return (
    <div
      ref={panelRef}
      className="floating-inspector"
      style={{
        left: pos.x,
        top: pos.y,
        width: Math.min(PANEL_WIDTH, window.innerWidth - 24),
        height: `${PANEL_HEIGHT_VH}vh`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      role="dialog"
      aria-label="Node settings"
    >
      <div
        className="floating-inspector__chrome"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="floating-inspector__grip" aria-hidden>
          ⋮⋮
        </span>
        <span className="floating-inspector__title">Settings</span>
        <button
          type="button"
          className="button button--small"
          aria-label="Close settings"
          onClick={() => select(null)}
        >
          ✕
        </button>
      </div>
      <div className="floating-inspector__body">
        <Inspector />
      </div>
    </div>
  );
}
