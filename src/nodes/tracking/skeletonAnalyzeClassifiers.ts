import type { Landmark } from "../../engine/types";
import {
  buildPoseFeatures,
  type ClassifyResult,
  type PoseFeatures,
  ramp,
  rampDown,
} from "./skeletonAnalyzeFeatures";

export type PoseStateId =
  | "standing"
  | "walking"
  | "dancing"
  | "sitting"
  | "lying"
  | "squatting"
  | "running"
  | "jumping"
  | "bending"
  | "falling";

export const POSE_STATE_LABELS: Record<PoseStateId, string> = {
  standing: "Standing",
  walking: "Walking",
  dancing: "Dancing",
  sitting: "Sitting",
  lying: "Lying",
  squatting: "Squatting",
  running: "Running",
  jumping: "Jumping",
  bending: "Bending forward",
  falling: "Falling",
};

/** Evaluation order when confidences are close — dynamic / rare first. */
export const POSE_STATE_PRIORITY: PoseStateId[] = [
  "falling",
  "jumping",
  "running",
  "dancing",
  "walking",
  "squatting",
  "sitting",
  "lying",
  "bending",
  "standing",
];

function result(confidence: number, threshold = 0.45): ClassifyResult {
  const c = Math.min(1, Math.max(0, confidence));
  return { match: c >= threshold, confidence: c };
}

function withFeatures(
  landmarks: Landmark[],
  history: Landmark[][],
  fn: (f: PoseFeatures) => ClassifyResult,
): ClassifyResult {
  const f = buildPoseFeatures(landmarks, history);
  if (!f) return result(0);
  return fn(f);
}

/** 1. Standing — upright, legs open, little motion. */
export function classifyStanding(f: PoseFeatures): ClassifyResult {
  const upright = rampDown(f.torsoTilt, 0.25, 0.7);
  const legs = rampDown(f.kneeBend, 0.35, 1.1);
  // Kill standing quickly once limbs move (torso units).
  const still = rampDown(f.energy, 0.012, 0.055);
  const notLow = rampDown(f.hipKneeDrop, -0.35, 0.05);
  const notFlat = rampDown(f.torsoTilt, 0.9, 1.3);
  return result(upright * 0.35 + legs * 0.25 + still * 0.25 + notLow * 0.1 + notFlat * 0.05);
}

export function isStanding(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyStanding);
}

/** 2. Walking — needs clear travel × gait, not just foot fidgeting. */
export function classifyWalking(f: PoseFeatures): ClassifyResult {
  if (f.historyLen < 4) return result(0);
  const upright = rampDown(f.torsoTilt, 0.3, 0.85);
  const gait = ramp(f.legPhase, 0.5, 0.8);
  const speed = ramp(f.comSpeed, 0.025, 0.08) * rampDown(f.comSpeed, 0.12, 0.25);
  const ankles = ramp(f.ankleSpeed, 0.025, 0.12);
  const notBounce = rampDown(f.bounce, 0.25, 0.6);
  // Require locomotion evidence: speed and gait together.
  const loco = speed * Math.max(gait, 0.35);
  return result(upright * 0.15 + loco * 0.45 + gait * 0.15 + ankles * 0.15 + notBounce * 0.1);
}

export function isWalking(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyWalking);
}

/**
 * 3. Dancing — any lively limb / bounce motion while not clearly travelling.
 * Thresholds are soft on purpose: in-place groove should win over Standing.
 */
export function classifyDancing(f: PoseFeatures): ClassifyResult {
  if (f.historyLen < 3) return result(0, 0.3);
  const arms = ramp(f.wristSpeed, 0.008, 0.05);
  const energy = ramp(f.energy, 0.01, 0.055);
  const bounce = ramp(f.bounce, 0.02, 0.12);
  const ankles = ramp(f.ankleSpeed, 0.008, 0.05);
  // Strongest motion cue wins — arms OR body OR feet.
  const motion = Math.max(arms, energy, bounce * 0.9, ankles * 0.75);
  const travel = ramp(f.comSpeed, 0.06, 0.16);
  const gait = ramp(f.legPhase, 0.55, 0.9);
  const notLoco = 1 - travel * gait * 0.9;
  const uprightish = rampDown(f.torsoTilt, 0.6, 1.25);
  // Bias up so moderate groove clears typical Min confidence (~0.35–0.45).
  const conf = Math.min(1, motion * (0.65 + 0.35 * notLoco) + uprightish * 0.12 + 0.08);
  return result(conf, 0.28);
}

export function isDancing(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyDancing);
}

/** 4. Sitting — thighs ~horizontal, knees bent, torso relatively upright, still. */
export function classifySitting(f: PoseFeatures): ClassifyResult {
  const knee = ramp(f.kneeBend, 0.7, 1.4) * rampDown(f.kneeBend, 1.7, 2.4);
  const thigh = rampDown(Math.abs(f.hipKneeDrop), 0.0, 0.35);
  const upright = rampDown(f.torsoTilt, 0.35, 0.95);
  const still = rampDown(f.energy, 0.03, 0.12);
  const notLie = rampDown(f.torsoTilt, 0.95, 1.35);
  return result(knee * 0.3 + thigh * 0.25 + upright * 0.2 + still * 0.15 + notLie * 0.1);
}

export function isSitting(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifySitting);
}

/** 5. Lying — torso nearly horizontal, wide aspect. */
export function classifyLying(f: PoseFeatures): ClassifyResult {
  const flat = ramp(f.torsoTilt, 0.85, 1.25);
  const wide = ramp(f.aspect, 1.1, 2.0);
  const short = rampDown(f.bodyHeight, 0.8, 1.8);
  const still = rampDown(Math.abs(f.comSpeedY), 0.05, 0.2);
  return result(flat * 0.45 + wide * 0.25 + short * 0.15 + still * 0.15);
}

export function isLying(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyLying);
}

/** 6. Squatting — deep knee bend, hips dropped toward knees. */
export function classifySquatting(f: PoseFeatures): ClassifyResult {
  const deep = ramp(f.kneeBend, 1.0, 1.8);
  const dropped = ramp(f.hipKneeDrop, -0.45, 0.05);
  const upright = rampDown(f.torsoTilt, 0.4, 1.0);
  const feetDown = ramp(Math.abs(f.hipAboveAnkle), 0.5, 1.4);
  return result(deep * 0.4 + dropped * 0.3 + upright * 0.15 + feetDown * 0.15);
}

export function isSquatting(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifySquatting);
}

/** 7. Running — faster locomotion, more bounce than walking. */
export function classifyRunning(f: PoseFeatures): ClassifyResult {
  if (f.historyLen < 4) return result(0);
  const upright = rampDown(f.torsoTilt, 0.35, 0.95);
  const speed = ramp(f.comSpeed, 0.07, 0.18);
  const gait = ramp(f.legPhase, 0.4, 0.7);
  const bounce = ramp(f.bounce, 0.15, 0.45);
  const ankles = ramp(f.ankleSpeed, 0.06, 0.2);
  return result(upright * 0.15 + speed * 0.3 + gait * 0.2 + bounce * 0.2 + ankles * 0.15);
}

export function isRunning(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyRunning);
}

/** 8. Jumping — upward COM burst and vertical oscillation. */
export function classifyJumping(f: PoseFeatures): ClassifyResult {
  if (f.historyLen < 3) return result(0);
  const rising = ramp(-f.comSpeedY, 0.04, 0.15);
  const burst = ramp(f.comSpeed, 0.05, 0.2);
  const bounce = ramp(f.bounce, 0.18, 0.55);
  const energy = ramp(f.energy, 0.05, 0.2);
  return result(rising * 0.4 + burst * 0.25 + bounce * 0.2 + energy * 0.15);
}

export function isJumping(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyJumping);
}

/** 9. Наклоняется вперёд — torso pitched / shoulders dropped over hips. */
export function classifyBendingForward(f: PoseFeatures): ClassifyResult {
  const lean = ramp(f.forwardLean, 0.25, 0.65);
  const tilt = ramp(f.torsoTilt, 0.45, 1.0) * rampDown(f.torsoTilt, 1.05, 1.4);
  const notSit = rampDown(f.kneeBend, 0.9, 1.6);
  const standingLegs = rampDown(Math.abs(f.hipKneeDrop), 0.35, 0.9);
  return result(lean * 0.4 + tilt * 0.3 + notSit * 0.15 + standingLegs * 0.15);
}

export function isBendingForward(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyBendingForward);
}

/** 10. Falling — fast downward COM, torso going flat. */
export function classifyFalling(f: PoseFeatures): ClassifyResult {
  if (f.historyLen < 3) return result(0);
  const drop = ramp(f.comSpeedY, 0.06, 0.22);
  const flattening = ramp(f.torsoTilt, 0.5, 1.15);
  const fast = ramp(f.comSpeed, 0.08, 0.25);
  const notJump = rampDown(-f.comSpeedY, 0.025, 0.1);
  return result(drop * 0.4 + flattening * 0.25 + fast * 0.2 + notJump * 0.15);
}

export function isFalling(landmarks: Landmark[], history: Landmark[][]): ClassifyResult {
  return withFeatures(landmarks, history, classifyFalling);
}

export type PoseClassifier = (landmarks: Landmark[], history: Landmark[][]) => ClassifyResult;

export const POSE_CLASSIFIERS: Record<PoseStateId, PoseClassifier> = {
  standing: isStanding,
  walking: isWalking,
  dancing: isDancing,
  sitting: isSitting,
  lying: isLying,
  squatting: isSquatting,
  running: isRunning,
  jumping: isJumping,
  bending: isBendingForward,
  falling: isFalling,
};

const FROM_FEATURES: Record<PoseStateId, (f: PoseFeatures) => ClassifyResult> = {
  standing: classifyStanding,
  walking: classifyWalking,
  dancing: classifyDancing,
  sitting: classifySitting,
  lying: classifyLying,
  squatting: classifySquatting,
  running: classifyRunning,
  jumping: classifyJumping,
  bending: classifyBendingForward,
  falling: classifyFalling,
};

export interface PoseAnalysis {
  id: PoseStateId | null;
  label: string;
  confidence: number;
  scores: Record<PoseStateId, ClassifyResult>;
}

/**
 * Run all ten classifiers on one subject. `history` is oldest→newest and
 * should already include the current frame as the last entry.
 */
export function analyzePose(
  landmarks: Landmark[],
  history: Landmark[][],
  minConfidence: number,
  minScore = 0.2,
): PoseAnalysis {
  const scores = {} as Record<PoseStateId, ClassifyResult>;
  const f = buildPoseFeatures(landmarks, history, minScore);
  if (!f) {
    for (const id of POSE_STATE_PRIORITY) scores[id] = result(0);
    return { id: null, label: "—", confidence: 0, scores };
  }

  let bestId: PoseStateId | null = null;
  let bestScore = 0;
  let bestPriority = Infinity;

  for (const id of POSE_STATE_PRIORITY) {
    const r = FROM_FEATURES[id](f);
    scores[id] = r;
    if (!r.match || r.confidence < minConfidence) continue;
    const priority = POSE_STATE_PRIORITY.indexOf(id);
    if (
      r.confidence > bestScore + 0.04 ||
      (Math.abs(r.confidence - bestScore) <= 0.04 && priority < bestPriority)
    ) {
      bestId = id;
      bestScore = r.confidence;
      bestPriority = priority;
    }
  }

  return {
    id: bestId,
    label: bestId ? POSE_STATE_LABELS[bestId] : "—",
    confidence: bestId ? bestScore : 0,
    scores,
  };
}
