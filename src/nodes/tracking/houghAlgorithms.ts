/**
 * The Hough transforms themselves, with no DOM and no GL — everything here runs
 * unchanged on the main thread or inside a worker. The nodes keep the parts that
 * cannot move: reading the frame and downscaling it through a canvas.
 */
import type { CirclesValue, LinesValue } from "../../engine/types";
import type { EdgePoint } from "../shared/grayscale";

export const MAX_EDGES = 20_000;

export interface CircleOptions {
  minR: number;
  maxR: number;
  minDist: number;
  votes: number;
  maxCircles: number;
}

export interface LineOptions {
  thetaStepDeg: number;
  votes: number;
  minLength: number;
  /** 0 = no cap. Applied after collinear merge so joining cannot undo it. */
  maxLength: number;
  maxGap: number;
  maxLines: number;
}

/** Scratch reused across calls — one caller at a time, per thread. */
const scratch = {
  accumulator: new Float32Array(0),
  smoothed: new Float32Array(0),
  histogram: new Float32Array(0),
  lineAcc: new Int32Array(0),
  edgeMap: new Uint8Array(0),
  cosTable: new Float32Array(0),
  sinTable: new Float32Array(0),
  tableSize: 0,
};

/**
 * Edge points above `threshold`, spatially thinned to at most `limit` so a
 * long line keeps roughly even spacing instead of raster-stride holes.
 */
export function collectEdges(
  gradX: Float32Array,
  gradY: Float32Array,
  width: number,
  height: number,
  threshold: number,
  limit: number,
): EdgePoint[] {
  const raw: EdgePoint[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = gradX[i]!;
      const gy = gradY[i]!;
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < threshold) continue;
      const inv = 1 / magnitude;
      raw.push({ x, y, ux: gx * inv, uy: gy * inv, magnitude });
    }
  }
  return thinEdges(raw, width, height, limit);
}

/** Keep the strongest point per grid cell so subsample gaps stay bounded. */
export function thinEdges(
  raw: EdgePoint[],
  width: number,
  height: number,
  limit: number,
): EdgePoint[] {
  if (raw.length <= limit) return raw;
  const cell = Math.max(1, Math.ceil(Math.sqrt((width * height) / limit)));
  const cols = Math.ceil(width / cell);
  const best = new Map<number, EdgePoint>();
  for (const edge of raw) {
    const key = ((edge.y / cell) | 0) * cols + ((edge.x / cell) | 0);
    const prev = best.get(key);
    if (!prev || edge.magnitude > prev.magnitude) best.set(key, edge);
  }
  return [...best.values()];
}

/**
 * Hough gradient method — the OpenCV HoughCircles (HOUGH_GRADIENT) approach.
 *
 * Stage 1: each edge point votes for centers along its gradient direction, both
 * ways, across the radius range. Stage 2: accumulator peaks become centers, and
 * each center picks its radius from a histogram of edge distances. Voting into
 * exact (cx, cy, r) bins would be far too sparse to ever clear a threshold.
 */
export function circlesFromEdges(
  edges: EdgePoint[],
  width: number,
  height: number,
  opts: CircleOptions,
): CirclesValue {
  const { minR, maxR, minDist, votes: threshold, maxCircles } = opts;
  const size = width * height;
  if (scratch.accumulator.length !== size) {
    scratch.accumulator = new Float32Array(size);
    scratch.smoothed = new Float32Array(size);
  }
  const acc = scratch.accumulator;
  const smooth = scratch.smoothed;
  acc.fill(0);

  for (const edge of edges) {
    for (let dir = -1; dir <= 1; dir += 2) {
      const stepX = edge.ux * dir;
      const stepY = edge.uy * dir;
      let cx = edge.x + stepX * minR;
      let cy = edge.y + stepY * minR;
      for (let r = minR; r <= maxR; r += 1) {
        const ax = cx | 0;
        const ay = cy | 0;
        if (ax >= 0 && ay >= 0 && ax < width && ay < height) acc[ay * width + ax]! += 1;
        cx += stepX;
        cy += stepY;
      }
    }
  }

  // Box-blur the accumulator so votes scattered by gradient noise and radius
  // quantization reinforce one peak instead of several weak neighbours.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += acc[yy * width + xx]!;
        }
      }
      smooth[y * width + x] = sum;
    }
  }

  const peaks: { x: number; y: number; votes: number }[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const value = smooth[y * width + x]!;
      if (value < threshold) continue;
      let isPeak = true;
      for (let dy = -1; dy <= 1 && isPeak; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (smooth[(y + dy) * width + (x + dx)]! > value) {
            isPeak = false;
            break;
          }
        }
      }
      if (isPeak) peaks.push({ x, y, votes: value });
    }
  }

  if (peaks.length === 0) return { circles: [] };
  peaks.sort((a, b) => b.votes - a.votes);

  const minDistSq = minDist * minDist;
  const accepted: { x: number; y: number; votes: number }[] = [];
  for (const peak of peaks) {
    if (accepted.length >= maxCircles) break;
    let tooClose = false;
    for (const other of accepted) {
      const dx = other.x - peak.x;
      const dy = other.y - peak.y;
      if (dx * dx + dy * dy < minDistSq) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) accepted.push(peak);
  }

  if (scratch.histogram.length !== maxR + 2) scratch.histogram = new Float32Array(maxR + 2);
  const histogram = scratch.histogram;
  const maxVotes = accepted[0]?.votes || 1;
  const minRSq = minR * minR;
  const maxRSq = maxR * maxR;
  const circles: CirclesValue["circles"] = [];

  for (const center of accepted) {
    histogram.fill(0);
    for (const edge of edges) {
      const dx = edge.x - center.x;
      const dy = edge.y - center.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < minRSq || distSq > maxRSq) continue;
      const r = Math.round(Math.sqrt(distSq));
      if (r >= minR && r <= maxR) histogram[r]! += 1;
    }

    let bestR = minR;
    let bestCount = 0;
    for (let r = minR; r <= maxR; r += 1) {
      // Sum a small window so a soft distance peak isn't missed.
      const count = (histogram[r - 1] ?? 0) + histogram[r]! + (histogram[r + 1] ?? 0);
      if (count > bestCount) {
        bestCount = count;
        bestR = r;
      }
    }
    if (bestCount <= 0) continue;

    circles.push({
      x: center.x / width,
      y: center.y / height,
      r: bestR / width,
      score: Math.min(1, center.votes / maxVotes),
    });
  }

  return { circles };
}

/**
 * Liang–Barsky: t-range where `origin + t * dir` stays inside the frame.
 * `dir` is unit, so t is in pixels.
 */
function clipLineT(
  px: number,
  py: number,
  dx: number,
  dy: number,
  width: number,
  height: number,
): [number, number] | null {
  const xmin = 1;
  const ymin = 1;
  const xmax = width - 2;
  const ymax = height - 2;
  let t0 = -1e6;
  let t1 = 1e6;

  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };

  if (!clip(-dx, px - xmin)) return null;
  if (!clip(dx, xmax - px)) return null;
  if (!clip(-dy, py - ymin)) return null;
  if (!clip(dy, ymax - py)) return null;
  if (t0 > t1) return null;
  return [t0, t1];
}

function edgeNear(
  map: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  nx: number,
  ny: number,
  band: number,
): boolean {
  for (let d = -band; d <= band; d += 1) {
    const xx = Math.round(x + nx * d);
    const yy = Math.round(y + ny * d);
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
    if (map[yy * width + xx]) return true;
  }
  return false;
}

/** Probabilistic Hough transform — the OpenCV HoughLinesP approach. */
export function linesFromEdges(
  edges: EdgePoint[],
  width: number,
  height: number,
  opts: LineOptions,
): LinesValue {
  const rhoStep = 1;
  const thetaStep = (opts.thetaStepDeg * Math.PI) / 180;
  const numTheta = Math.max(2, Math.ceil(Math.PI / thetaStep));
  const maxRho = Math.ceil(Math.hypot(width, height));
  const rhoBins = Math.ceil((maxRho * 2) / rhoStep) + 1;
  const rhoOffset = Math.floor(rhoBins / 2);

  if (scratch.tableSize !== numTheta) {
    scratch.cosTable = new Float32Array(numTheta);
    scratch.sinTable = new Float32Array(numTheta);
    for (let t = 0; t < numTheta; t += 1) {
      scratch.cosTable[t] = Math.cos(t * thetaStep);
      scratch.sinTable[t] = Math.sin(t * thetaStep);
    }
    scratch.tableSize = numTheta;
  }
  const { cosTable, sinTable } = scratch;

  const accSize = rhoBins * numTheta;
  if (scratch.lineAcc.length !== accSize) scratch.lineAcc = new Int32Array(accSize);
  const acc = scratch.lineAcc;
  acc.fill(0);

  for (const edge of edges) {
    for (let t = 0; t < numTheta; t += 1) {
      const rho = edge.x * cosTable[t]! + edge.y * sinTable[t]!;
      const ri = Math.round(rho / rhoStep) + rhoOffset;
      if (ri >= 0 && ri < rhoBins) acc[ri * numTheta + t]! += 1;
    }
  }

  const threshold = opts.votes;
  const candidates: { ri: number; theta: number; votes: number }[] = [];
  for (let ri = 1; ri < rhoBins - 1; ri += 1) {
    for (let t = 0; t < numTheta; t += 1) {
      const votes = acc[ri * numTheta + t]!;
      if (votes < threshold) continue;
      // Keep only local maxima; theta wraps around at ±π.
      const prev = t === 0 ? numTheta - 1 : t - 1;
      const next = t === numTheta - 1 ? 0 : t + 1;
      if (
        votes < acc[(ri - 1) * numTheta + t]! ||
        votes < acc[(ri + 1) * numTheta + t]! ||
        votes < acc[ri * numTheta + prev]! ||
        votes < acc[ri * numTheta + next]!
      ) {
        continue;
      }
      candidates.push({ ri, theta: t, votes });
    }
  }

  if (candidates.length === 0) return { lines: [] };
  candidates.sort((a, b) => b.votes - a.votes);

  const { maxLines, minLength, maxGap, maxLength } = opts;
  const pixels: PixelSeg[] = [];
  const maxCandidates = Math.max(maxLines * 8, 64);

  const size = width * height;
  if (scratch.edgeMap.length !== size) scratch.edgeMap = new Uint8Array(size);
  const map = scratch.edgeMap;
  map.fill(0);
  for (const edge of edges) {
    const x = edge.x | 0;
    const y = edge.y | 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < width && yy < height) map[yy * width + xx] = 1;
      }
    }
  }

  // A peak is at most half a theta-bin off the true angle; at the far end of a
  // full-frame line that is (L/2)·tan(Δθ) pixels of perp drift. A ±1.5 px ρ
  // gate kept only the middle third — walk the line instead.
  const band = Math.max(2, Math.ceil(Math.tan(thetaStep) * Math.hypot(width, height) * 0.5) + 1);

  const pushSpan = (
    px: number,
    py: number,
    dirX: number,
    dirY: number,
    tA: number,
    tB: number,
    votes: number,
  ): void => {
    if (tB < tA) {
      const swap = tA;
      tA = tB;
      tB = swap;
    }
    if (tB - tA < minLength) return;
    pixels.push({
      x1: px + tA * dirX,
      y1: py + tA * dirY,
      x2: px + tB * dirX,
      y2: py + tB * dirY,
      score: Math.min(1, votes / (threshold * 3)),
    });
  };

  for (let ci = 0; ci < candidates.length && ci < maxCandidates; ci += 1) {
    const { ri, theta, votes } = candidates[ci]!;
    const rho = (ri - rhoOffset) * rhoStep;
    const cosT = cosTable[theta]!;
    const sinT = sinTable[theta]!;
    const dirX = -sinT;
    const dirY = cosT;
    const px = rho * cosT;
    const py = rho * sinT;
    const clipped = clipLineT(px, py, dirX, dirY, width, height);
    if (!clipped) continue;

    const [t0, t1] = clipped;
    let segStart: number | null = null;
    let lastHit = t0;
    for (let t = t0; t <= t1; t += 1) {
      if (edgeNear(map, width, height, px + t * dirX, py + t * dirY, cosT, sinT, band)) {
        if (segStart === null) segStart = t;
        lastHit = t;
      } else if (segStart !== null && t - lastHit > maxGap) {
        pushSpan(px, py, dirX, dirY, segStart, lastHit, votes);
        segStart = null;
      }
    }
    if (segStart !== null) pushSpan(px, py, dirX, dirY, segStart, lastHit, votes);
  }

  const merged = clipMaxLength(mergeCollinear(pixels, maxGap), maxLength);
  merged.sort(
    (a, b) =>
      Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1),
  );
  const lines: LinesValue["lines"] = merged.slice(0, maxLines).map((seg) => ({
    x1: seg.x1 / width,
    y1: seg.y1 / height,
    x2: seg.x2 / width,
    y2: seg.y2 / height,
    score: seg.score,
  }));

  return { lines };
}

interface PixelSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

/** Shrink over-long segments about their midpoint. `maxLength <= 0` skips. */
function clipMaxLength(segs: PixelSeg[], maxLength: number): PixelSeg[] {
  if (!(maxLength > 0)) return segs;
  return segs.map((seg) => {
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dy);
    if (len <= maxLength || len < 1e-6) return seg;
    const half = maxLength / 2;
    const ux = dx / len;
    const uy = dy / len;
    const cx = (seg.x1 + seg.x2) / 2;
    const cy = (seg.y1 + seg.y2) / 2;
    return {
      x1: cx - ux * half,
      y1: cy - uy * half,
      x2: cx + ux * half,
      y2: cy + uy * half,
      score: seg.score,
    };
  });
}

/** Join end-to-end pieces that share a direction — Hough peaks often split one line. */
function mergeCollinear(segs: PixelSeg[], maxGap: number): PixelSeg[] {
  if (segs.length < 2) return segs;
  const left = segs.map((seg) => ({ ...seg, used: false }));
  const out: PixelSeg[] = [];
  const dir = (seg: PixelSeg): [number, number] => {
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  const distToLine = (px: number, py: number, seg: PixelSeg): number => {
    const [ux, uy] = dir(seg);
    return Math.abs((px - seg.x1) * -uy + (py - seg.y1) * ux);
  };
  const interval = (seg: PixelSeg, ux: number, uy: number): [number, number] => {
    const a = seg.x1 * ux + seg.y1 * uy;
    const b = seg.x2 * ux + seg.y2 * uy;
    return a < b ? [a, b] : [b, a];
  };

  for (let i = 0; i < left.length; i += 1) {
    if (left[i]!.used) continue;
    let cur = left[i]!;
    cur.used = true;
    let [ux, uy] = dir(cur);
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < left.length; j += 1) {
        const other = left[j]!;
        if (other.used) continue;
        const [ox, oy] = dir(other);
        if (Math.abs(ux * ox + uy * oy) < 0.97) continue;
        if (
          distToLine(other.x1, other.y1, cur) > maxGap ||
          distToLine(other.x2, other.y2, cur) > maxGap
        ) {
          continue;
        }
        const [a0, a1] = interval(cur, ux, uy);
        const [b0, b1] = interval(other, ux, uy);
        const gap = Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
        if (gap > maxGap) continue;
        const points = [
          [cur.x1, cur.y1],
          [cur.x2, cur.y2],
          [other.x1, other.y1],
          [other.x2, other.y2],
        ] as const;
        let minP = points[0];
        let maxP = points[0];
        let minS = points[0][0] * ux + points[0][1] * uy;
        let maxS = minS;
        for (const p of points) {
          const s = p[0] * ux + p[1] * uy;
          if (s < minS) {
            minS = s;
            minP = p;
          }
          if (s > maxS) {
            maxS = s;
            maxP = p;
          }
        }
        cur = {
          x1: minP[0],
          y1: minP[1],
          x2: maxP[0],
          y2: maxP[1],
          score: Math.max(cur.score, other.score),
          used: true,
        };
        other.used = true;
        [ux, uy] = dir(cur);
        changed = true;
      }
    }
    out.push(cur);
  }
  return out;
}
