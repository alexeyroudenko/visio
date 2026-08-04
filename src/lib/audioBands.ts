/**
 * Deterministic FFT band energy from a decoded AudioBuffer at a playhead time.
 *
 * Pure math (no AnalyserNode) so the same buffer + time + band always yields
 * the same 0..1 reading — timeline playback and offline render stay in lockstep.
 */

const DEFAULT_FFT_SIZE = 2048;

/** Next power of two ≥ n, capped so a frame never does a huge transform. */
function fftSizeFor(n: number): number {
  let size = 256;
  while (size < n && size < 8192) size <<= 1;
  return size;
}

/** In-place radix-2 Cooley–Tukey on interleaved re/im (length = 2 * N). */
function fftRadix2(data: Float64Array): void {
  const n = data.length >>> 1;
  // Bit reversal
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ir = i << 1;
      const jr = j << 1;
      const tr = data[ir]!;
      const ti = data[ir + 1]!;
      data[ir] = data[jr]!;
      data[ir + 1] = data[jr + 1]!;
      data[jr] = tr;
      data[jr + 1] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const u = (i + j) << 1;
        const v = (i + j + len / 2) << 1;
        const ur = data[u]!;
        const ui = data[u + 1]!;
        const vr = data[v]! * wRe - data[v + 1]! * wIm;
        const vi = data[v]! * wIm + data[v + 1]! * wRe;
        data[u] = ur + vr;
        data[u + 1] = ui + vi;
        data[v] = ur - vr;
        data[v + 1] = ui - vi;
        const nextRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextRe;
      }
    }
  }
}

/**
 * Mean mono sample window centred on `timeSec`, Hann-weighted, zero-padded at
 * the edges of the buffer. Returns a power-of-two Float64Array of real samples.
 */
export function windowAt(
  buffer: AudioBuffer,
  timeSec: number,
  fftSize = DEFAULT_FFT_SIZE,
): Float64Array {
  const size = fftSizeFor(fftSize);
  const out = new Float64Array(size);
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (channels === 0 || length === 0) return out;

  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch += 1) data.push(buffer.getChannelData(ch));

  const center = Math.floor(timeSec * buffer.sampleRate);
  const half = size >> 1;
  for (let i = 0; i < size; i += 1) {
    const src = center - half + i;
    if (src < 0 || src >= length) continue;
    let sample = 0;
    for (let ch = 0; ch < channels; ch += 1) sample += data[ch]![src]!;
    // Hann: taper edges so a rectangular cut does not spray broadband noise.
    const hann = 0.5 - 0.5 * Math.cos((Math.PI * 2 * i) / size);
    out[i] = (sample / channels) * hann;
  }
  return out;
}

/**
 * Band energy in `[loHz, hiHz]` at `timeSec`, scaled to roughly 0..1 for a
 * full-scale sine sitting inside the band. Empty / silent / invalid → 0.
 */
export function bandEnergy(
  buffer: AudioBuffer,
  timeSec: number,
  loHz: number,
  hiHz: number,
  fftSize = DEFAULT_FFT_SIZE,
): number {
  if (!Number.isFinite(timeSec) || buffer.length === 0 || buffer.sampleRate <= 0) return 0;
  const lo = Math.min(loHz, hiHz);
  const hi = Math.max(loHz, hiHz);
  if (!(hi > lo) || hi <= 0) return 0;

  const size = fftSizeFor(fftSize);
  const samples = windowAt(buffer, timeSec, size);

  // Interleaved complex spectrum.
  const spectrum = new Float64Array(size * 2);
  for (let i = 0; i < size; i += 1) spectrum[i << 1] = samples[i]!;
  fftRadix2(spectrum);

  const binHz = buffer.sampleRate / size;
  const loBin = Math.max(1, Math.floor(lo / binHz));
  const hiBin = Math.min(size / 2 - 1, Math.ceil(hi / binHz));
  if (hiBin < loBin) return 0;

  // A unit-amplitude sine peaks near N/4 after Hann; take the strongest bin in
  // the band so a narrow tone is not diluted by empty neighbours.
  const fullScale = size / 4;
  let peak = 0;
  for (let bin = loBin; bin <= hiBin; bin += 1) {
    const re = spectrum[bin << 1]!;
    const im = spectrum[(bin << 1) + 1]!;
    const mag = Math.hypot(re, im) / fullScale;
    if (mag > peak) peak = mag;
  }
  return Math.min(1, peak);
}

/** Map 0..1 band energy to the −1..1 drive modulators expect (0.5 → 0). */
export function bandDrive(
  buffer: AudioBuffer,
  timeSec: number,
  loHz: number,
  hiHz: number,
  fftSize = DEFAULT_FFT_SIZE,
): number {
  return bandEnergy(buffer, timeSec, loHz, hiHz, fftSize) * 2 - 1;
}
