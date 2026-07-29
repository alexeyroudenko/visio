/**
 * Waveform peaks, the same shape granular-video uses: a flat
 * `[min0, max0, min1, max1, …]` per column, channels mixed to mono.
 *
 * Peaks are computed once at a fixed resolution and squeezed to whatever width
 * a clip happens to be — decoding is the expensive part and a timeline clip
 * changes width on every zoom step.
 */
export const PEAK_COLUMNS = 4096;

export function computePeaks(buffer: AudioBuffer, width: number): Float32Array {
  const peaks = new Float32Array(width * 2);
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const perColumn = length / width;

  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch += 1) data.push(buffer.getChannelData(ch));

  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * perColumn);
    const end = Math.min(length, Math.floor((x + 1) * perColumn));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i += 1) {
      let sample = 0;
      for (let ch = 0; ch < channels; ch += 1) sample += data[ch]![i]!;
      sample /= channels;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

/**
 * Re-bucket peaks to a different column count. Widening cannot invent detail,
 * so it repeats; narrowing takes the extremes of each group, which is what keeps
 * a zoomed-out waveform from losing its transients to averaging.
 */
export function resamplePeaks(peaks: Float32Array, width: number): Float32Array {
  const source = peaks.length / 2;
  if (width === source) return peaks;

  const out = new Float32Array(width * 2);
  const perColumn = source / width;
  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * perColumn);
    const end = Math.max(start + 1, Math.min(source, Math.floor((x + 1) * perColumn)));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const lo = peaks[i * 2]!;
      const hi = peaks[i * 2 + 1]!;
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    out[x * 2] = min;
    out[x * 2 + 1] = max;
  }
  return out;
}
