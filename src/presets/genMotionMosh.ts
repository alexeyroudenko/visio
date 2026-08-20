import { DEFAULT_IMAGE_FILE } from "../nodes/shared/fileParam";
import type { SerializedPatch } from "../store/persistence";

/**
 * Datamosh without a real match: Gen Motion Vectors invents the field, so a
 * still already smears. Bands is the slice-shift look; switch the generator to
 * constant + 90° for a vertical melt, or blocks for a corrupted P-frame.
 *
 * Press play — the accumulator only grows while the graph is ticking.
 */
export function genMotionMosh(): SerializedPatch {
  return {
    format: 1,
    width: 1080,
    height: 1920,
    nodes: [
      {
        id: "image-1",
        type: "source.media",
        position: { x: 0, y: 140 },
        params: {
          mode: "image",
          file: DEFAULT_IMAGE_FILE,
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
        id: "gen-1",
        type: "fx.genMotion",
        position: { x: 330, y: 20 },
        params: {
          mode: "bands",
          amount: 0.4,
          angle: 0,
          block: 12,
          bands: 28,
          jitter: 0.3,
          freq: 4,
          seed: 7,
          speed: 0,
          phase: 0,
          view: "vectors",
        },
      },
      {
        id: "datamosh-1",
        type: "fx.datamosh",
        position: { x: 660, y: 180 },
        params: {
          amount: 1.2,
          bloom: 0.4,
          decay: 1,
          refresh: 0.04,
          keyframe: 0,
          block: 16,
          search: 32,
          scale: "4",
          threshold: 0.12,
          smooth: 0.3,
          resetAtFirst: true,
          clear: false,
        },
      },
      {
        id: "screen-1",
        type: "output.screen",
        position: { x: 1000, y: 200 },
        params: { background: "#000000" },
      },
    ],
    edges: [
      { id: "e-src", source: "image-1", sourceHandle: "out", target: "datamosh-1", targetHandle: "src" },
      { id: "e-mv", source: "gen-1", sourceHandle: "out", target: "datamosh-1", targetHandle: "mv" },
      { id: "e-out", source: "datamosh-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
    timeline: {
      fps: 30,
      durationInFrames: 300,
      keyframes: {},
    },
  } as SerializedPatch;
}
