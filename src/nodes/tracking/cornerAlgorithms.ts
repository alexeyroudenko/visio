import type { PointsValue } from "../../engine/types";

export interface CornerHit {
  x: number;
  y: number;
  score: number;
}

export interface CornerOptions {
  block: number;
  maxCorners: number;
  quality: number;
  /** Min distance in the same pixel space as the gradients. */
  minDistance: number;
  /** Existing points to avoid (same pixel space). */
  avoid?: { x: number; y: number }[];
}

/** Shi–Tomasi corners on a GrayFrame-style buffer (smaller eigenvalue score). */
export function detectShiTomasi(
  gradX: Float32Array,
  gradY: Float32Array,
  width: number,
  height: number,
  opts: CornerOptions,
): CornerHit[] {
  const block = Math.max(3, opts.block | 1);
  const half = block >> 1;
  const responses: CornerHit[] = [];

  for (let y = half + 1; y < height - half - 1; y += half) {
    for (let x = half + 1; x < width - half - 1; x += half) {
      let sumXX = 0;
      let sumYY = 0;
      let sumXY = 0;
      for (let dy = -half; dy <= half; dy += 1) {
        for (let dx = -half; dx <= half; dx += 1) {
          const i = (y + dy) * width + (x + dx);
          const ix = gradX[i]!;
          const iy = gradY[i]!;
          sumXX += ix * ix;
          sumYY += iy * iy;
          sumXY += ix * iy;
        }
      }
      const trace = sumXX + sumYY;
      const det = sumXX * sumYY - sumXY * sumXY;
      const disc = trace * trace - 4 * det;
      if (disc < 0) continue;
      const lambdaMin = (trace - Math.sqrt(disc)) / (2 * block * block);
      if (lambdaMin > 0) responses.push({ x, y, score: lambdaMin });
    }
  }

  if (responses.length === 0) return [];

  responses.sort((a, b) => b.score - a.score);
  const maxScore = responses[0]!.score;
  const minScore = maxScore * opts.quality;
  const minDistSq = opts.minDistance * opts.minDistance;
  const kept: CornerHit[] = [];
  const avoid = opts.avoid ?? [];

  for (const candidate of responses) {
    if (candidate.score < minScore) break;
    if (kept.length >= opts.maxCorners) break;
    let tooClose = false;
    for (const other of kept) {
      const dx = other.x - candidate.x;
      const dy = other.y - candidate.y;
      if (dx * dx + dy * dy < minDistSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    for (const other of avoid) {
      const dx = other.x - candidate.x;
      const dy = other.y - candidate.y;
      if (dx * dx + dy * dy < minDistSq) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) kept.push(candidate);
  }

  return kept;
}

/** Normalize Shi–Tomasi hits into the graph's PointsValue. */
export function pointsFromCorners(hits: CornerHit[], width: number, height: number): PointsValue {
  if (hits.length === 0) return { points: [] };
  const maxScore = hits[0]!.score;
  return {
    points: hits.map((point) => ({
      x: point.x / width,
      y: point.y / height,
      score: point.score / maxScore,
    })),
  };
}
