/// <reference lib="webworker" />
/**
 * Counting-sort spans off the main thread. The node still does GL readback /
 * writeback; this only owns luminance + sortSpans.
 */
import { BINS, effectiveSortAngle, sortFrameAtAngle } from "./pixelSortAlgorithms";
import type { PixelSortRequest, PixelSortResponse } from "./pixelSortTypes";

let lum = new Uint8Array(0);
let counts = new Uint32Array(BINS);
let scratch = new Uint32Array(0);

self.onmessage = (event: MessageEvent<PixelSortRequest>) => {
  const job = event.data;
  const pixels = job.width * job.height;
  const diagonal = Math.ceil(Math.hypot(job.width, job.height)) + 2;
  if (lum.length < Math.max(pixels, diagonal * diagonal)) {
    lum = new Uint8Array(Math.max(pixels, diagonal * diagonal));
  }
  if (scratch.length < diagonal) scratch = new Uint32Array(diagonal);

  const angle = effectiveSortAngle(job.rotation ?? 0, job.vert);
  const start = performance.now();
  sortFrameAtAngle(
    job.words,
    job.width,
    job.height,
    job.thresh,
    angle,
    lum,
    counts,
    scratch,
  );
  const sortMs = performance.now() - start;

  const response: PixelSortResponse = {
    id: job.id,
    nodeId: job.nodeId,
    words: job.words,
    width: job.width,
    height: job.height,
    sortMs,
  };
  (self as unknown as Worker).postMessage(response, [job.words.buffer]);
};
