import type { SerializedPatch } from "../store/persistence";

/**
 * Camera → Motion Vectors → Datamosh4 → Screen.
 *
 * Vectors stay a separate node so the field can be inspected or swapped for
 * Gen Motion. Auto is off: hold / tap the preview to withhold keyframes and
 * bloom; release fades back with Recovery ms.
 */
export function datamosh4(): SerializedPatch {
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
          mode: "camera",
          facing: "user",
          playing: true,
          muted: true,
          volume: 0,
          speed: 1,
          syncTimeline: false,
          mirror: true,
          fit: "cover",
          zoom: 1,
        },
      },
      {
        id: "motion-1",
        type: "fx.motion",
        position: { x: 330, y: 20 },
        params: {
          block: 16,
          search: 32,
          scale: "4",
          threshold: 0.12,
          smooth: 0.25,
          boost: 1,
          view: "vectors",
        },
      },
      {
        id: "datamosh4-1",
        type: "fx.datamosh4",
        position: { x: 660, y: 160 },
        params: {
          auto: false,
          latch: false,
          gain: 1.5,
          fade: 370,
          keyframe: 0,
          residual: 4,
          quant: 14,
          block: 16,
          blockiness: 1,
          skip: 0,
          mismatch: 0,
          lostDensity: 1,
          lostLayers: 4,
          lostLife: 50,
          lostScale: 2.65,
          lostAspect: 0.75,
          lostVariance: 1,
          precision: "2",
          vectors: false,
          sectors: false,
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
      { id: "e-src", source: "image-1", sourceHandle: "out", target: "datamosh4-1", targetHandle: "src" },
      { id: "e-mv", source: "motion-1", sourceHandle: "out", target: "datamosh4-1", targetHandle: "mv" },
      { id: "e-out", source: "datamosh4-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
    timeline: {
      fps: 30,
      durationInFrames: 300,
      keyframes: {},
    },
    published: ["datamosh4-1:auto", "datamosh4-1:gain", "datamosh4-1:fade", "datamosh4-1:latch"],
  } as SerializedPatch;
}
