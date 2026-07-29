import type { HoughRequest, HoughResponse } from "./houghTypes";

let worker: Worker | null = null;
let workerFailed = false;
const listeners = new Map<string, (response: HoughResponse) => void>();

/**
 * One worker for every Hough node in the patch. The transforms are short jobs,
 * and a node only ever has one in flight, so a pool would add plumbing without
 * adding throughput.
 */
function ensureWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./hough.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<HoughResponse>) => {
      listeners.get(event.data.nodeId)?.(event.data);
    };
    worker.onerror = () => {
      // Fall back to the main thread rather than leaving detectors dead.
      workerFailed = true;
      worker = null;
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

export function houghWorkerAvailable(): boolean {
  return ensureWorker() !== null;
}

/**
 * One node's slot on the shared worker.
 *
 * Results arrive a frame or more after the job was posted, so the node keeps
 * showing the previous one until then — the same deal as the frame throttle
 * these detectors already had. Only one job per node is in flight: queueing
 * them up would just build a backlog of stale frames.
 */
export class HoughJob {
  private nextId = 1;
  private pendingId = 0;
  private nodeId: string;
  private onResult: (r: HoughResponse) => void;

  constructor(nodeId: string, onResult: (r: HoughResponse) => void) {
    this.nodeId = nodeId;
    this.onResult = onResult;
    listeners.set(nodeId, (response) => {
      // A job posted before a param change is no longer interesting.
      if (response.id !== this.pendingId) return;
      this.pendingId = 0;
      this.onResult(response);
    });
  }

  get busy(): boolean {
    return this.pendingId !== 0;
  }

  /** Returns false when the worker is unavailable, so the caller can run inline. */
  submit(request: Omit<HoughRequest, "id" | "nodeId">): boolean {
    const active = ensureWorker();
    if (!active) return false;
    this.pendingId = this.nextId++;
    active.postMessage(
      { ...request, id: this.pendingId, nodeId: this.nodeId } satisfies HoughRequest,
      // Copies made by the caller — handing over the buffers avoids a second one.
      [request.gradX.buffer, request.gradY.buffer],
    );
    return true;
  }

  /** Abandon whatever is running; its reply will be dropped on arrival. */
  cancel(): void {
    this.pendingId = 0;
  }

  dispose(): void {
    this.pendingId = 0;
    listeners.delete(this.nodeId);
  }
}
