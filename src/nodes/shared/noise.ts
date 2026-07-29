/**
 * Value noise on a 3D lattice — the third axis is time, so a field can be
 * animated by walking it instead of by re-randomizing every frame.
 *
 * Value rather than gradient noise: it is a few lines, has no permutation table
 * to keep around, and at the scales these nodes use the difference is not
 * visible. Everything is a pure function of (position, seed), so a given seed
 * always reproduces the same field — offline renders match what playback showed.
 */

/** Deterministic hash of a lattice cell → 0..1. */
function hashCell(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393);
  h = (h + Math.imul(iy | 0, 668265263)) | 0;
  h = (h + Math.imul(iz | 0, 1274126177)) | 0;
  h = (h + Math.imul(seed | 0, 1013904223)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep — zero first derivative at the lattice points, so no creases. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Trilinearly interpolated value noise. Returns 0..1. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const fz = fade(z - z0);

  const c000 = hashCell(x0, y0, z0, seed);
  const c100 = hashCell(x0 + 1, y0, z0, seed);
  const c010 = hashCell(x0, y0 + 1, z0, seed);
  const c110 = hashCell(x0 + 1, y0 + 1, z0, seed);
  const c001 = hashCell(x0, y0, z0 + 1, seed);
  const c101 = hashCell(x0 + 1, y0, z0 + 1, seed);
  const c011 = hashCell(x0, y0 + 1, z0 + 1, seed);
  const c111 = hashCell(x0 + 1, y0 + 1, z0 + 1, seed);

  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0v = x00 + (x10 - x00) * fy;
  const y1v = x01 + (x11 - x01) * fy;
  return y0v + (y1v - y0v) * fz;
}

/**
 * Fractal sum of `octaves` doublings. Normalized back to 0..1 so the octave
 * count changes the detail, not the overall level.
 */
export function fbm3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves: number,
): number {
  const count = Math.max(1, Math.min(6, Math.round(octaves)));
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;

  for (let i = 0; i < count; i += 1) {
    sum += valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 1013) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return sum / total;
}
