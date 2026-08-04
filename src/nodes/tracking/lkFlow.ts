/**
 * Pyramidal Lucas–Kanade optical flow (calcOpticalFlowPyrLK idea) and
 * Shi–Tomasi corner detection helpers shared by Features Tracking.
 */

export type { CornerHit } from "./cornerAlgorithms";
export { detectShiTomasi } from "./cornerAlgorithms";

export interface PyramidLevel {
  data: Float32Array;
  width: number;
  height: number;
}

/** Bilinear sample; returns 0 outside the image. */
export function sampleGray(
  data: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * width + x0;
  const a = data[i]!;
  const b = data[i + 1]!;
  const c = data[i + width]!;
  const d = data[i + width + 1]!;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Half-resolution pyramid via 2×2 box filter (OpenCV-style pyrDown stand-in). */
export function buildPyramid(
  gray: Float32Array,
  width: number,
  height: number,
  maxLevel: number,
): PyramidLevel[] {
  const levels: PyramidLevel[] = [{ data: gray, width, height }];
  for (let level = 1; level <= maxLevel; level += 1) {
    const prev = levels[level - 1]!;
    const w = Math.max(2, prev.width >> 1);
    const h = Math.max(2, prev.height >> 1);
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const sy = Math.min(prev.height - 2, y * 2);
      for (let x = 0; x < w; x += 1) {
        const sx = Math.min(prev.width - 2, x * 2);
        const i = sy * prev.width + sx;
        data[y * w + x] =
          (prev.data[i]! +
            prev.data[i + 1]! +
            prev.data[i + prev.width]! +
            prev.data[i + prev.width + 1]!) *
          0.25;
      }
    }
    levels.push({ data, width: w, height: h });
  }
  return levels;
}

/**
 * Single-level LK refinement. `guessX/Y` is the flow already estimated at this
 * level (from coarser pyramid levels); the point in `prev` is `(x, y)`.
 */
function trackLevel(
  prev: PyramidLevel,
  next: PyramidLevel,
  x: number,
  y: number,
  guessX: number,
  guessY: number,
  halfWin: number,
  maxIters: number,
  epsilon: number,
): { dx: number; dy: number; ok: boolean } {
  let dx = guessX;
  let dy = guessY;
  const minX = halfWin + 1;
  const minY = halfWin + 1;
  const maxX = prev.width - halfWin - 2;
  const maxY = prev.height - halfWin - 2;
  if (x < minX || y < minY || x > maxX || y > maxY) {
    return { dx, dy, ok: false };
  }

  for (let iter = 0; iter < maxIters; iter += 1) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < minX || ny < minY || nx > maxX || ny > maxY) {
      return { dx, dy, ok: false };
    }

    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let sumXT = 0;
    let sumYT = 0;

    for (let wy = -halfWin; wy <= halfWin; wy += 1) {
      for (let wx = -halfWin; wx <= halfWin; wx += 1) {
        const px = x + wx;
        const py = y + wy;
        const ix =
          sampleGray(prev.data, prev.width, prev.height, px + 1, py) -
          sampleGray(prev.data, prev.width, prev.height, px - 1, py);
        const iy =
          sampleGray(prev.data, prev.width, prev.height, px, py + 1) -
          sampleGray(prev.data, prev.width, prev.height, px, py - 1);
        const it =
          sampleGray(next.data, next.width, next.height, nx + wx, ny + wy) -
          sampleGray(prev.data, prev.width, prev.height, px, py);
        sumXX += ix * ix;
        sumYY += iy * iy;
        sumXY += ix * iy;
        sumXT += ix * it;
        sumYT += iy * it;
      }
    }

    const det = sumXX * sumYY - sumXY * sumXY;
    if (Math.abs(det) < 1e-4) return { dx, dy, ok: false };

    // Solve for the displacement that cancels It (I_next − I_prev).
    const vx = (sumXY * sumYT - sumYY * sumXT) / det;
    const vy = (sumXY * sumXT - sumXX * sumYT) / det;
    dx += vx;
    dy += vy;
    if (vx * vx + vy * vy < epsilon * epsilon) break;
  }

  return { dx, dy, ok: true };
}

/** Pyramidal Lucas–Kanade for one point. Coordinates are in level-0 pixels. */
export function trackPointPyrLK(
  prevPyr: PyramidLevel[],
  nextPyr: PyramidLevel[],
  x: number,
  y: number,
  winSize: number,
  maxIters: number,
  epsilon = 0.01,
): { x: number; y: number; ok: boolean } {
  const levels = Math.min(prevPyr.length, nextPyr.length) - 1;
  const halfWin = Math.max(1, winSize >> 1);
  let dx = 0;
  let dy = 0;

  for (let level = levels; level >= 0; level -= 1) {
    const scale = 1 << level;
    const px = x / scale;
    const py = y / scale;
    // Coarser guess scales up when we step down a level.
    if (level < levels) {
      dx *= 2;
      dy *= 2;
    } else {
      dx = 0;
      dy = 0;
    }
    const step = trackLevel(
      prevPyr[level]!,
      nextPyr[level]!,
      px,
      py,
      dx,
      dy,
      halfWin,
      maxIters,
      epsilon,
    );
    if (!step.ok) return { x, y, ok: false };
    dx = step.dx;
    dy = step.dy;
  }

  return { x: x + dx, y: y + dy, ok: true };
}

/**
 * Forward–backward error: track A→B then B→A; large gap means a bad match.
 * Threshold is in level-0 pixels.
 */
export function forwardBackwardOk(
  prevPyr: PyramidLevel[],
  nextPyr: PyramidLevel[],
  x: number,
  y: number,
  trackedX: number,
  trackedY: number,
  winSize: number,
  maxIters: number,
  maxError: number,
): boolean {
  const back = trackPointPyrLK(nextPyr, prevPyr, trackedX, trackedY, winSize, maxIters);
  if (!back.ok) return false;
  const edx = back.x - x;
  const edy = back.y - y;
  return edx * edx + edy * edy <= maxError * maxError;
}
