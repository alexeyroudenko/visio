/// <reference lib="webworker" />
/**
 * Counting-sort spans off the main thread. The node still does GL readback /
 * writeback; this only owns luminance + sortSpans.
 */
import { BINS, sortFrame } from "./pixelSortAlgorithms";
import type { PixelSortRequest, PixelSortResponse } from "./pixelSortTypes";

let lum = new Uint8Array(0);
let counts = new Uint32Array(BINS);
let scratch = new Uint32Array(0);

self.onmessage = (event: MessageEvent<PixelSortRequest>) => {
  const job = event.data;
  const pixels = job.width * job.height;
  if (lum.length !== pixels) lum = new Uint8Array(pixels);
  const longest = Math.max(job.width, job.height);
  if (scratch.length !== longest) scratch = new Uint32Array(longest);

  const start = performance.now();
  sortFrame(job.words, job.width, job.height, job.thresh, job.vert, lum, counts, scratch);
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
