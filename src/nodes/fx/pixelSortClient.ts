import type { PixelSortRequest, PixelSortResponse } from "./pixelSortTypes";

let worker: Worker | null = null;
let workerFailed = false;
const listeners = new Map<string, (response: PixelSortResponse) => void>();

function ensureWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./pixelSort.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<PixelSortResponse>) => {
      listeners.get(event.data.nodeId)?.(event.data);
    };
    worker.onerror = () => {
      workerFailed = true;
      worker = null;
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

export function pixelSortWorkerAvailable(): boolean {
  return ensureWorker() !== null;
}

/**
 * One node's slot on the Pixel Sort worker. Same latency model as Hough: show
 * the previous texture until the sorted words land, and never queue a backlog.
 */
export class PixelSortJob {
  private nextId = 1;
  private pendingId = 0;
  private nodeId: string;
  private onResult: (r: PixelSortResponse) => void;

  constructor(nodeId: string, onResult: (r: PixelSortResponse) => void) {
    this.nodeId = nodeId;
    this.onResult = onResult;
    listeners.set(nodeId, (response) => {
      if (response.id !== this.pendingId) return;
      this.pendingId = 0;
      this.onResult(response);
    });
  }

  get busy(): boolean {
    return this.pendingId !== 0;
  }

  /** Returns false when the worker is unavailable, so the caller can run inline. */
  submit(request: Omit<PixelSortRequest, "id" | "nodeId">): boolean {
    const active = ensureWorker();
    if (!active) return false;
    this.pendingId = this.nextId++;
    active.postMessage(
      { ...request, id: this.pendingId, nodeId: this.nodeId } satisfies PixelSortRequest,
      [request.words.buffer],
    );
    return true;
  }

  cancel(): void {
    this.pendingId = 0;
  }

  dispose(): void {
    this.pendingId = 0;
    listeners.delete(this.nodeId);
  }
}
