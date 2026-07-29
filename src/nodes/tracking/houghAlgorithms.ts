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
  maxGap: number;
  maxLines: number;
}

/** Scratch reused across calls — one caller at a time, per thread. */
const scratch = {
  accumulator: new Float32Array(0),
  smoothed: new Float32Array(0),
  histogram: new Float32Array(0),
  lineAcc: new Int32Array(0),
  cosTable: new Float32Array(0),
  sinTable: new Float32Array(0),
  tableSize: 0,
};

/**
 * Edge points above `threshold`, evenly subsampled to at most `limit` so the
 * accumulators stay dense enough to peak without blowing up cost.
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
  if (raw.length <= limit) return raw;

  const step = Math.ceil(raw.length / limit);
  const sampled: EdgePoint[] = [];
  for (let i = 0; i < raw.length; i += step) sampled.push(raw[i]!);
  return sampled;
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

  const { maxLines, minLength, maxGap } = opts;
  const lines: LinesValue["lines"] = [];
  const maxCandidates = Math.max(maxLines * 8, 64);

  const pushSegment = (start: EdgePoint, end: EdgePoint, votes: number): void => {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < minLength) return;
    lines.push({
      x1: start.x / width,
      y1: start.y / height,
      x2: end.x / width,
      y2: end.y / height,
      score: Math.min(1, votes / (threshold * 3)),
    });
  };

  for (let ci = 0; ci < candidates.length && ci < maxCandidates; ci += 1) {
    if (lines.length >= maxLines) break;
    const { ri, theta, votes } = candidates[ci]!;
    const rho = (ri - rhoOffset) * rhoStep;
    const cosT = cosTable[theta]!;
    const sinT = sinTable[theta]!;

    const onLine = edges.filter(
      (edge) => Math.abs(edge.x * cosT + edge.y * sinT - rho) < rhoStep * 1.5,
    );
    if (onLine.length < 2) continue;

    // Walk the edge points along the line and cut at gaps.
    const dirX = -sinT;
    const dirY = cosT;
    onLine.sort((a, b) => a.x * dirX + a.y * dirY - (b.x * dirX + b.y * dirY));

    let segStart = onLine[0]!;
    let segEnd = segStart;
    for (let i = 1; i < onLine.length; i += 1) {
      const point = onLine[i]!;
      if (Math.hypot(point.x - segEnd.x, point.y - segEnd.y) <= maxGap) {
        segEnd = point;
      } else {
        pushSegment(segStart, segEnd, votes);
        if (lines.length >= maxLines) break;
        segStart = point;
        segEnd = point;
      }
    }
    if (lines.length < maxLines) pushSegment(segStart, segEnd, votes);
  }

  return { lines };
}
