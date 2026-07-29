/// <reference lib="webworker" />
/**
 * Runs the Hough transforms off the main thread. The node still reads and
 * downscales the frame — that needs a canvas — and sends the Sobel gradients
 * here, which is where the expensive part lives.
 */
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
  const edges = collectEdges(
    job.gradX,
    job.gradY,
    job.width,
    job.height,
    job.edgeThreshold,
    MAX_EDGES,
  );

  const response: HoughResponse =
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

  (self as unknown as Worker).postMessage(response);
};
