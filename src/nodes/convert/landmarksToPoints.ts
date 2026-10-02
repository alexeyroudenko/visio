import type { Landmark, LandmarksValue, PointsValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";

const EMPTY: PointsValue = { points: [] };

/** BlazePose: 0 nose, 1–10 face, 11–32 body. */
const POSE_LEN = 33;
const POSE_FACE_END = 11;
const POSE_NOSE = 0;
const POSE_EAR_L = 7;
const POSE_EAR_R = 8;
const POSE_SHOULDER_L = 11;
const POSE_SHOULDER_R = 12;

/** Face Mesh: tip of the nose → mid-forehead; oval kept first when thinning. */
const FACE_MESH_MIN = 468;
const FACE_NOSE = 4;
const FACE_FOREHEAD = 10;
/** MediaPipe FACE_LANDMARKS_FACE_OVAL vertex indices. */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400,
  377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67,
  109,
];

/** Pose face indices that form the readable head (prefer when thinning). */
const POSE_FACE_PRIORITY = [0, 7, 8, 2, 5, 1, 4, 9, 10, 3, 6];

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Keep ~frac of face landmarks with spatial spacing (farthest-point), seeded by
 * a silhouette priority list so Connectors still find short face edges.
 */
function pickFaceSlots(
  set: Landmark[],
  start: number,
  count: number,
  frac: number,
  seeds: readonly number[],
): boolean[] {
  const keep = Math.round(count * clamp01(frac));
  const out = new Array<boolean>(count).fill(false);
  if (keep <= 0 || count <= 0) return out;
  if (keep >= count) return out.fill(true);

  const selected: number[] = [];
  const taken = new Array<boolean>(count).fill(false);

  for (const abs of seeds) {
    const local = abs - start;
    if (local < 0 || local >= count || taken[local]) continue;
    taken[local] = true;
    selected.push(local);
    if (selected.length >= keep) break;
  }
  if (selected.length === 0) {
    taken[0] = true;
    selected.push(0);
  }

  while (selected.length < keep) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < count; i += 1) {
      if (taken[i]) continue;
      const lm = set[start + i]!;
      let minD = Infinity;
      for (let s = 0; s < selected.length; s += 1) {
        const o = set[start + selected[s]!]!;
        const dx = lm.x - o.x;
        const dy = lm.y - o.y;
        const d = dx * dx + dy * dy;
        if (d < minD) minD = d;
      }
      if (minD > bestD) {
        bestD = minD;
        best = i;
      }
    }
    if (best < 0) break;
    taken[best] = true;
    selected.push(best);
  }

  for (let s = 0; s < selected.length; s += 1) out[selected[s]!] = true;
  return out;
}

const POSE_HIP_L = 23;
const POSE_HIP_R = 24;

function bodyCenter(set: Landmark[]): { x: number; y: number } | null {
  if (set.length === POSE_LEN) {
    const hipL = set[POSE_HIP_L];
    const hipR = set[POSE_HIP_R];
    if (hipL && hipR) {
      return { x: (hipL.x + hipR.x) * 0.5, y: (hipL.y + hipR.y) * 0.5 };
    }
    const shL = set[POSE_SHOULDER_L];
    const shR = set[POSE_SHOULDER_R];
    if (shL && shR) {
      return { x: (shL.x + shR.x) * 0.5, y: (shL.y + shR.y) * 0.5 };
    }
    return null;
  }
  if (set.length >= FACE_MESH_MIN) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < set.length; i += 1) {
      sx += set[i]!.x;
      sy += set[i]!.y;
    }
    return { x: sx / set.length, y: sy / set.length };
  }
  return null;
}

/** Nose→crown target and travel distance for lift amount t. */
function noseLiftVector(
  set: Landmark[],
  noseIdx: number,
  t: number,
): { dx: number; dy: number; amount: number } | null {
  const nose = set[noseIdx];
  if (!nose || t <= 0) return null;

  let tx: number;
  let ty: number;
  if (set.length === POSE_LEN) {
    const earL = set[POSE_EAR_L];
    const earR = set[POSE_EAR_R];
    const shL = set[POSE_SHOULDER_L];
    const shR = set[POSE_SHOULDER_R];
    if (!earL || !earR || !shL || !shR) return null;
    const midEarX = (earL.x + earR.x) * 0.5;
    const midEarY = (earL.y + earR.y) * 0.5;
    const midShX = (shL.x + shR.x) * 0.5;
    const midShY = (shL.y + shR.y) * 0.5;
    tx = midEarX + (midEarX - midShX) * 0.55;
    ty = midEarY + (midEarY - midShY) * 0.55;
  } else if (set.length >= FACE_MESH_MIN) {
    const forehead = set[FACE_FOREHEAD];
    if (!forehead) return null;
    tx = forehead.x;
    ty = forehead.y;
  } else {
    return null;
  }

  const dx = (tx - nose.x) * t;
  const dy = (ty - nose.y) * t;
  return { dx, dy, amount: Math.hypot(dx, dy) };
}

/** Nose goes toward the crown; every other bone slides along center→bone. */
function liftedPoint(
  lm: Landmark,
  index: number,
  noseIdx: number,
  center: { x: number; y: number },
  lift: { dx: number; dy: number; amount: number },
): { x: number; y: number } {
  if (index === noseIdx) {
    return { x: lm.x + lift.dx, y: lm.y + lift.dy };
  }
  const vx = lm.x - center.x;
  const vy = lm.y - center.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-6 || lift.amount <= 0) return { x: lm.x, y: lm.y };
  const s = lift.amount / len;
  return { x: lm.x + vx * s, y: lm.y + vy * s };
}

function faceRange(setLen: number): { start: number; count: number; seeds: readonly number[] } | null {
  if (setLen === POSE_LEN) {
    return { start: 0, count: POSE_FACE_END, seeds: POSE_FACE_PRIORITY };
  }
  if (setLen >= FACE_MESH_MIN) {
    return { start: 0, count: setLen, seeds: FACE_OVAL };
  }
  return null;
}

function noseIndex(setLen: number): number | null {
  if (setLen === POSE_LEN) return POSE_NOSE;
  if (setLen >= FACE_MESH_MIN) return FACE_NOSE;
  return null;
}

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
    {
      key: "faceKeep",
      label: "Face points",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      key: "noseLift",
      label: "Nose → head",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
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
    const faceKeep = paramNumber(params, "faceKeep", 1);
    // Knob 0..1 maps to 0..10× the nose→crown vector (10× stronger than before).
    const noseLift = clamp01(paramNumber(params, "noseLift", 0)) * 10;
    const sets =
      subject < 0
        ? data.sets
        : subject < data.sets.length
          ? [data.sets[subject]!]
          : [];

    const points: PointsValue["points"] = [];
    for (const set of sets) {
      const face = faceRange(set.length);
      const keepFace = face
        ? pickFaceSlots(set, face.start, face.count, faceKeep, face.seeds)
        : null;
      const noseIdx = noseIndex(set.length);
      const lift =
        noseIdx !== null && noseLift > 0 ? noseLiftVector(set, noseIdx, noseLift) : null;
      const center = lift ? bodyCenter(set) : null;

      for (let i = 0; i < set.length; i += 1) {
        const lm = set[i]!;
        if (lm.score < minScore) continue;

        if (face && keepFace) {
          const faceLocal = i - face.start;
          if (faceLocal >= 0 && faceLocal < face.count && !keepFace[faceLocal]) continue;
        }

        const pos =
          lift && center && noseIdx !== null
            ? liftedPoint(lm, i, noseIdx, center, lift)
            : { x: lm.x, y: lm.y };

        points.push({ x: pos.x, y: pos.y, score: lm.score });
      }
    }

    return { points: { points } };
  },
});
