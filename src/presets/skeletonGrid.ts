import { POSE_IMAGE_FILE } from "../nodes/shared/fileParam";
import type { SerializedPatch } from "../store/persistence";

/**
 * Pose twin of the Face Mesh preset: still → BlazePose → Draw Skeleton, and the
 * same 33 landmarks flattened into points that cut the Mondrian grid. The grid
 * sits on top of the skeleton pass, so bones show through its cells.
 */
export function skeletonGrid(): SerializedPatch {
  return {
    format: 1,
    width: 1080,
    height: 1920,
    nodes: [
      {
        id: "image-1",
        type: "source.media",
        position: { x: -160, y: 60 },
        params: {
          mode: "image",
          file: POSE_IMAGE_FILE,
          facing: "environment",
          playing: true,
          muted: false,
          volume: 1,
          speed: 1,
          syncTimeline: false,
          mirror: false,
          fit: "cover",
          zoom: 1,
        },
      },
      {
        id: "pose-1",
        type: "tracking.pose",
        position: { x: 320, y: 140 },
        // BlazePose's detection threshold is a hard gate: on this high-contrast
        // studio still anything above ~0.2 finds no body at all.
        params: { model: "full", numPoses: 1, confidence: 0.1, interval: 1 },
      },
      {
        id: "landmarks-1",
        type: "draw.landmarks",
        position: { x: 620, y: 310 },
        params: {
          pointColor: "#f5f0e6",
          boneColor: "#7fe3c0",
          pointSize: 5,
          boneWidth: 4,
          opacity: 1,
          scoreFade: true,
          blend: "normal",
        },
      },
      {
        id: "landmarksToPoints-1",
        type: "convert.landmarksToPoints",
        position: { x: 606, y: 130 },
        // Pose scores dip on occluded limbs; a low floor keeps the grid cutting there.
        params: { minScore: 0.2, subject: -1 },
      },
      {
        id: "featuresGrid-1",
        type: "draw.featuresGrid",
        position: { x: 1000, y: 60 },
        // 33 landmarks is a coarse point cloud: it needs a deeper split and a
        // smaller min cell than the face mesh to fill the body with cells.
        params: {
          color: "#f5f0e6",
          maxDepth: 6,
          minSize: 32,
          stroke: 1,
          opacity: 1,
          filledOnly: true,
          useContentEdge: true,
          edgeMinFill: 0.05,
          edgeInterval: 3,
          labels: true,
          labelSize: 18,
          labelText: "Element",
          effectChance: 0.7,
          effectMinArea: 0,
          effectMaxArea: 0.35,
          effectSeed: 42,
          rectMatch: 0.35,
          rectHold: 3,
        },
      },
      {
        id: "color-1",
        type: "fx.color",
        position: { x: 1260, y: 40 },
        // Grade the still, but keep saturation — desaturating would grey out the
        // one colour in the frame, the teal skeleton.
        params: { brightness: -0.1, contrast: 1.05, saturation: 1, hue: 0 },
      },
      {
        id: "screen-1",
        type: "output.screen",
        position: { x: 1500, y: 40 },
        params: { background: "#000000" },
      },
    ],
    edges: [
      { id: "e-frame", source: "image-1", sourceHandle: "frame", target: "pose-1", targetHandle: "frame" },
      { id: "e-bg", source: "image-1", sourceHandle: "out", target: "landmarks-1", targetHandle: "bg" },
      { id: "e-data", source: "pose-1", sourceHandle: "out", target: "landmarks-1", targetHandle: "landmarks" },
      { id: "e-pts", source: "pose-1", sourceHandle: "out", target: "landmarksToPoints-1", targetHandle: "landmarks" },
      {
        id: "e-grid-pts",
        source: "landmarksToPoints-1",
        sourceHandle: "points",
        target: "featuresGrid-1",
        targetHandle: "points",
      },
      { id: "e-grid-frame", source: "image-1", sourceHandle: "frame", target: "featuresGrid-1", targetHandle: "frame" },
      { id: "e-grid-bg", source: "landmarks-1", sourceHandle: "out", target: "featuresGrid-1", targetHandle: "bg" },
      { id: "e-color", source: "featuresGrid-1", sourceHandle: "out", target: "color-1", targetHandle: "src" },
      { id: "e-out", source: "color-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
  } as SerializedPatch;
}
