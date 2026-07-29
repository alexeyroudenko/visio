import type { LandmarksValue, PointsValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";

const EMPTY: PointsValue = { points: [] };

/**
 * Flatten pose/hands/face landmark sets into a point cloud for Draw Points,
 * Features Grid-style FX, etc.
 */
export const landmarksToPointsNode = defineNode<Record<string, never>>({
  type: "convert.landmarksToPoints",
  label: "Landmarks → Points",
  category: "tracking",
  description: "Flattens landmark sets into a point cloud (x, y, score).",
  inputs: [{ id: "landmarks", label: "landmarks", type: "landmarks" }],
  outputs: [{ id: "points", label: "points", type: "points" }],
  params: [
    {
      key: "minScore",
      label: "Min score",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.2,
    },
    {
      key: "subject",
      label: "Subject",
      type: "range",
      min: -1,
      max: 8,
      step: 1,
      default: -1,
    },
  ],
  createState() {
    return {};
  },
  evaluate({ inputs, params }) {
    const data = inputs.landmarks as LandmarksValue | null;
    if (!data || data.sets.length === 0) return { points: EMPTY };

    const minScore = paramNumber(params, "minScore", 0.2);
    const subject = Math.round(paramNumber(params, "subject", -1));
    const sets =
      subject < 0
        ? data.sets
        : subject < data.sets.length
          ? [data.sets[subject]!]
          : [];

    const points: PointsValue["points"] = [];
    for (const set of sets) {
      for (const lm of set) {
        if (lm.score < minScore) continue;
        points.push({ x: lm.x, y: lm.y, score: lm.score });
      }
    }

    return { points: { points } };
  },
});
