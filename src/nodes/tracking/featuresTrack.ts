import type { FrameValue, LinesValue, PointsValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { GrayFrame } from "../shared/grayscale";
import { paramsKey } from "../shared/paramsKey";
import {
  buildPyramid,
  detectShiTomasi,
  forwardBackwardOk,
  trackPointPyrLK,
  type PyramidLevel,
} from "./lkFlow";

interface TrailPoint {
  x: number;
  y: number;
}

interface Track {
  /** Position in downscaled gray pixels. */
  x: number;
  y: number;
  age: number;
  /** Normalized [0,1] trail for line output. */
  history: TrailPoint[];
}

interface FeaturesTrackState {
  frame: GrayFrame;
  prevGray: Float32Array | null;
  prevW: number;
  prevH: number;
  tracks: Track[];
  lastFrameId: number;
  lastLines: LinesValue;
  lastPoints: PointsValue;
  paramsFingerprint: string;
  framesSinceDetect: number;
}

const EMPTY_LINES: LinesValue = { lines: [] };
const EMPTY_POINTS: PointsValue = { points: [] };

function copyGray(src: Float32Array, dest: Float32Array | null): Float32Array {
  if (!dest || dest.length !== src.length) return Float32Array.from(src);
  dest.set(src);
  return dest;
}

/**
 * Features Tracking — the FeaturesTracking / cv-reels motion-line pipeline:
 * Shi–Tomasi corners → pyramidal Lucas–Kanade → keep tracks that lived long
 * enough → emit their trails as line segments.
 *
 * @see https://alexeyroudenko.net/ru/projects/features-tracking/
 */
export const featuresTrackNode = defineNode<FeaturesTrackState>({
  type: "tracking.featuresTrack",
  label: "Features Tracking",
  category: "tracking",
  description:
    "Shi–Tomasi + PyrLK optical flow: long-lived tracks become motion lines.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [
    { id: "out", label: "lines", type: "lines" },
    { id: "points", label: "points", type: "points" },
  ],
  params: [
    { key: "downscale", label: "Downscale", type: "range", min: 2, max: 8, step: 1, default: 4 },
    { key: "block", label: "Window", type: "range", min: 3, max: 15, step: 2, default: 7 },
    { key: "maxCorners", label: "Max detect", type: "range", min: 10, max: 400, step: 10, default: 120 },
    { key: "quality", label: "Quality", type: "range", min: 0.01, max: 0.5, step: 0.01, default: 0.08 },
    { key: "minDistance", label: "Min distance", type: "range", min: 2, max: 60, step: 1, default: 12 },
    { key: "winSize", label: "LK window", type: "range", min: 5, max: 31, step: 2, default: 15 },
    { key: "maxLevel", label: "Pyramid levels", type: "range", min: 0, max: 4, step: 1, default: 2 },
    { key: "maxIters", label: "LK iterations", type: "range", min: 3, max: 30, step: 1, default: 10 },
    { key: "fbError", label: "FB error (px)", type: "range", min: 0.5, max: 8, step: 0.5, default: 2 },
    {
      key: "minAge",
      label: "Min age (frames)",
      type: "range",
      min: 1,
      max: 120,
      step: 1,
      default: 50,
    },
    {
      key: "maxTrail",
      label: "Trail length",
      type: "range",
      min: 8,
      max: 200,
      step: 1,
      default: 64,
    },
    {
      key: "maxTracks",
      label: "Max tracks",
      type: "range",
      min: 20,
      max: 400,
      step: 10,
      default: 150,
    },
    {
      key: "detectInterval",
      label: "Redetect every N",
      type: "range",
      min: 1,
      max: 30,
      step: 1,
      default: 5,
    },
  ],
  createState() {
    return {
      frame: new GrayFrame(),
      prevGray: null,
      prevW: 0,
      prevH: 0,
      tracks: [],
      lastFrameId: -1,
      lastLines: EMPTY_LINES,
      lastPoints: EMPTY_POINTS,
      paramsFingerprint: "",
      framesSinceDetect: 999,
    };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const state = runtime.state;
    const frame = inputs.frame as FrameValue | null;
    if (!frame) {
      ctx.report(nodeId, "idle", "connect a frame from a source");
      return { out: EMPTY_LINES, points: EMPTY_POINTS };
    }

    const fingerprint = paramsKey(params);
    if (fingerprint !== state.paramsFingerprint) {
      state.paramsFingerprint = fingerprint;
      state.lastFrameId = -1;
      state.tracks = [];
      state.prevGray = null;
      state.framesSinceDetect = 999;
    }

    if (frame.frameId === state.lastFrameId) {
      return { out: state.lastLines, points: state.lastPoints };
    }
    state.lastFrameId = frame.frameId;
    // Cleared again after emit with a track count.

    const factor = Math.max(2, Math.round(paramNumber(params, "downscale", 4)));
    state.frame.update(frame, factor);
    const { width, height, gray, gradX, gradY } = state.frame;

    const winSize = Math.max(5, Math.round(paramNumber(params, "winSize", 15)) | 1);
    const maxLevel = Math.max(0, Math.round(paramNumber(params, "maxLevel", 2)));
    const maxIters = Math.max(3, Math.round(paramNumber(params, "maxIters", 10)));
    const fbError = Math.max(0.5, paramNumber(params, "fbError", 2));
    const minAge = Math.max(1, Math.round(paramNumber(params, "minAge", 50)));
    const maxTrail = Math.max(2, Math.round(paramNumber(params, "maxTrail", 64)));
    const maxTracks = Math.max(1, Math.round(paramNumber(params, "maxTracks", 150)));
    const detectInterval = Math.max(1, Math.round(paramNumber(params, "detectInterval", 5)));
    // UI minDistance is in output pixels; work in downscaled space.
    const minDistance = paramNumber(params, "minDistance", 12) / factor;

    let prevPyr: PyramidLevel[] | null = null;
    let nextPyr: PyramidLevel[] | null = null;

    if (
      state.prevGray &&
      state.prevW === width &&
      state.prevH === height &&
      state.tracks.length > 0
    ) {
      prevPyr = buildPyramid(state.prevGray, width, height, maxLevel);
      nextPyr = buildPyramid(gray, width, height, maxLevel);

      const nextTracks: Track[] = [];
      for (const track of state.tracks) {
        const stepped = trackPointPyrLK(
          prevPyr,
          nextPyr,
          track.x,
          track.y,
          winSize,
          maxIters,
        );
        if (!stepped.ok) continue;
        if (
          !forwardBackwardOk(
            prevPyr,
            nextPyr,
            track.x,
            track.y,
            stepped.x,
            stepped.y,
            winSize,
            maxIters,
            fbError,
          )
        ) {
          continue;
        }
        if (
          stepped.x < 1 ||
          stepped.y < 1 ||
          stepped.x >= width - 1 ||
          stepped.y >= height - 1
        ) {
          continue;
        }

        const history = track.history.slice(-(maxTrail - 1));
        history.push({ x: stepped.x / width, y: stepped.y / height });
        nextTracks.push({
          x: stepped.x,
          y: stepped.y,
          age: track.age + 1,
          history,
        });
        if (nextTracks.length >= maxTracks) break;
      }
      state.tracks = nextTracks;
    } else if (state.prevW !== width || state.prevH !== height) {
      // Resolution change — drop everything; redetect below.
      state.tracks = [];
    }

    state.framesSinceDetect += 1;
    const needDetect =
      state.framesSinceDetect >= detectInterval || state.tracks.length < maxTracks * 0.35;

    if (needDetect) {
      state.framesSinceDetect = 0;
      const room = Math.max(0, maxTracks - state.tracks.length);
      if (room > 0) {
        const corners = detectShiTomasi(gradX, gradY, width, height, {
          block: Math.max(3, Math.round(paramNumber(params, "block", 7)) | 1),
          maxCorners: Math.min(
            room,
            Math.round(paramNumber(params, "maxCorners", 120)),
          ),
          quality: paramNumber(params, "quality", 0.08),
          minDistance,
          avoid: state.tracks,
        });
        for (const corner of corners) {
          state.tracks.push({
            x: corner.x,
            y: corner.y,
            age: 0,
            history: [{ x: corner.x / width, y: corner.y / height }],
          });
          if (state.tracks.length >= maxTracks) break;
        }
      }
    }

    state.prevGray = copyGray(gray, state.prevGray);
    state.prevW = width;
    state.prevH = height;

    const lines: LinesValue["lines"] = [];
    const points: PointsValue["points"] = [];

    for (const track of state.tracks) {
      // Points show every live track. Min age only gates motion lines — otherwise a
      // still Media frame (frameId stuck) or the first ~50 video ticks report
      // `points ×0` even though Shi–Tomasi already found corners.
      const ageScore = Math.min(1, Math.max(0.15, track.age / Math.max(1, minAge * 2)));
      points.push({
        x: track.x / width,
        y: track.y / height,
        score: ageScore,
      });

      if (track.age < minAge) continue;

      const hist = track.history;
      for (let i = 1; i < hist.length; i += 1) {
        const a = hist[i - 1]!;
        const b = hist[i]!;
        // Newer segments of a long trail read brighter under Draw Lines fade.
        const along = i / (hist.length - 1);
        lines.push({
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          score: ageScore * (0.35 + 0.65 * along),
        });
      }
    }

    state.lastLines = { lines };
    state.lastPoints = { points };
    ctx.report(
      nodeId,
      "ready",
      `${state.tracks.length} tracks · ${points.length} pts · ${lines.length} segs`,
    );
    return { out: state.lastLines, points: state.lastPoints };
  },
});
