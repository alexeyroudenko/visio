/**
 * Geometry helpers for point-cloud draw nodes: Delaunay, Voronoi dual,
 * MST constellation, radial spokes. Coordinates are pixel-space.
 */

export interface MeshPoint {
  x: number;
  y: number;
}

export type Triangle = readonly [number, number, number];
export type Segment = readonly [number, number];

const EPS = 1e-9;

function distSq(a: MeshPoint, b: MeshPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Signed area ×2; positive means a→b→c is counter-clockwise. */
function orient(a: MeshPoint, b: MeshPoint, c: MeshPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Circumcircle test: true if p is strictly inside the circumcircle of abc. */
function inCircumcircle(a: MeshPoint, b: MeshPoint, c: MeshPoint, p: MeshPoint): boolean {
  // Flip to CCW so the determinant sign is stable regardless of input winding.
  let A = a;
  let B = b;
  let C = c;
  if (orient(A, B, C) < 0) {
    const tmp = B;
    B = C;
    C = tmp;
  }
  const ax = A.x - p.x;
  const ay = A.y - p.y;
  const bx = B.x - p.x;
  const by = B.y - p.y;
  const cx = C.x - p.x;
  const cy = C.y - p.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  return det > EPS;
}

function circumcenter(a: MeshPoint, b: MeshPoint, c: MeshPoint): MeshPoint | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < EPS) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}

/**
 * Bowyer–Watson Delaunay triangulation. Drops near-duplicate points.
 * Returns triangles as index triples into the (possibly deduped) point list —
 * callers should use {@link dedupePoints} first or pass raw points (deduped here).
 */
export function delaunayTriangles(raw: ReadonlyArray<MeshPoint>): {
  points: MeshPoint[];
  triangles: Triangle[];
} {
  const points = dedupePoints(raw);
  if (points.length < 3) return { points, triangles: [] };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const dMax = Math.max(dx, dy) * 10;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  // Super-triangle indices live past the real points and are stripped at the end.
  const superA = points.length;
  const superB = points.length + 1;
  const superC = points.length + 2;
  // Super-triangle in CCW order (y grows down; still CCW in cartesian sense).
  const all: MeshPoint[] = [
    ...points,
    { x: midX - 2 * dMax, y: midY - dMax },
    { x: midX + 2 * dMax, y: midY - dMax },
    { x: midX, y: midY + 2 * dMax },
  ];

  let triangles: Triangle[] = [[superA, superB, superC]];
  // Ensure the seed triangle itself is CCW for the circumcircle test.
  {
    const a = all[superA]!;
    const b = all[superB]!;
    const c = all[superC]!;
    if (orient(a, b, c) < 0) triangles = [[superA, superC, superB]];
  }

  for (let i = 0; i < points.length; i += 1) {
    const p = all[i]!;
    const bad: Triangle[] = [];
    for (const t of triangles) {
      const a = all[t[0]]!;
      const b = all[t[1]]!;
      const c = all[t[2]]!;
      if (inCircumcircle(a, b, c, p)) bad.push(t);
    }

    // Polygon hole boundary = edges that appear once among bad triangles.
    const edgeCount = new Map<string, [number, number]>();
    const bump = (u: number, v: number) => {
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      const key = `${a}:${b}`;
      const prev = edgeCount.get(key);
      if (prev) edgeCount.delete(key);
      else edgeCount.set(key, [a, b]);
    };
    for (const t of bad) {
      bump(t[0], t[1]);
      bump(t[1], t[2]);
      bump(t[2], t[0]);
    }

    const badSet = new Set(bad);
    triangles = triangles.filter((t) => !badSet.has(t));
    for (const [, [u, v]] of edgeCount) {
      triangles.push([u, v, i]);
    }
  }

  const kept = triangles.filter(
    (t) => t[0] < points.length && t[1] < points.length && t[2] < points.length,
  );
  return { points, triangles: kept };
}

export function dedupePoints(
  raw: ReadonlyArray<MeshPoint>,
  minDist = 0.5,
): MeshPoint[] {
  const minDistSq = minDist * minDist;
  const out: MeshPoint[] = [];
  for (const p of raw) {
    let ok = true;
    for (const q of out) {
      if (distSq(p, q) < minDistSq) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Unique undirected edges of a triangulation. */
export function triangleEdges(triangles: ReadonlyArray<Triangle>): Segment[] {
  const seen = new Set<string>();
  const edges: Segment[] = [];
  const add = (u: number, v: number) => {
    const a = Math.min(u, v);
    const b = Math.max(u, v);
    const key = `${a}:${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  for (const t of triangles) {
    add(t[0], t[1]);
    add(t[1], t[2]);
    add(t[2], t[0]);
  }
  return edges;
}

/**
 * Voronoi edges as pixel segments clipped to the frame.
 * Built as the dual of the Delaunay mesh (shared-triangle circumcenters;
 * hull edges extend to the bbox).
 */
export function voronoiSegments(
  points: ReadonlyArray<MeshPoint>,
  triangles: ReadonlyArray<Triangle>,
  width: number,
  height: number,
): Array<readonly [MeshPoint, MeshPoint]> {
  if (triangles.length === 0) return [];

  const centers: (MeshPoint | null)[] = triangles.map((t) =>
    circumcenter(points[t[0]]!, points[t[1]]!, points[t[2]]!),
  );

  type EdgeKey = string;
  const edgeTris = new Map<EdgeKey, number[]>();
  const keyOf = (u: number, v: number): EdgeKey =>
    u < v ? `${u}:${v}` : `${v}:${u}`;

  triangles.forEach((t, ti) => {
    const edges: Segment[] = [
      [t[0], t[1]],
      [t[1], t[2]],
      [t[2], t[0]],
    ];
    for (const [u, v] of edges) {
      const key = keyOf(u, v);
      const list = edgeTris.get(key);
      if (list) list.push(ti);
      else edgeTris.set(key, [ti]);
    }
  });

  const segs: Array<readonly [MeshPoint, MeshPoint]> = [];
  for (const [key, tris] of edgeTris) {
    const [us, vs] = key.split(":").map(Number) as [number, number];
    if (tris.length === 2) {
      const c0 = centers[tris[0]!]!;
      const c1 = centers[tris[1]!]!;
      if (!c0 || !c1) continue;
      const clipped = clipSegment(c0, c1, width, height);
      if (clipped) segs.push(clipped);
      continue;
    }
    // Hull edge: ray from circumcenter through the edge midpoint, away from
    // the third vertex of the only triangle.
    const ti = tris[0]!;
    const t = triangles[ti]!;
    const c = centers[ti];
    if (!c) continue;
    const third = t[0] === us ? (t[1] === vs ? t[2]! : t[1]!) : t[0] === vs ? (t[1] === us ? t[2]! : t[1]!) : t[0]!;
    const mid: MeshPoint = {
      x: (points[us]!.x + points[vs]!.x) / 2,
      y: (points[us]!.y + points[vs]!.y) / 2,
    };
    let dx = mid.x - c.x;
    let dy = mid.y - c.y;
    // Ensure the ray goes outward (away from the third vertex).
    const toThirdX = points[third]!.x - mid.x;
    const toThirdY = points[third]!.y - mid.y;
    if (dx * toThirdX + dy * toThirdY > 0) {
      dx = -dx;
      dy = -dy;
    }
    const len = Math.hypot(dx, dy) || 1;
    const far: MeshPoint = {
      x: c.x + (dx / len) * (width + height),
      y: c.y + (dy / len) * (width + height),
    };
    const clipped = clipSegment(c, far, width, height);
    if (clipped) segs.push(clipped);
  }
  return segs;
}

/**
 * Voronoi cell polygons (clipped to the frame) for mosaic fill.
 * Built by successive half-plane clips of the frame against every other site —
 * works for hull sites and for n < 4 (where the dual has no closed cells).
 */
export function voronoiCells(
  points: ReadonlyArray<MeshPoint>,
  _triangles: ReadonlyArray<Triangle>,
  width: number,
  height: number,
): MeshPoint[][] {
  const cells: MeshPoint[][] = points.map(() => []);
  if (points.length === 0) return cells;

  const frame: MeshPoint[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];

  for (let i = 0; i < points.length; i += 1) {
    const site = points[i]!;
    let poly = frame;
    for (let j = 0; j < points.length; j += 1) {
      if (i === j || poly.length === 0) continue;
      const other = points[j]!;
      // Keep the half-plane closer to `site` than to `other` (perpendicular bisector).
      const mx = (site.x + other.x) / 2;
      const my = (site.y + other.y) / 2;
      const nx = other.x - site.x;
      const ny = other.y - site.y;
      poly = clipHalfPlane(poly, mx, my, nx, ny);
    }
    if (poly.length >= 3) cells[i] = poly;
  }
  return cells;
}

/**
 * Keep the side of the polygon where (p - mid) · n ≤ 0
 * (points closer to the site that sits opposite the normal).
 */
function clipHalfPlane(
  poly: ReadonlyArray<MeshPoint>,
  mx: number,
  my: number,
  nx: number,
  ny: number,
): MeshPoint[] {
  if (poly.length === 0) return [];
  const inside = (p: MeshPoint) => (p.x - mx) * nx + (p.y - my) * ny <= EPS;
  const intersect = (a: MeshPoint, b: MeshPoint): MeshPoint => {
    const da = (a.x - mx) * nx + (a.y - my) * ny;
    const db = (b.x - mx) * nx + (b.y - my) * ny;
    const t = da / (da - db || EPS);
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  };

  const out: MeshPoint[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const cur = poly[i]!;
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

/** Prim MST over points; returns index pairs. */
export function mstSegments(points: ReadonlyArray<MeshPoint>): Segment[] {
  const n = points.length;
  if (n < 2) return [];

  const inTree = new Uint8Array(n);
  const bestDist = new Float64Array(n);
  const parent = new Int32Array(n);
  bestDist.fill(Infinity);
  parent.fill(-1);
  bestDist[0] = 0;

  for (let iter = 0; iter < n; iter += 1) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (!inTree[i] && bestDist[i]! < best) {
        best = bestDist[i]!;
        u = i;
      }
    }
    if (u < 0) break;
    inTree[u] = 1;
    const pu = points[u]!;
    for (let v = 0; v < n; v += 1) {
      if (inTree[v]) continue;
      const d = distSq(pu, points[v]!);
      if (d < bestDist[v]!) {
        bestDist[v] = d;
        parent[v] = u;
      }
    }
  }

  const edges: Segment[] = [];
  for (let v = 1; v < n; v += 1) {
    const u = parent[v]!;
    if (u >= 0) edges.push([u, v]);
  }
  return edges;
}

/**
 * Radial spokes.
 * - `centroid`: every point linked to the cloud centroid (synthetic hub).
 * - `hub`: each point linked to its k nearest neighbours (star-ish web).
 */
export function radialSegments(
  points: ReadonlyArray<MeshPoint>,
  mode: "centroid" | "hub",
  k = 1,
): { hubs: MeshPoint[]; segments: Array<readonly [MeshPoint, MeshPoint]> } {
  if (points.length === 0) return { hubs: [], segments: [] };

  if (mode === "centroid") {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    const hub: MeshPoint = { x: sx / points.length, y: sy / points.length };
    return {
      hubs: [hub],
      segments: points.map((p) => [hub, p] as const),
    };
  }

  const kk = Math.max(1, Math.min(k, points.length - 1));
  const segments: Array<readonly [MeshPoint, MeshPoint]> = [];
  const seen = new Set<string>();
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const order = points
      .map((b, j) => ({ j, d: j === i ? Infinity : distSq(a, b) }))
      .sort((u, v) => u.d - v.d);
    for (let n = 0; n < kk; n += 1) {
      const j = order[n]!.j;
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const key = `${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push([a, points[j]!]);
    }
  }
  return { hubs: [], segments };
}

/** Liang–Barsky clip of a segment to [0,width]×[0,height]. */
export function clipSegment(
  a: MeshPoint,
  b: MeshPoint,
  width: number,
  height: number,
): readonly [MeshPoint, MeshPoint] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < EPS) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (
    clip(-dx, a.x) &&
    clip(dx, width - a.x) &&
    clip(-dy, a.y) &&
    clip(dy, height - a.y) &&
    t0 <= t1
  ) {
    return [
      { x: a.x + t0 * dx, y: a.y + t0 * dy },
      { x: a.x + t1 * dx, y: a.y + t1 * dy },
    ];
  }
  return null;
}

/** Sutherland–Hodgman clip against the frame rectangle. */
export function clipPolygon(
  poly: ReadonlyArray<MeshPoint>,
  width: number,
  height: number,
): MeshPoint[] {
  const edges: Array<(p: MeshPoint) => boolean> = [
    (p) => p.x >= 0,
    (p) => p.x <= width,
    (p) => p.y >= 0,
    (p) => p.y <= height,
  ];
  const intersect: Array<(a: MeshPoint, b: MeshPoint) => MeshPoint> = [
    (a, b) => {
      const t = (0 - a.x) / (b.x - a.x || EPS);
      return { x: 0, y: a.y + t * (b.y - a.y) };
    },
    (a, b) => {
      const t = (width - a.x) / (b.x - a.x || EPS);
      return { x: width, y: a.y + t * (b.y - a.y) };
    },
    (a, b) => {
      const t = (0 - a.y) / (b.y - a.y || EPS);
      return { x: a.x + t * (b.x - a.x), y: 0 };
    },
    (a, b) => {
      const t = (height - a.y) / (b.y - a.y || EPS);
      return { x: a.x + t * (b.x - a.x), y: height };
    },
  ];

  let output = [...poly];
  for (let e = 0; e < 4; e += 1) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    const inside = edges[e]!;
    const hit = intersect[e]!;
    for (let i = 0; i < input.length; i += 1) {
      const cur = input[i]!;
      const prev = input[(i + input.length - 1) % input.length]!;
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) output.push(hit(prev, cur));
        output.push(cur);
      } else if (prevIn) {
        output.push(hit(prev, cur));
      }
    }
  }
  return output;
}

/** Sample RGB at a pixel (clamped), from an ImageData-like buffer. */
export function sampleRgb(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  const px = Math.max(0, Math.min(width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(height - 1, Math.round(y)));
  const idx = (py * width + px) * 4;
  return { r: data[idx]!, g: data[idx + 1]!, b: data[idx + 2]! };
}
