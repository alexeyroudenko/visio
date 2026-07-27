import type { FilesetResolver } from "@mediapipe/tasks-vision";

export const VISION_WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

type TasksVision = typeof import("@mediapipe/tasks-vision");

let modulePromise: Promise<TasksVision> | null = null;

/**
 * @mediapipe/tasks-vision is ~250 kB of the bundle, and a patch made only of
 * CPU trackers never touches it — so it loads on demand, the first time a
 * MediaPipe node actually builds its task.
 */
export function loadTasksVision(): Promise<TasksVision> {
  if (!modulePromise) modulePromise = import("@mediapipe/tasks-vision");
  return modulePromise;
}

let filesetPromise: Promise<unknown> | null = null;

/** The WASM fileset is shared by every vision task in the patch. */
export function loadVisionFileset(): Promise<
  Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
> {
  if (!filesetPromise) {
    filesetPromise = loadTasksVision().then((mp) =>
      mp.FilesetResolver.forVisionTasks(VISION_WASM),
    );
  }
  return filesetPromise as Promise<
    Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
  >;
}

/** MediaPipe ships connections as {start,end}; the draw nodes want tuples. */
export function toConnections(
  list: ReadonlyArray<{ start: number; end: number }>,
): ReadonlyArray<readonly [number, number]> {
  return list.map((c) => [c.start, c.end] as const);
}

/** detectForVideo rejects non-increasing timestamps, so clamp per node. */
export class Monotonic {
  private last = -1;

  next(candidate: number): number {
    const value = Math.max(Math.round(candidate), this.last + 1);
    this.last = value;
    return value;
  }
}
