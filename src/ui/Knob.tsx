import { useEffect, useRef } from "react";
import { registerMidiParam } from "../lib/midiParams";

const SENSITIVITY = 150; // vertical pixels for the full min→max sweep
const DEFAULT_SIZE = 44;

function clampQuantize(v: number, min: number, max: number, step: number): number {
  const clamped = Math.max(min, Math.min(max, v));
  const snapped = Math.round((clamped - min) / step) * step + min;
  return Math.max(min, Math.min(max, snapped));
}

function formatValue(v: number, step: number): string {
  if (step >= 1) return String(Math.round(v));
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step))));
  return v.toFixed(decimals);
}

function drawKnob(
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
): void {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const startAngle = Math.PI * 0.75;
  const endAngle = Math.PI * 2.25;
  const curAngle = startAngle + (endAngle - startAngle) * t;

  ctx.clearRect(0, 0, size, size);

  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, curAngle);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3;
  ctx.stroke();

  const nx = Math.cos(curAngle);
  const ny = Math.sin(curAngle);
  ctx.beginPath();
  ctx.moveTo(cx + nx * (r - 6), cy + ny * (r - 6));
  ctx.lineTo(cx + nx * r, cy + ny * r);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/**
 * Rotary knob like granular-video: vertical drag (ns-resize), canvas arc + needle.
 */
export function Knob({
  label,
  min,
  max,
  step,
  value,
  onChange,
  size = DEFAULT_SIZE,
  format,
  publish = false,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  size?: number;
  format?: (v: number) => string;
  /** Offer this knob to an external MIDI bridge (published mixer only). */
  publish?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef({ min, max, step });
  const labelRef = useRef(label);
  const dragRef = useRef<{ y0: number; v0: number } | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;
  rangeRef.current = { min, max, step };
  labelRef.current = label;

  const span = Math.max(1e-9, max - min);
  const t = Math.max(0, Math.min(1, (value - min) / span));
  const display = format ? format(value) : formatValue(value, step);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(size * dpr));
    canvas.height = Math.max(1, Math.floor(size * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawKnob(ctx, size, t);
  }, [size, t]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      dragRef.current = { y0: event.clientY, v0: valueRef.current };
    };
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = ((drag.y0 - event.clientY) / SENSITIVITY) * (max - min);
      const next = clampQuantize(drag.v0 + delta, min, max, step);
      if (next !== valueRef.current) onChangeRef.current(next);
    };
    const onUp = (event: PointerEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, [min, max, step]);

  // Registered once per mount: the refs above keep the entry reading fresh
  // bounds and handlers, so a re-render never churns the bridge's mapping.
  useEffect(() => {
    const el = wrapRef.current;
    if (!publish || !el) return;
    return registerMidiParam({
      get label() {
        return labelRef.current;
      },
      el,
      getNorm: () => {
        const { min: lo, max: hi } = rangeRef.current;
        return Math.max(0, Math.min(1, (valueRef.current - lo) / Math.max(1e-9, hi - lo)));
      },
      setNorm: (norm) => {
        const { min: lo, max: hi, step: inc } = rangeRef.current;
        const next = clampQuantize(lo + Math.max(0, Math.min(1, norm)) * (hi - lo), lo, hi, inc);
        if (next !== valueRef.current) onChangeRef.current(next);
      },
    });
  }, [publish]);

  return (
    <div className="kw" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="knob"
        style={{ width: size, height: size }}
        aria-label={label}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onKeyDown={(event) => {
          let next = value;
          if (event.key === "ArrowUp" || event.key === "ArrowRight") next = value + step;
          else if (event.key === "ArrowDown" || event.key === "ArrowLeft") next = value - step;
          else if (event.key === "Home") next = min;
          else if (event.key === "End") next = max;
          else return;
          event.preventDefault();
          onChange(clampQuantize(next, min, max, step));
        }}
      />
      <div className="kl">{label}</div>
      <div className="kv">{display}</div>
    </div>
  );
}
