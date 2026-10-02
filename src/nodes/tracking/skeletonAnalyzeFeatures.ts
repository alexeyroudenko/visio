import type { Landmark } from "../../engine/types";

/** BlazePose landmark indices. */
export const LM = {
  nose: 0,
  shoulderL: 11,
  shoulderR: 12,
  elbowL: 13,
  elbowR: 14,
  wristL: 15,
  wristR: 16,
  hipL: 23,
  hipR: 24,
  kneeL: 25,
  kneeR: 26,
  ankleL: 27,
  ankleR: 28,
} as const;

export const POSE_LEN = 33;

export interface PoseFeatures {
  /** Radians from upright (−Y); 0 = standing tall, ~π/2 = flat on the ground. */
  torsoTilt: number;
  /** Shoulders ahead of hips along facing; larger ⇒ forward bend. */
  forwardLean: number;
  kneeBendL: number;
  kneeBendR: number;
  /** Mean knee flexion 0 = straight, π = fully folded. */
  kneeBend: number;
  /** Hip−knee Y in torso units (≈0 when thigh is horizontal). */
  hipKneeDrop: number;
  /** Hip−ankle Y in torso units (negative when hips are above ankles). */
  hipAboveAnkle: number;
  /** Ankle→shoulder span in torso units (~2 when standing). */
  bodyHeight: number;
  /** BBox width / height. */
  aspect: number;
  midHipY: number;
  midShoulderY: number;
  midAnkleY: number;
  /**
   * COM translation in torso-lengths / frame (from raw hip motion / scale).
   * Survives per-frame centering so walk/run still register.
   */
  comSpeedX: number;
  /** + = moving down the frame. */
  comSpeedY: number;
  comSpeed: number;
  /** Limb speeds in torso-lengths / frame (on the normalized skeleton). */
  ankleSpeed: number;
  wristSpeed: number;
  energy: number;
  /** Left/right ankle vertical anti-correlation cue. */
  legPhase: number;
  /** Vertical world-COM oscillation in torso units. */
  bounce: number;
  historyLen: number;
}

export type ClassifyResult = { match: boolean; confidence: number };

interface NormFrame {
  /** Hip-centered, torso-scaled landmarks. */
  landmarks: Landmark[];
  /** Raw mid-hip / torsoLen — world position in torso units. */
  worldCom: { x: number; y: number };
  scale: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function get(set: Landmark[], i: number, minScore: number): Landmark | null {
  const lm = set[i];
  if (!lm || lm.score < minScore) return null;
  return lm;
}

function mid(
  a: Landmark | null,
  b: Landmark | null,
): { x: number; y: number } | null {
  if (!a || !b) return null;
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

/** Interior angle at b for triangle a–b–c, radians. */
export function jointAngle(a: Landmark, b: Landmark, c: Landmark): number {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const n = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (n < 1e-8) return Math.PI;
  return Math.acos(Math.min(1, Math.max(-1, dot / n)));
}

/** Knee flexion: 0 straight, grows as the leg folds. */
function kneeFlexion(hip: Landmark, knee: Landmark, ankle: Landmark): number {
  return Math.PI - jointAngle(hip, knee, ankle);
}

/**
 * Center on mid-hips, scale by mid-shoulder↔mid-hip length.
 * Returns null if the torso cannot be measured.
 */
export function normalizePose(set: Landmark[], minScore = 0.2): NormFrame | null {
  if (set.length < POSE_LEN) return null;
  const shoulder = mid(get(set, LM.shoulderL, minScore), get(set, LM.shoulderR, minScore));
  const hip = mid(get(set, LM.hipL, minScore), get(set, LM.hipR, minScore));
  if (!shoulder || !hip) return null;
  const scale = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
  if (scale < 1e-5) return null;

  const landmarks = set.map((lm) => ({
    x: (lm.x - hip.x) / scale,
    y: (lm.y - hip.y) / scale,
    z: lm.z / scale,
    score: lm.score,
  }));

  return {
    landmarks,
    worldCom: { x: hip.x / scale, y: hip.y / scale },
    scale,
  };
}

function meanSpeed(history: Landmark[][], index: number, minScore: number): number {
  if (history.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < history.length; i += 1) {
    const a = get(history[i - 1]!, index, minScore);
    const b = get(history[i]!, index, minScore);
    if (!a || !b) continue;
    sum += Math.hypot(b.x - a.x, b.y - a.y);
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Derive static + dynamic pose features. Every frame is hip-centered and
 * scaled by torso length before angles / limb speeds; walk/run use world COM
 * in the same torso units so translation is not erased by centering.
 */
export function buildPoseFeatures(
  landmarks: Landmark[],
  history: Landmark[][],
  minScore = 0.2,
): PoseFeatures | null {
  if (landmarks.length < POSE_LEN) return null;

  // Node history already ends with the current frame; fall back to `landmarks`.
  const source = history.length > 0 ? history : [landmarks];
  const normHistory: NormFrame[] = [];
  for (const frame of source) {
    const n = normalizePose(frame, minScore);
    if (n) normHistory.push(n);
  }
  if (normHistory.length === 0) return null;
  const current = normHistory[normHistory.length - 1]!;

  const pose = current.landmarks;
  const shL = get(pose, LM.shoulderL, minScore);
  const shR = get(pose, LM.shoulderR, minScore);
  const hipL = get(pose, LM.hipL, minScore);
  const hipR = get(pose, LM.hipR, minScore);
  const kneeL = get(pose, LM.kneeL, minScore);
  const kneeR = get(pose, LM.kneeR, minScore);
  const ankleL = get(pose, LM.ankleL, minScore);
  const ankleR = get(pose, LM.ankleR, minScore);
  const shoulder = mid(shL, shR);
  const hip = mid(hipL, hipR);
  const ankle = mid(ankleL, ankleR);
  if (!shoulder || !hip) return null;

  const torsoDx = shoulder.x - hip.x;
  const torsoDy = shoulder.y - hip.y;
  // After norm, torso length ≈ 1 and hips sit at origin; upright ⇒ shoulder ≈ (0,−1).
  const torsoTilt = Math.atan2(Math.abs(torsoDx), Math.max(1e-6, -torsoDy));
  const torsoLen = Math.hypot(torsoDx, torsoDy) || 1e-6;
  const leanByDrop = clamp01(Math.max(0, shoulder.y - hip.y + torsoLen * 0.15) / torsoLen);
  const leanByPitch = clamp01(Math.abs(torsoDx) / torsoLen);
  const forwardLeanAmt = clamp01(0.55 * leanByDrop + 0.45 * leanByPitch);

  const kneeBendL = hipL && kneeL && ankleL ? kneeFlexion(hipL, kneeL, ankleL) : 0;
  const kneeBendR = hipR && kneeR && ankleR ? kneeFlexion(hipR, kneeR, ankleR) : 0;
  const kneeSamples = [kneeBendL, kneeBendR].filter((v) => v > 0);
  const kneeBend =
    kneeSamples.length > 0
      ? kneeSamples.reduce((a, b) => a + b, 0) / kneeSamples.length
      : 0;

  const knee = mid(kneeL, kneeR);
  const hipKneeDrop = knee ? hip.y - knee.y : 0;
  const hipAboveAnkle = ankle ? hip.y - ankle.y : 0;
  const bodyHeight = ankle
    ? Math.max(0.05, ankle.y - shoulder.y)
    : Math.max(0.05, Math.abs(torsoDy) * 2);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const i of [
    LM.shoulderL,
    LM.shoulderR,
    LM.hipL,
    LM.hipR,
    LM.ankleL,
    LM.ankleR,
    LM.wristL,
    LM.wristR,
  ]) {
    const lm = get(pose, i, minScore);
    if (!lm) continue;
    minX = Math.min(minX, lm.x);
    maxX = Math.max(maxX, lm.x);
    minY = Math.min(minY, lm.y);
    maxY = Math.max(maxY, lm.y);
  }
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const aspect = bw / bh;

  const poses = normHistory.map((n) => n.landmarks);
  const worldComs = normHistory.map((n) => n.worldCom);

  let comSpeedX = 0;
  let comSpeedY = 0;
  if (worldComs.length >= 2) {
    const a = worldComs[worldComs.length - 2]!;
    const b = worldComs[worldComs.length - 1]!;
    comSpeedX = b.x - a.x;
    comSpeedY = b.y - a.y;
  }
  const comSpeed = Math.hypot(comSpeedX, comSpeedY);

  const ankleSpeed =
    (meanSpeed(poses, LM.ankleL, minScore) + meanSpeed(poses, LM.ankleR, minScore)) * 0.5;
  const wristSpeed =
    (meanSpeed(poses, LM.wristL, minScore) + meanSpeed(poses, LM.wristR, minScore)) * 0.5;

  let energy = 0;
  let energyN = 0;
  for (const idx of [
    LM.wristL,
    LM.wristR,
    LM.ankleL,
    LM.ankleR,
    LM.elbowL,
    LM.elbowR,
    LM.kneeL,
    LM.kneeR,
  ]) {
    energy += meanSpeed(poses, idx, minScore);
    energyN += 1;
  }
  energy = energyN > 0 ? energy / energyN : 0;

  let legPhase = 0;
  if (poses.length >= 4) {
    const dL: number[] = [];
    const dR: number[] = [];
    for (let i = 1; i < poses.length; i += 1) {
      const l0 = get(poses[i - 1]!, LM.ankleL, minScore);
      const l1 = get(poses[i]!, LM.ankleL, minScore);
      const r0 = get(poses[i - 1]!, LM.ankleR, minScore);
      const r1 = get(poses[i]!, LM.ankleR, minScore);
      if (!l0 || !l1 || !r0 || !r1) continue;
      dL.push(l1.y - l0.y);
      dR.push(r1.y - r0.y);
    }
    if (dL.length >= 3) {
      let dot = 0;
      let nL = 0;
      let nR = 0;
      for (let i = 0; i < dL.length; i += 1) {
        dot += dL[i]! * dR[i]!;
        nL += dL[i]! * dL[i]!;
        nR += dR[i]! * dR[i]!;
      }
      const denom = Math.sqrt(nL * nR);
      const corr = denom > 1e-8 ? dot / denom : 0;
      legPhase = clamp01((-corr + 1) * 0.5);
    }
  }

  let bounce = 0;
  if (worldComs.length >= 4) {
    let minCy = Infinity;
    let maxCy = -Infinity;
    for (const c of worldComs) {
      minCy = Math.min(minCy, c.y);
      maxCy = Math.max(maxCy, c.y);
    }
    bounce = maxCy - minCy;
  }

  return {
    torsoTilt,
    forwardLean: forwardLeanAmt,
    kneeBendL,
    kneeBendR,
    kneeBend,
    hipKneeDrop,
    hipAboveAnkle,
    bodyHeight,
    aspect,
    midHipY: hip.y,
    midShoulderY: shoulder.y,
    midAnkleY: ankle?.y ?? hip.y + bodyHeight * 0.5,
    comSpeedX,
    comSpeedY,
    comSpeed,
    ankleSpeed,
    wristSpeed,
    energy,
    legPhase,
    bounce,
    historyLen: normHistory.length,
  };
}

/** Soft gate: rises from 0→1 between lo and hi. */
export function ramp(v: number, lo: number, hi: number): number {
  if (hi <= lo) return v >= hi ? 1 : 0;
  return clamp01((v - lo) / (hi - lo));
}

/** Soft gate: 1 below lo, 0 above hi. */
export function rampDown(v: number, lo: number, hi: number): number {
  return 1 - ramp(v, lo, hi);
}
