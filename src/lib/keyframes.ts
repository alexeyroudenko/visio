/** Per-node param path: `nodeId:paramKey`. */
export type ParamPath = string;

export interface ParamKeyframe {
  frame: number;
  value: unknown;
}

export type ParamKeyframes = Record<ParamPath, ParamKeyframe[]>;

export const DEFAULT_FPS = 30;
export const DEFAULT_DURATION_FRAMES = DEFAULT_FPS * 15;

export function paramPath(nodeId: string, key: string): ParamPath {
  return `${nodeId}:${key}`;
}

export function parseParamPath(path: ParamPath): { nodeId: string; key: string } | null {
  const i = path.indexOf(":");
  if (i <= 0) return null;
  return { nodeId: path.slice(0, i), key: path.slice(i + 1) };
}

function sortedKeys(keys: ParamKeyframe[]): ParamKeyframe[] {
  return [...keys].sort((a, b) => a.frame - b.frame);
}

function interpolateNumber(keys: ParamKeyframe[], frame: number, fallback: number): number {
  const sorted = sortedKeys(keys);
  if (sorted.length === 0) return fallback;

  if (frame <= sorted[0]!.frame) return sorted[0]!.value as number;
  const last = sorted[sorted.length - 1]!;
  if (frame >= last.frame) return last.value as number;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const t = (frame - a.frame) / (b.frame - a.frame);
      const av = a.value as number;
      const bv = b.value as number;
      return av + (bv - av) * t;
    }
  }
  return fallback;
}

function stepValue(keys: ParamKeyframe[], frame: number, fallback: unknown): unknown {
  const sorted = sortedKeys(keys);
  if (sorted.length === 0) return fallback;
  let result: unknown = fallback;
  for (const k of sorted) {
    if (k.frame <= frame) result = k.value;
    else break;
  }
  return result;
}

/** Resolve one param at a frame against its base value. */
export function getValueAtFrame(
  frame: number,
  base: unknown,
  keys: ParamKeyframe[] | undefined,
): unknown {
  if (!keys || keys.length === 0) return base;
  if (typeof base === "number") return interpolateNumber(keys, frame, base);
  return stepValue(keys, frame, base);
}

/** Overlay keyframed values onto each node's base params. */
export function applyKeyframesToNodes(
  frame: number,
  nodes: Array<{ id: string; params: Record<string, unknown> }>,
  keyframes: ParamKeyframes,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const params = { ...node.params };
    for (const [path, keys] of Object.entries(keyframes)) {
      const parsed = parseParamPath(path);
      if (!parsed || parsed.nodeId !== node.id || !keys?.length) continue;
      if (!(parsed.key in params) && params[parsed.key] === undefined) {
        // Still apply — param may exist only as keyframed override.
      }
      params[parsed.key] = getValueAtFrame(frame, params[parsed.key], keys);
    }
    out.set(node.id, params);
  }
  return out;
}

export function upsertKeyframe(
  keyframes: ParamKeyframes,
  path: ParamPath,
  frame: number,
  value: unknown,
): ParamKeyframes {
  const existing = keyframes[path] ?? [];
  const idx = existing.findIndex((k) => k.frame === frame);
  const next: ParamKeyframe[] =
    idx >= 0
      ? existing.map((k, i) => (i === idx ? { frame, value } : k))
      : [...existing, { frame, value }].sort((a, b) => a.frame - b.frame);
  return { ...keyframes, [path]: next };
}

export function removeKeyframe(
  keyframes: ParamKeyframes,
  path: ParamPath,
  frame: number,
): ParamKeyframes {
  const existing = keyframes[path];
  if (!existing) return keyframes;
  const next = existing.filter((k) => k.frame !== frame);
  if (next.length === 0) {
    const { [path]: _removed, ...rest } = keyframes;
    return rest;
  }
  return { ...keyframes, [path]: next };
}

export function getKeyframeMarkerFrames(keyframes: ParamKeyframes): number[] {
  const frames = new Set<number>();
  for (const keys of Object.values(keyframes)) {
    for (const k of keys) frames.add(k.frame);
  }
  return [...frames].sort((a, b) => a - b);
}

export function getPrevKeyframeFrame(keyframes: ParamKeyframes, frame: number): number | null {
  const markers = getKeyframeMarkerFrames(keyframes).filter((f) => f < frame);
  return markers.length > 0 ? markers[markers.length - 1]! : null;
}

export function getNextKeyframeFrame(keyframes: ParamKeyframes, frame: number): number | null {
  const markers = getKeyframeMarkerFrames(keyframes).filter((f) => f > frame);
  return markers.length > 0 ? markers[0]! : null;
}

export function moveKeyframeFrame(
  keyframes: ParamKeyframes,
  fromFrame: number,
  toFrame: number,
): ParamKeyframes {
  if (fromFrame === toFrame) return keyframes;
  const next: ParamKeyframes = {};
  for (const [path, keys] of Object.entries(keyframes)) {
    if (!keys?.length) continue;
    const byFrame = new Map<number, ParamKeyframe>();
    for (const k of keys) {
      const frame = k.frame === fromFrame ? toFrame : k.frame;
      byFrame.set(frame, { ...k, frame });
    }
    next[path] = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  }
  return next;
}

export function clampKeyframesToDuration(
  keyframes: ParamKeyframes,
  durationInFrames: number,
): ParamKeyframes {
  const next: ParamKeyframes = {};
  for (const [path, keys] of Object.entries(keyframes)) {
    const filtered = keys.filter((k) => k.frame <= durationInFrames);
    if (filtered.length) next[path] = filtered;
  }
  return next;
}

export function formatTimecode(frame: number, fps: number): string {
  const totalSeconds = frame / fps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frames = Math.floor(frame % fps);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

export function parseTimecode(value: string, fps: number): number | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const frames = Number(match[3]);
    if (seconds >= 60 || frames >= fps) return null;
    return minutes * 60 * fps + seconds * fps + frames;
  }
  const asFrames = Number.parseInt(trimmed, 10);
  return Number.isFinite(asFrames) ? asFrames : null;
}
