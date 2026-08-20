import { DEFAULT_IMAGE_FILE } from "../nodes/shared/fileParam";
import type { SerializedPatch } from "../store/persistence";

/**
 * Datamosh needs motion in the picture, and a still has none — so the still
 * supplies its own: Media's zoom is keyframed into three pushes that snap back
 * to the start, and each snap reads as a cut. Motion Vectors match the frame
 * against the one before it, Datamosh drags the accumulated picture along that
 * field and never takes an I-frame, so the push smears and the cut blooms.
 *
 * Press play. Switch Media to camera or video and it moshes live footage with
 * no rewiring — that is the same patch, with real motion in front of it.
 */
export function datamosh(): SerializedPatch {
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
        id: "motion-1",
        type: "fx.motion",
        position: { x: 330, y: 20 },
        // Coarse blocks and a wide search: the push moves the frame edges much
        // faster than its centre, and a small block loses the fast end of it.
        params: {
          block: 24,
          search: 48,
          scale: "4",
          threshold: 0.08,
          smooth: 0.35,
          boost: 1,
          view: "vectors",
        },
      },
      {
        id: "datamosh-1",
        type: "fx.datamosh",
        position: { x: 660, y: 180 },
        // No I-frame at all (0), but a little Bleed — without it ten seconds of
        // pure prediction ends as mush; with it the picture keeps re-forming.
        params: {
          amount: 1.4,
          bloom: 1,
          decay: 1,
          refresh: 0.05,
          keyframe: 0,
          block: 24,
          search: 48,
          scale: "4",
          threshold: 0.08,
          smooth: 0.35,
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
      { id: "e-mv-src", source: "image-1", sourceHandle: "out", target: "motion-1", targetHandle: "src" },
      { id: "e-src", source: "image-1", sourceHandle: "out", target: "datamosh-1", targetHandle: "src" },
      { id: "e-mv", source: "motion-1", sourceHandle: "out", target: "datamosh-1", targetHandle: "mv" },
      { id: "e-out", source: "datamosh-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
    timeline: {
      fps: 30,
      durationInFrames: 300,
      keyframes: {
        // Push, cut, push, cut, push — the one-frame drops are the cuts.
        "image-1:zoom": [
          { frame: 0, value: 1 },
          { frame: 100, value: 1.9 },
          { frame: 101, value: 1 },
          { frame: 200, value: 1.9 },
          { frame: 201, value: 1 },
          { frame: 300, value: 1.9 },
        ],
      },
    },
  } as SerializedPatch;
}
