/**
 * Frame-to-frame identity for rectangles.
 *
 * A Mondrian grid is rebuilt from scratch every frame, so a cell that visually
 * "stays put" is a brand new object each tick. Anything that reacts to a
 * rectangle *appearing* — a grain that loops while it exists — needs to tell
 * "the same cell, nudged" from "a new cell", which is what the ids here are for.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrackedRect extends Rect {
  /** Stable while the rectangle keeps being matched. Never reused. */
  id: number;
  /** Frames since this id first appeared, holds included. */
  age: number;
  /** Frames since it was last actually seen; 0 while present. */
  missing: number;
}

export interface RectTrackerOptions {
  /** Minimum intersection-over-union to call two rectangles the same one. */
  minIou: number;
  /** Frames a vanished rectangle keeps its id, still reported at its last box. */
  hold: number;
}

/** Intersection over union. 0 when the rectangles do not overlap at all. */
export function rectIou(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;

  const overlap = (right - left) * (bottom - top);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Greedy IoU matcher. Cell counts are small (tens), so the full pair list is
 * cheaper than any spatial index would be, and taking the best overlaps first
 * keeps a split cell from stealing its neighbour's id.
 */
export class RectTracker {
  private tracked: TrackedRect[] = [];
  private nextId = 1;

  /** Ids issued so far — lets a caller tell "reset" from "nothing seen yet". */
  get issued(): number {
    return this.nextId - 1;
  }

  reset(): void {
    this.tracked = [];
    this.nextId = 1;
  }

  update(rects: readonly Rect[], options: RectTrackerOptions): TrackedRect[] {
    const minIou = Math.max(0, Math.min(0.99, options.minIou));
    const hold = Math.max(0, Math.round(options.hold));
    const previous = this.tracked;

    const pairs: { index: number; slot: number; iou: number }[] = [];
    for (let index = 0; index < rects.length; index += 1) {
      for (let slot = 0; slot < previous.length; slot += 1) {
        const iou = rectIou(rects[index]!, previous[slot]!);
        if (iou >= minIou && iou > 0) pairs.push({ index, slot, iou });
      }
    }
    pairs.sort((a, b) => b.iou - a.iou);

    const claimedNew = new Set<number>();
    const claimedOld = new Set<number>();
    const matched = new Array<TrackedRect | null>(rects.length).fill(null);

    for (const pair of pairs) {
      if (claimedNew.has(pair.index) || claimedOld.has(pair.slot)) continue;
      claimedNew.add(pair.index);
      claimedOld.add(pair.slot);
      matched[pair.index] = previous[pair.slot]!;
    }

    const next: TrackedRect[] = [];
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index]!;
      const hit = matched[index];
      if (hit) {
        hit.x = rect.x;
        hit.y = rect.y;
        hit.w = rect.w;
        hit.h = rect.h;
        hit.age += 1;
        hit.missing = 0;
        next.push(hit);
      } else {
        next.push({ id: this.nextId++, ...rect, age: 1, missing: 0 });
      }
    }

    // Survivors nobody claimed keep reporting their last box for `hold` frames,
    // so a one-frame gap in the tracking does not retrigger everything.
    for (let slot = 0; slot < previous.length; slot += 1) {
      if (claimedOld.has(slot)) continue;
      const ghost = previous[slot]!;
      ghost.age += 1;
      ghost.missing += 1;
      if (ghost.missing <= hold) next.push(ghost);
    }

    this.tracked = next;
    return next;
  }
}
