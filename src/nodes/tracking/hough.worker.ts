/// <reference lib="webworker" />
/**
 * Runs the Hough transforms (and Shi–Tomasi corners) off the main thread.
 * The node still reads and downscales the frame — that needs a canvas — and
 * sends the Sobel gradients here, which is where the expensive part lives.
 */
import { detectShiTomasi, pointsFromCorners, type CornerOptions } from "./cornerAlgorithms";
import {
  circlesFromEdges,
  collectEdges,
  linesFromEdges,
  MAX_EDGES,
  type CircleOptions,
  type LineOptions,
} from "./houghAlgorithms";
import type { HoughRequest, HoughResponse } from "./houghTypes";

self.onmessage = (event: MessageEvent<HoughRequest>) => {
  const job = event.data;

  let response: HoughResponse;
  if (job.kind === "corners") {
    const hits = detectShiTomasi(
      job.gradX,
      job.gradY,
      job.width,
      job.height,
      job.options as CornerOptions,
    );
    response = {
      id: job.id,
      nodeId: job.nodeId,
      kind: "corners",
      value: pointsFromCorners(hits, job.width, job.height),
    };
  } else {
    const edges = collectEdges(
      job.gradX,
      job.gradY,
      job.width,
      job.height,
      job.edgeThreshold ?? 90,
      MAX_EDGES,
    );

    response =
      job.kind === "circles"
        ? {
            id: job.id,
            nodeId: job.nodeId,
            kind: "circles",
            value:
              edges.length === 0
                ? { circles: [] }
                : circlesFromEdges(edges, job.width, job.height, job.options as CircleOptions),
          }
        : {
            id: job.id,
            nodeId: job.nodeId,
            kind: "lines",
            value:
              edges.length === 0
                ? { lines: [] }
                : linesFromEdges(edges, job.width, job.height, job.options as LineOptions),
          };
  }

  (self as unknown as Worker).postMessage(response);
};
