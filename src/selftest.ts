/**
 * Headless-ish smoke test for the render core. Opens at /selftest.html and
 * steps the engine by hand, so it works even where rAF is throttled.
 *
 * It checks the things that are painful to eyeball: draw coordinates land where
 * the normalized input says, feedback actually decays, blend modes combine.
 */
import { Engine } from "./engine/runtime";
import { bindTarget, clearTarget, createRenderTarget } from "./engine/gl/rt";
import { BatchBuilder, drawPoints, drawSegments } from "./engine/gl/vector";
import { copyTexture } from "./engine/gl/quad";
import { SourceTexture } from "./engine/gl/videoTexture";
import type {
  CirclesValue,
  LandmarksValue,
  LinesValue,
  NodeDefinition,
  ParamSpec,
  PointsValue,
} from "./engine/types";
import { bandEnergy, bandDrive } from "./lib/audioBands";
import { primeAudioBuffer } from "./lib/audioBuffers";
import {
  audioModulatorSamples,
  mediaPlayheadSec,
  pickAudioMedia,
} from "./lib/audioModSamples";
import { computePeaks, resamplePeaks } from "./lib/peaks";
import {
  applyModulatorsToNodes,
  DEFAULT_MODULATOR,
  modulatedValue,
  MODULATOR_SHAPES,
  parseModulators,
  waveAt,
} from "./lib/modulators";
import { defineNode } from "./nodes/defineNode";
import { cutoffForScale, rectScale, sliceLoop } from "./nodes/audio/granular";
import { SHADER_PRESETS } from "./nodes/fx/shaderPresets";
import { fbm3 } from "./nodes/shared/noise";
import { RectTracker } from "./nodes/shared/rectTracker";
import { defaultParams, NODE_DEFS } from "./nodes/registry";
import { BUILTIN_PRESETS } from "./presets";
import { clearMediaMemory, recallMediaParams, rememberedFile, rememberMedia } from "./store/mediaMemory";
import { useNodeDebugStore } from "./store/nodeDebugStore";
import { parsePatch, serializePatch } from "./store/persistence";
import { loadTasksVision } from "./nodes/tracking/mediapipeShared";

const WIDTH = 320;
const HEIGHT = 200;

/** Emits one landmark pair: a horizontal bone across the upper third. */
const testLandmarks = defineNode<Record<string, never>>({
  type: "test.landmarks",
  label: "Test Landmarks",
  category: "tracking",
  description: "fixed points for coordinate checks",
  inputs: [],
  outputs: [{ id: "out", label: "landmarks", type: "landmarks" }],
  params: [],
  createState: () => ({}),
  evaluate() {
    const value: LandmarksValue = {
      sets: [
        [
          { x: 0.25, y: 0.25, z: 0, score: 1 },
          { x: 0.75, y: 0.25, z: 0, score: 1 },
        ],
      ],
      connections: [[0, 1]],
    };
    return { out: value };
  },
});

/** A flat opaque field, so background compositing is unambiguous. */
const testFill = defineNode<Record<string, never>>({
  type: "test.fill",
  label: "Test Fill",
  category: "source",
  description: "solid color fill",
  inputs: [],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [{ key: "level", label: "level", type: "range", min: 0, max: 1, step: 0.01, default: 0.2 }],
  createState: () => ({}),
  evaluate({ ctx, nodeId, params }) {
    const target = ctx.target(nodeId, "out");
    const level = typeof params.level === "number" ? params.level : 0.2;
    clearTarget(ctx.gl, target, level, level, level, 1);
    return { out: target };
  },
});

/** One circle dead center, radius a quarter of the width. */
const testCircles = defineNode<Record<string, never>>({
  type: "test.circles",
  label: "Test Circles",
  category: "tracking",
  description: "fixed circle",
  inputs: [],
  outputs: [{ id: "out", label: "circles", type: "circles" }],
  params: [],
  createState: () => ({}),
  evaluate() {
    const value: CirclesValue = { circles: [{ x: 0.5, y: 0.5, r: 0.25, score: 1 }] };
    return { out: value };
  },
});

/** One horizontal line low in the frame. */
const testLines = defineNode<Record<string, never>>({
  type: "test.lines",
  label: "Test Lines",
  category: "tracking",
  description: "fixed line segment",
  inputs: [],
  outputs: [{ id: "out", label: "lines", type: "lines" }],
  params: [],
  createState: () => ({}),
  evaluate() {
    const value: LinesValue = { lines: [{ x1: 0.2, y1: 0.8, x2: 0.8, y2: 0.8, score: 1 }] };
    return { out: value };
  },
});

/** A synthetic frame: white ring plus a horizontal bar on black. */
const testFrame = defineNode<{ canvas: HTMLCanvasElement; frameId: number }>({
  type: "test.frame",
  label: "Test Frame",
  category: "source",
  description: "synthetic frame for detectors",
  inputs: [],
  outputs: [{ id: "frame", label: "frame", type: "frame" }],
  params: [],
  createState() {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx2d = canvas.getContext("2d")!;
    ctx2d.fillStyle = "#000";
    ctx2d.fillRect(0, 0, WIDTH, HEIGHT);
    ctx2d.strokeStyle = "#fff";
    ctx2d.lineWidth = 4;
    ctx2d.beginPath();
    ctx2d.arc(WIDTH / 2, HEIGHT / 2, 40, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.beginPath();
    ctx2d.moveTo(30, 170);
    ctx2d.lineTo(WIDTH - 30, 170);
    ctx2d.stroke();
    return { canvas, frameId: 0 };
  },
  evaluate({ ctx, runtime }) {
    runtime.state.frameId += 1;
    return {
      frame: {
        element: runtime.state.canvas,
        width: WIDTH,
        height: HEIGHT,
        timestampMs: ctx.timeMs,
        frameId: runtime.state.frameId,
      },
    };
  },
});

/** One point dead center plus a few off to the side to drive the grid split. */
const testPoints = defineNode<Record<string, never>>({
  type: "test.points",
  label: "Test Points",
  category: "tracking",
  description: "fixed points",
  inputs: [],
  outputs: [{ id: "out", label: "points", type: "points" }],
  params: [],
  createState: () => ({}),
  evaluate() {
    const value: PointsValue = {
      points: [
        { x: 0.5, y: 0.5, score: 1 },
        { x: 0.2, y: 0.3, score: 0.8 },
        { x: 0.75, y: 0.7, score: 0.6 },
      ],
    };
    return { out: value };
  },
});

/** Horizontal black→red ramp, so any x-smear is obvious in the red channel. */
const testGradient = defineNode<{
  canvas: HTMLCanvasElement;
  texture: SourceTexture | null;
  drawn: string;
}>({
  type: "test.gradient",
  label: "Test Gradient",
  category: "source",
  description: "horizontal gradient",
  inputs: [],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [{ key: "reverse", label: "reverse", type: "toggle", default: false }],
  createState() {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    return { canvas, texture: null, drawn: "" };
  },
  disposeState(state) {
    state.texture?.dispose();
  },
  evaluate({ ctx, nodeId, params, runtime }) {
    const state = runtime.state;
    const key = params.reverse === true ? "rev" : "fwd";
    if (state.drawn !== key) {
      // Painted column by column: canvas gradients are dithered, which would
      // make otherwise identical rows differ and break exact comparisons.
      const ctx2d = state.canvas.getContext("2d")!;
      for (let x = 0; x < WIDTH; x += 1) {
        const t = x / (WIDTH - 1);
        const value = Math.round(255 * (key === "rev" ? 1 - t : t));
        ctx2d.fillStyle = `rgb(${value},0,0)`;
        ctx2d.fillRect(x, 0, 1, HEIGHT);
      }
      state.drawn = key;
      state.texture?.dispose();
      state.texture = null;
    }
    if (!state.texture) state.texture = new SourceTexture(ctx.gl);
    state.texture.upload(state.canvas, 1);
    const target = ctx.target(nodeId, "out");
    copyTexture(ctx.gl, state.texture.texture, target);
    return { out: target };
  },
});

const results: { name: string; pass: boolean; detail: string }[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function readPixel(engine: Engine, x: number, y: number): [number, number, number, number] {
  const gl = engine.gl;
  const target = engine.displayTarget;
  if (!target) return [0, 0, 0, 0];
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  const pixel = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return [pixel[0], pixel[1], pixel[2], pixel[3]];
}

/** Isolates the instanced vector renderer from the node layer. */
function testVectorRenderer(engine: Engine): void {
  const gl = engine.gl;
  const target = createRenderTarget(gl, WIDTH, HEIGHT);
  clearTarget(gl, target, 0, 0, 0, 1);
  bindTarget(gl, target);

  const batch = new BatchBuilder();
  batch.addPoint(WIDTH / 2, HEIGHT / 2, 20, 1);
  batch.addSegment(20, 20, WIDTH - 20, 20, 10, 1);

  drawPoints(gl, batch.pointBatch(), { color: [1, 0, 0], softness: 0.2 });
  const afterPoints = gl.getError();
  drawSegments(gl, batch.segmentBatch(), { color: [0, 1, 0], softness: 0.2 });
  const afterSegments = gl.getError();

  const pixel = new Uint8Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.readPixels(WIDTH / 2, HEIGHT / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  check(
    "raw drawPoints paints the target",
    pixel[0] > 180,
    `rgba=${[...pixel].join(",")} glError=${afterPoints}`,
  );

  const segPixel = new Uint8Array(4);
  gl.readPixels(WIDTH / 2, 20, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, segPixel);
  check(
    "raw drawSegments paints the target",
    segPixel[1] > 180,
    `rgba=${[...segPixel].join(",")} glError=${afterSegments}`,
  );

  // Same drawing, but preceded by a fullscreen pass — exactly what a draw node
  // does when it lays a background down first.
  const second = createRenderTarget(gl, WIDTH, HEIGHT);
  clearTarget(gl, second, 0.2, 0.2, 0.2, 1);
  copyTexture(gl, target.texture, second);
  bindTarget(gl, second);
  const batch2 = new BatchBuilder();
  batch2.addPoint(WIDTH / 2, HEIGHT / 2, 20, 1);
  drawPoints(gl, batch2.pointBatch(), { color: [0, 0, 1], softness: 0.2 });
  const afterMixed = gl.getError();
  const mixed = new Uint8Array(4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, second.framebuffer);
  gl.readPixels(WIDTH / 2, HEIGHT / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, mixed);
  check(
    "drawPoints after a fullscreen pass",
    mixed[2] > 180,
    `rgba=${[...mixed].join(",")} glError=${afterMixed}`,
  );
}

// Async because the worker-backed detectors answer on a later turn of the event
// loop; everything else in here still runs a tick at a time.
async function run(): Promise<void> {
  const canvas = document.createElement("canvas");
  const engine = new Engine(canvas);
  engine.setResolution(WIDTH, HEIGHT);
  testVectorRenderer(engine);
  engine.setDefinitions({
    ...NODE_DEFS,
    "test.landmarks": testLandmarks as NodeDefinition<never>,
    "test.fill": testFill as NodeDefinition<never>,
    "test.circles": testCircles as NodeDefinition<never>,
    "test.lines": testLines as NodeDefinition<never>,
    "test.frame": testFrame as NodeDefinition<never>,
    "test.points": testPoints as NodeDefinition<never>,
    "test.gradient": testGradient as NodeDefinition<never>,
  });
  engine.setResolution(WIDTH, HEIGHT);

  // --- 1. draw coordinates -------------------------------------------------
  engine.setGraph(
    [
      { id: "fill", type: "test.fill", params: { level: 0.2 } },
      { id: "lm", type: "test.landmarks", params: {} },
      {
        id: "draw",
        type: "draw.landmarks",
        params: {
          pointColor: "#ff0000",
          boneColor: "#00ff00",
          pointSize: 6,
          boneWidth: 6,
          opacity: 1,
          scoreFade: false,
          blend: "normal",
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "fill", sourceHandle: "out", target: "draw", targetHandle: "bg" },
      { id: "b", source: "lm", sourceHandle: "out", target: "draw", targetHandle: "landmarks" },
      { id: "c", source: "draw", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();

  const debug = engine as unknown as {
    outputs: Map<string, Record<string, unknown>>;
    order: string[];
  };
  const lmOut = debug.outputs.get("lm")?.out as LandmarksValue | undefined;
  check(
    "landmarks value reaches the graph outputs",
    (lmOut?.sets.length ?? 0) === 1,
    `order=${debug.order.join(">")} sets=${lmOut?.sets.length ?? "none"}`,
  );

  // Targets store v=0 at the image top, and framebuffer row 0 *is* v=0 — so a
  // landmark at y=0.25 is read at row 0.25*height, counting the same direction.
  const boneRow = Math.round(0.25 * HEIGHT);
  const midBone = readPixel(engine, Math.round(WIDTH / 2), boneRow);
  check(
    "bone drawn at y=0.25 (green)",
    midBone[1] > 180 && midBone[0] < 80,
    `rgba=${midBone.join(",")}`,
  );

  const atPoint = readPixel(engine, Math.round(0.25 * WIDTH), boneRow);
  check("point drawn at x=0.25 (red)", atPoint[0] > 180, `rgba=${atPoint.join(",")}`);

  const background = readPixel(engine, 10, 10);
  check(
    "background preserved under drawing",
    Math.abs(background[0] - 51) < 6 && background[3] === 255,
    `rgba=${background.join(",")} (expected ~51)`,
  );

  const emptyArea = readPixel(engine, Math.round(WIDTH / 2), Math.round(HEIGHT * 0.75));
  check(
    "no stray geometry far from landmarks",
    Math.abs(emptyArea[0] - 51) < 6 && Math.abs(emptyArea[1] - 51) < 6,
    `rgba=${emptyArea.join(",")}`,
  );

  // --- 2. feedback decays --------------------------------------------------
  engine.setGraph(
    [
      { id: "lm", type: "test.landmarks", params: {} },
      {
        id: "draw",
        type: "draw.landmarks",
        params: {
          pointColor: "#ffffff",
          boneColor: "#ffffff",
          pointSize: 8,
          boneWidth: 8,
          opacity: 1,
          scoreFade: false,
          blend: "normal",
        },
      },
      {
        id: "fb",
        type: "fx.feedback",
        params: {
          decay: 0.5,
          zoom: 1,
          rotate: 0,
          offsetX: 0,
          offsetY: 0,
          mode: "over",
          clear: false,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "lm", sourceHandle: "out", target: "draw", targetHandle: "landmarks" },
      { id: "b", source: "draw", sourceHandle: "out", target: "fb", targetHandle: "src" },
      { id: "c", source: "fb", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );

  engine.tick();
  const firstFrame = readPixel(engine, Math.round(WIDTH / 2), boneRow);
  check("feedback passes the live frame", firstFrame[0] > 180, `rgba=${firstFrame.join(",")}`);

  // Disconnect the source: what remains must be the decaying accumulation.
  engine.setGraph(
    [
      {
        id: "fb",
        type: "fx.feedback",
        params: {
          decay: 0.5,
          zoom: 1,
          rotate: 0,
          offsetX: 0,
          offsetY: 0,
          mode: "over",
          clear: false,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [{ id: "c", source: "fb", sourceHandle: "out", target: "out", targetHandle: "src" }],
  );
  engine.tick();
  const decayed = readPixel(engine, Math.round(WIDTH / 2), boneRow);
  check(
    "feedback decays without input",
    decayed[0] > 90 && decayed[0] < 160,
    `rgba=${decayed.join(",")} (expected ~128)`,
  );

  engine.tick();
  const decayedTwice = readPixel(engine, Math.round(WIDTH / 2), boneRow);
  check(
    "feedback keeps decaying",
    decayedTwice[0] > 40 && decayedTwice[0] < decayed[0],
    `rgba=${decayedTwice.join(",")} (expected ~64)`,
  );

  // --- 3. blend add --------------------------------------------------------
  engine.setGraph(
    [
      { id: "f1", type: "test.fill", params: { level: 0.2 } },
      { id: "f2", type: "test.fill", params: { level: 0.3 } },
      { id: "bl", type: "fx.blend", params: { mode: "add", opacity: 1 } },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "f1", sourceHandle: "out", target: "bl", targetHandle: "base" },
      { id: "b", source: "f2", sourceHandle: "out", target: "bl", targetHandle: "top" },
      { id: "c", source: "bl", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();
  const added = readPixel(engine, 40, 40);
  check(
    "blend add sums both inputs",
    Math.abs(added[0] - 128) < 8,
    `rgba=${added.join(",")} (expected ~128)`,
  );

  // --- 4. circles and lines ------------------------------------------------
  engine.setGraph(
    [
      { id: "c", type: "test.circles", params: {} },
      { id: "l", type: "test.lines", params: {} },
      {
        id: "dc",
        type: "draw.circles",
        params: {
          color: "#0000ff",
          thickness: 4,
          fill: false,
          radiusScale: 1,
          opacity: 1,
          scoreFade: false,
          blend: "normal",
        },
      },
      {
        id: "dl",
        type: "draw.lines",
        params: {
          color: "#ff0000",
          width: 6,
          extend: 1,
          opacity: 1,
          scoreFade: false,
          endpoints: false,
          endpointSize: 5,
          blend: "normal",
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "c", sourceHandle: "out", target: "dc", targetHandle: "circles" },
      { id: "b", source: "dc", sourceHandle: "out", target: "dl", targetHandle: "bg" },
      { id: "d", source: "l", sourceHandle: "out", target: "dl", targetHandle: "lines" },
      { id: "e", source: "dl", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();

  // The test circle is centered at (0.5, 0.5) with r = 0.25 * width = 80px.
  const centerX = Math.round(WIDTH / 2);
  const centerY = Math.round(HEIGHT / 2);
  const onRing = readPixel(engine, centerX + 80, centerY);
  check("circle ring drawn at its radius", onRing[2] > 150, `rgba=${onRing.join(",")}`);

  const insideRing = readPixel(engine, centerX + 40, centerY);
  check(
    "circle is a ring, not a disc",
    insideRing[2] < 60,
    `rgba=${insideRing.join(",")} (inside should be empty)`,
  );

  // The test line runs across y = 0.8.
  const lineRow = Math.round(0.8 * HEIGHT);
  const onLine = readPixel(engine, centerX, lineRow);
  check("line drawn at y=0.8 (red)", onLine[0] > 150, `rgba=${onLine.join(",")}`);

  // --- 4b. detection-style points and the features grid --------------------
  engine.setGraph(
    [
      { id: "pts", type: "test.points", params: {} },
      {
        id: "dp",
        type: "draw.points",
        params: {
          ...defaultParams("draw.points"),
          style: "circle",
          color: "#00ff00",
          minRadius: 30,
          maxRadius: 30,
          stroke: 4,
          centerDot: true,
          opacity: 1,
          linkRadius: 0,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "pts", sourceHandle: "out", target: "dp", targetHandle: "points" },
      { id: "b", source: "dp", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();

  // The test point sits at (0.5, 0.5) with score 1 → a ring of radius 30.
  const ringEdge = readPixel(engine, Math.round(WIDTH / 2) + 30, Math.round(HEIGHT / 2));
  check("detection style draws a ring", ringEdge[1] > 90, `rgba=${ringEdge.join(",")}`);

  const ringCenter = readPixel(engine, Math.round(WIDTH / 2), Math.round(HEIGHT / 2));
  check("detection style keeps a centre dot", ringCenter[1] > 90, `rgba=${ringCenter.join(",")}`);

  const ringHollow = readPixel(engine, Math.round(WIDTH / 2) + 15, Math.round(HEIGHT / 2));
  check(
    "detection ring is hollow between dot and edge",
    ringHollow[1] < 40,
    `rgba=${ringHollow.join(",")}`,
  );

  engine.setGraph(
    [
      { id: "pts", type: "test.points", params: {} },
      {
        id: "grid",
        type: "draw.featuresGrid",
        params: {
          ...defaultParams("draw.featuresGrid"),
          color: "#ff0000",
          maxDepth: 4,
          minSize: 40,
          stroke: 2,
          labels: false,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "pts", sourceHandle: "out", target: "grid", targetHandle: "points" },
      { id: "b", source: "grid", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();

  // Whatever the split, the frame border is always stroked.
  const gridBorder = readPixel(engine, 1, Math.round(HEIGHT / 2));
  check("features grid strokes cell borders", gridBorder[0] > 90, `rgba=${gridBorder.join(",")}`);

  // Well inside the top-left leaf cell: the splits land on x=160 and y=60.
  const gridInside = readPixel(engine, Math.round(WIDTH * 0.35), Math.round(HEIGHT * 0.15));
  check("features grid leaves cells empty", gridInside[0] < 60, `rgba=${gridInside.join(",")}`);

  // --- 4c. features grid smear effect --------------------------------------
  const gridWithEffect = (chance: number) => {
    engine.setGraph(
      [
        { id: "grad", type: "test.gradient", params: {} },
        { id: "pts", type: "test.points", params: {} },
        {
          id: "grid",
          type: "draw.featuresGrid",
          params: {
            ...defaultParams("draw.featuresGrid"),
            maxDepth: 4,
            minSize: 40,
            stroke: 1,
            labels: false,
            effectChance: chance,
            effectSeed: 42,
          },
        },
        { id: "out", type: "output.screen", params: { background: "#000000" } },
      ],
      [
        { id: "a", source: "grad", sourceHandle: "out", target: "grid", targetHandle: "bg" },
        { id: "b", source: "pts", sourceHandle: "out", target: "grid", targetHandle: "points" },
        { id: "c", source: "grid", sourceHandle: "out", target: "out", targetHandle: "src" },
      ],
    );
    engine.tick();
    // Both samples sit inside the same top-left leaf cell (splits: x=160, y=60).
    return [readPixel(engine, 20, 30)[0], readPixel(engine, 140, 30)[0]];
  };

  const [plainLeft, plainRight] = gridWithEffect(0);
  check(
    "grid without effect keeps the gradient",
    plainRight - plainLeft > 50,
    `left=${plainLeft} right=${plainRight} (should differ)`,
  );

  const [smearLeft, smearRight] = gridWithEffect(1);
  check(
    "effect smears a cell into one column",
    Math.abs(smearRight - smearLeft) < 8,
    `left=${smearLeft} right=${smearRight} (should match)`,
  );
  check(
    "smeared column comes from the cell centre",
    Math.abs(smearLeft - 64) < 12,
    `value=${smearLeft} (cell centre x=80 → ~64)`,
  );

  // The `rects` port is what drives Granular, so it has to carry the same cells
  // the node just drew. Painting them through Draw Boxes proves the wire.
  engine.setGraph(
    [
      { id: "pts", type: "test.points", params: {} },
      {
        id: "grid",
        type: "draw.featuresGrid",
        params: {
          ...defaultParams("draw.featuresGrid"),
          maxDepth: 4,
          minSize: 40,
          stroke: 1,
          labels: false,
          opacity: 0,
        },
      },
      {
        id: "dbx",
        type: "draw.boxes",
        params: {
          ...defaultParams("draw.boxes"),
          color: "#00ff00",
          width: 2,
          centers: false,
          scoreFade: false,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "pts", sourceHandle: "out", target: "grid", targetHandle: "points" },
      { id: "b", source: "grid", sourceHandle: "rects", target: "dbx", targetHandle: "boxes" },
      { id: "c", source: "dbx", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();

  const rectRow = new Uint8Array(WIDTH * 4);
  engine.gl.bindFramebuffer(engine.gl.FRAMEBUFFER, engine.displayTarget!.framebuffer);
  engine.gl.readPixels(
    0,
    Math.round(HEIGHT / 2),
    WIDTH,
    1,
    engine.gl.RGBA,
    engine.gl.UNSIGNED_BYTE,
    rectRow,
  );
  let strokedColumns = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    if (rectRow[x * 4 + 1]! > 90) strokedColumns += 1;
  }
  // Both frame edges at least, two pixels of stroke each.
  check(
    "features grid exports its cells as rects",
    strokedColumns >= 4,
    `${strokedColumns} stroked columns across the middle row`,
  );

  // --- 4c-bis. points noise -------------------------------------------------
  // Whole-frame fingerprint: enough to tell "the cloud moved" from "it did not"
  // without pinning down where any individual point landed.
  const frameSignature = (): number => {
    const gl = engine.gl;
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, engine.displayTarget!.framebuffer);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 0;
    for (let i = 0; i < pixels.length; i += 4) hash = (hash * 31 + pixels[i]!) | 0;
    return hash;
  };

  const noiseGraph = (animate: boolean) => {
    engine.setGraph(
      [
        {
          id: "pn",
          type: "generate.pointsNoise",
          params: {
            ...defaultParams("generate.pointsNoise"),
            count: 120,
            animate,
            speed: 2,
            amount: 0.3,
          },
        },
        {
          id: "dp",
          type: "draw.points",
          params: { ...defaultParams("draw.points"), color: "#ffffff", linkRadius: 0 },
        },
        { id: "out", type: "output.screen", params: { background: "#000000" } },
      ],
      [
        { id: "a", source: "pn", sourceHandle: "out", target: "dp", targetHandle: "points" },
        { id: "b", source: "dp", sourceHandle: "out", target: "out", targetHandle: "src" },
      ],
    );
  };

  noiseGraph(true);
  engine.setTimeline(0, 30, false);
  engine.tick();
  const movedA = frameSignature();
  engine.setTimeline(15, 30, false);
  engine.tick();
  const movedB = frameSignature();
  check(
    "animated noise points move with the timeline",
    movedA !== movedB && movedA !== 0,
    `${movedA} → ${movedB}`,
  );

  // Same playhead twice must redraw the same field (offline / scrub lockstep).
  engine.setTimeline(15, 30, false);
  engine.tick();
  const movedBAgain = frameSignature();
  check(
    "noise at a timeline frame is deterministic",
    movedB === movedBAgain && movedB !== 0,
    `${movedB} → ${movedBAgain}`,
  );

  noiseGraph(false);
  engine.setTimeline(0, 30, false);
  engine.tick();
  const frozenA = frameSignature();
  engine.setTimeline(30, 30, false);
  engine.tick();
  const frozenB = frameSignature();
  // A blank frame hashes to 0, which would pass the equality on its own.
  check(
    "Animate off freezes the field",
    frozenA === frozenB && frozenA !== 0,
    `${frozenA} → ${frozenB}`,
  );

  // With points wired in it displaces those instead of generating its own: three
  // test points in, three shaken points out, each within Displacement of home.
  engine.setGraph(
    [
      { id: "pts", type: "test.points", params: {} },
      {
        id: "pn",
        type: "generate.pointsNoise",
        params: {
          ...defaultParams("generate.pointsNoise"),
          count: 500,
          animate: false,
          amount: 0.05,
          sizeNoise: 0,
          size: 1,
        },
      },
      {
        id: "dp",
        type: "draw.points",
        params: { ...defaultParams("draw.points"), color: "#ffffff", linkRadius: 0 },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "pts", sourceHandle: "out", target: "pn", targetHandle: "points" },
      { id: "b", source: "pn", sourceHandle: "out", target: "dp", targetHandle: "points" },
      { id: "c", source: "dp", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();

  // test.points sits at x = 0.2 … 0.75; Count is deliberately 500, so falling
  // back to the generated cloud would both flood the frame and span its width.
  const lit = (() => {
    const gl = engine.gl;
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, engine.displayTarget!.framebuffer);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    let minX = WIDTH;
    let maxX = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        if (pixels[(y * WIDTH + x) * 4]! <= 40) continue;
        count += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    return { count, minX, maxX };
  })();
  check(
    "wired points drive the noise instead of the generated cloud",
    lit.count > 0 &&
      lit.count < WIDTH * HEIGHT * 0.03 &&
      lit.minX > WIDTH * 0.1 &&
      lit.maxX < WIDTH * 0.88,
    `${lit.count} lit pixels, x ${lit.minX}..${lit.maxX} of ${WIDTH}`,
  );

  // --- 4d. glitch effects ported from glitcher -----------------------------
  const readRow = (y: number): number[] => {
    const gl = engine.gl;
    const rt = engine.displayTarget!;
    const row = new Uint8Array(WIDTH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
    gl.readPixels(0, y, WIDTH, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
    const out: number[] = [];
    for (let x = 0; x < WIDTH; x += 1) out.push(row[x * 4]);
    return out;
  };

  const runSlice = (count: number) => {
    engine.setGraph(
      [
        { id: "grad", type: "test.gradient", params: { reverse: false } },
        {
          id: "fx",
          type: "fx.sliceShift",
          params: { ...defaultParams("fx.sliceShift"), count, maxH: 20, amount: 40, seed: 7 },
        },
        { id: "out", type: "output.screen", params: { background: "#000000" } },
      ],
      [
        { id: "a", source: "grad", sourceHandle: "out", target: "fx", targetHandle: "src" },
        { id: "b", source: "fx", sourceHandle: "out", target: "out", targetHandle: "src" },
      ],
    );
    engine.tick();
    const rows: number[][] = [];
    for (let y = 0; y < HEIGHT; y += 1) rows.push(readRow(y));
    return rows;
  };

  const untouched = runSlice(0);
  const reference = untouched[0];
  check(
    "slice shift with 0 bands is a pass-through",
    untouched.every((row) => row.every((v, x) => v === reference[x])),
    "all rows match the gradient",
  );

  const shifted = runSlice(1);
  const movedRows = shifted.filter((row) => row.some((v, x) => v !== reference[x]));
  check(
    "one band moves between 1 and maxH rows",
    movedRows.length >= 1 && movedRows.length <= 20,
    `rows shifted: ${movedRows.length} (band ≤ 20)`,
  );

  // A wrapped shift only rotates a row — the multiset of values must survive.
  const sortedRef = [...reference].sort((a, b) => a - b).join(",");
  const sortedMoved = [...movedRows[0]].sort((a, b) => a - b).join(",");
  check(
    "shifted row is a rotation, not a clamp",
    sortedMoved === sortedRef,
    movedRows.length ? "row value set preserved" : "no shifted rows",
  );

  const runBlocks = (count: number) => {
    engine.setGraph(
      [
        { id: "grad", type: "test.gradient", params: { reverse: false } },
        {
          id: "fx",
          type: "fx.blockScatter",
          params: { ...defaultParams("fx.blockScatter"), count, spread: 40, tint: 0, seed: 3 },
        },
        { id: "out", type: "output.screen", params: { background: "#000000" } },
      ],
      [
        { id: "a", source: "grad", sourceHandle: "out", target: "fx", targetHandle: "src" },
        { id: "b", source: "fx", sourceHandle: "out", target: "out", targetHandle: "src" },
      ],
    );
    engine.tick();
    const rows: number[][] = [];
    for (let y = 0; y < HEIGHT; y += 1) rows.push(readRow(y));
    return rows;
  };

  const noBlocks = runBlocks(0);
  check(
    "block scatter with 0 blocks is a pass-through",
    noBlocks.every((row) => row.every((v, x) => v === reference[x])),
    "frame untouched",
  );

  const scattered = runBlocks(60);
  const changed = scattered.reduce(
    (sum, row) => sum + row.filter((v, x) => v !== reference[x]).length,
    0,
  );
  check(
    "block scatter moves pixels",
    changed > 500,
    `pixels changed: ${changed}`,
  );

  // Blocks land on a copy of the frame, so nothing may be left blank.
  const holes = scattered.reduce((sum, row) => sum + row.filter((v) => v === 0).length, 0);
  const referenceZeros = reference.filter((v) => v === 0).length * HEIGHT;
  check(
    "block scatter leaves no holes",
    holes <= referenceZeros * 1.5 + 200,
    `zero pixels: ${holes}, in source: ${referenceZeros}`,
  );

  // Pixel sort: feed a descending ramp so an ascending sort visibly flips it.
  // Inline (worker: false) so a single tick has the answer.
  engine.setGraph(
    [
      { id: "grad", type: "test.gradient", params: { reverse: true } },
      {
        id: "fx",
        type: "fx.pixelSort",
        params: {
          ...defaultParams("fx.pixelSort"),
          thresh: 20,
          vert: false,
          interval: 1,
          worker: false,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "grad", sourceHandle: "out", target: "fx", targetHandle: "src" },
      { id: "b", source: "fx", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();
  const sortedRow = readRow(Math.round(HEIGHT / 2));
  // Luminance of (r,0,0) is 0.299r, so a threshold of 20 spans x where r > ~67 —
  // the left ~74% of a descending ramp. That span comes back ascending.
  let ascending = true;
  for (let x = 2; x < 220; x += 1) {
    if (sortedRow[x] > sortedRow[x + 1] + 1) ascending = false;
  }
  check(
    "pixel sort reorders a span by luminance",
    ascending && sortedRow[10] < sortedRow[200],
    `x=10 → ${sortedRow[10]}, x=200 → ${sortedRow[200]}, ascending=${ascending}`,
  );

  // Async PBO path: first tick issues the readback (null), later ticks land
  // pixels one frame behind — sort must still flip the ramp.
  engine.setGraph(
    [
      { id: "grad", type: "test.gradient", params: { reverse: true } },
      {
        id: "fx",
        type: "fx.pixelSort",
        params: {
          ...defaultParams("fx.pixelSort"),
          thresh: 20,
          vert: false,
          interval: 1,
          asyncRead: true,
          worker: false,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "grad", sourceHandle: "out", target: "fx", targetHandle: "src" },
      { id: "b", source: "fx", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();
  engine.tick();
  engine.tick();
  const asyncSortedRow = readRow(Math.round(HEIGHT / 2));
  let asyncAscending = true;
  for (let x = 2; x < 220; x += 1) {
    if (asyncSortedRow[x] > asyncSortedRow[x + 1] + 1) asyncAscending = false;
  }
  check(
    "pixel sort async readback still reorders by luminance",
    asyncAscending && asyncSortedRow[10] < asyncSortedRow[200],
    `x=10 → ${asyncSortedRow[10]}, x=200 → ${asyncSortedRow[200]}, ascending=${asyncAscending}`,
  );

  // Worker path: sort lands a frame later — poll like Hough.
  engine.setGraph(
    [
      { id: "grad", type: "test.gradient", params: { reverse: true } },
      {
        id: "fx",
        type: "fx.pixelSort",
        params: {
          ...defaultParams("fx.pixelSort"),
          thresh: 20,
          vert: false,
          interval: 1,
          worker: true,
        },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "grad", sourceHandle: "out", target: "fx", targetHandle: "src" },
      { id: "b", source: "fx", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  let workerAscending = false;
  let workerSortedRow = readRow(Math.round(HEIGHT / 2));
  for (let i = 0; i < 60; i += 1) {
    engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 16));
    workerSortedRow = readRow(Math.round(HEIGHT / 2));
    workerAscending = true;
    for (let x = 2; x < 220; x += 1) {
      if (workerSortedRow[x]! > workerSortedRow[x + 1]! + 1) workerAscending = false;
    }
    if (workerAscending && workerSortedRow[10]! < workerSortedRow[200]!) break;
  }
  check(
    "pixel sort on the worker reorders by luminance",
    workerAscending && workerSortedRow[10]! < workerSortedRow[200]!,
    `x=10 → ${workerSortedRow[10]}, x=200 → ${workerSortedRow[200]}, ascending=${workerAscending}`,
  );

  // --- 4d. custom shader node ----------------------------------------------
  const runShader = (source: string) => {
    engine.setGraph(
      [
        { id: "grad", type: "test.gradient", params: { reverse: false } },
        {
          id: "sh",
          type: "fx.shader",
          params: { ...defaultParams("fx.shader"), source },
        },
        { id: "out", type: "output.screen", params: { background: "#000000" } },
      ],
      [
        { id: "a", source: "grad", sourceHandle: "out", target: "sh", targetHandle: "src" },
        { id: "b", source: "sh", sourceHandle: "out", target: "out", targetHandle: "src" },
      ],
    );
    engine.tick();
    return readPixel(engine, Math.round(WIDTH * 0.75), Math.round(HEIGHT / 2));
  };

  // Swapping the channels proves the user's code is what ran, not a pass-through.
  const shaded = runShader(
    "void main() { vec4 t = texture(uTex, vUv); fragColor = vec4(0.0, t.r, 0.0, 1.0); }",
  );
  check(
    "shader node runs user source",
    shaded[1] > 150 && shaded[0] < 20,
    `rgba=${shaded.join(",")} (red should move to green)`,
  );

  // A broken shader must not black out the chain, and must say why.
  const broken = runShader("void main() { fragColor = nope; }");
  const brokenStatus = engine.statusOf("sh");
  check(
    "broken shader passes input through and reports",
    broken[0] > 150 && brokenStatus?.status === "error" && !!brokenStatus.message,
    `rgba=${broken.join(",")} status=${brokenStatus?.status} msg=${(brokenStatus?.message ?? "none").slice(0, 60)}`,
  );

  // Every shipped preset must build. A driver rejects GLSL the type checker
  // never sees, so this is the only thing that actually proves they work.
  const presetErrors: string[] = [];
  for (const preset of SHADER_PRESETS) {
    runShader(preset.source);
    const status = engine.statusOf("sh");
    if (status?.status === "error") {
      presetErrors.push(`${preset.label}: ${(status.message ?? "").slice(0, 80)}`);
    }
  }
  check(
    "every shader preset compiles",
    presetErrors.length === 0,
    presetErrors.join(" | ") || `${SHADER_PRESETS.length} presets`,
  );

  // Pixelate at full strength must flatten detail the gradient otherwise has:
  // two nearby columns inside one block have to come back identical.
  const pixelate = SHADER_PRESETS.find((p) => p.id === "pixelate")!;
  engine.setGraph(
    [
      { id: "grad", type: "test.gradient", params: { reverse: false } },
      {
        id: "sh",
        type: "fx.shader",
        params: { ...defaultParams("fx.shader"), source: pixelate.source, k1: 1, k2: 0 },
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "grad", sourceHandle: "out", target: "sh", targetHandle: "src" },
      { id: "b", source: "sh", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();
  const blockA = readPixel(engine, 150, HEIGHT / 2)[0];
  const blockB = readPixel(engine, 154, HEIGHT / 2)[0];
  const blockFar = readPixel(engine, 300, HEIGHT / 2)[0];
  check(
    "pixelate flattens within a block but not across the frame",
    blockA === blockB && Math.abs(blockFar - blockA) > 40,
    `x150=${blockA} x154=${blockB} x300=${blockFar}`,
  );

  // --- 4e. particles --------------------------------------------------------
  // test.points emits from (0.5, 0.5) among others. With no forces and a short
  // life, particles must show up there and be gone once every one has expired.
  const particleParams = {
    ...defaultParams("draw.particles"),
    rate: 600,
    life: 0.3,
    speed: 40,
    gravity: 0,
    drag: 0,
    attract: 0,
    size: 6,
    trail: 0,
    opacity: 1,
  };
  engine.setGraph(
    [
      { id: "pts", type: "test.points", params: {} },
      { id: "par", type: "draw.particles", params: particleParams },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "pts", sourceHandle: "out", target: "par", targetHandle: "points" },
      { id: "b", source: "par", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  for (let i = 0; i < 6; i += 1) engine.tick();

  const nearEmitter = readPixel(engine, Math.round(WIDTH * 0.5), Math.round(HEIGHT * 0.5));
  const farCorner = readPixel(engine, 4, 4);
  check(
    "particles appear at the emitter",
    nearEmitter[1] > 20 && farCorner[1] < 10,
    `emitter=${nearEmitter.join(",")} corner=${farCorner.join(",")}`,
  );

  // Emission stops without points; after more than one lifetime nothing is left.
  engine.setGraph(
    [
      { id: "par", type: "draw.particles", params: particleParams },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [{ id: "b", source: "par", sourceHandle: "out", target: "out", targetHandle: "src" }],
  );
  for (let i = 0; i < 30; i += 1) engine.tick();
  const afterLifetime = readPixel(engine, Math.round(WIDTH * 0.5), Math.round(HEIGHT * 0.5));
  check(
    "particles expire and stop emitting",
    afterLifetime[1] < 10,
    `rgba=${afterLifetime.join(",")}`,
  );

  // --- 5. Hough detectors on a synthetic frame -----------------------------
  engine.setGraph(
    [
      { id: "src", type: "test.frame", params: {} },
      {
        id: "hc",
        type: "tracking.circles",
        params: {
          ...defaultParams("tracking.circles"),
          downscale: 2,
          edgeThreshold: 90,
          votes: 25,
          minRadius: 20,
          maxRadius: 80,
          interval: 1,
          // Inline, so a single tick has the answer. The worker path runs the
          // very same functions and is checked separately below.
          worker: false,
        },
      },
      {
        id: "hl",
        type: "tracking.lines",
        params: {
          ...defaultParams("tracking.lines"),
          downscale: 2,
          edgeThreshold: 80,
          votes: 30,
          minLength: 80,
          interval: 1,
          worker: false,
        },
      },
    ],
    [
      { id: "a", source: "src", sourceHandle: "frame", target: "hc", targetHandle: "frame" },
      { id: "b", source: "src", sourceHandle: "frame", target: "hl", targetHandle: "frame" },
    ],
  );
  engine.tick();

  const houghDebug = engine as unknown as { outputs: Map<string, Record<string, unknown>> };
  const foundCircles = (houghDebug.outputs.get("hc")?.out as CirclesValue | undefined)?.circles ?? [];
  const best = foundCircles[0];
  check(
    "Hough finds the synthetic circle near center",
    best !== undefined && Math.abs(best.x - 0.5) < 0.08 && Math.abs(best.y - 0.5) < 0.08,
    best ? `x=${best.x.toFixed(2)} y=${best.y.toFixed(2)} r=${best.r.toFixed(3)}` : "nothing found",
  );
  check(
    "…with roughly the right radius",
    best !== undefined && Math.abs(best.r * WIDTH - 40) < 14,
    best ? `r=${(best.r * WIDTH).toFixed(1)}px (expected ~40)` : "no circle",
  );

  const foundLines = (houghDebug.outputs.get("hl")?.out as LinesValue | undefined)?.lines ?? [];
  const horizontal = foundLines.find((line) => Math.abs(line.y1 - line.y2) < 0.03);
  check(
    "Hough finds the synthetic horizontal line",
    horizontal !== undefined && Math.abs(horizontal.y1 - 170 / HEIGHT) < 0.06,
    horizontal
      ? `y=${horizontal.y1.toFixed(2)} (expected ${(170 / HEIGHT).toFixed(2)}), total=${foundLines.length}`
      : `not found, total=${foundLines.length}`,
  );

  // --- 5b. the same detector, on the worker --------------------------------
  // Results come back asynchronously, so this ticks and waits instead of
  // reading straight after one tick like the inline checks above.
  engine.setGraph(
    [
      { id: "src", type: "test.frame", params: {} },
      {
        id: "hcw",
        type: "tracking.circles",
        params: {
          ...defaultParams("tracking.circles"),
          downscale: 2,
          edgeThreshold: 90,
          votes: 25,
          minRadius: 20,
          maxRadius: 80,
          interval: 1,
          worker: true,
        },
      },
    ],
    [{ id: "a", source: "src", sourceHandle: "frame", target: "hcw", targetHandle: "frame" }],
  );

  let workerCircles: CirclesValue["circles"] = [];
  for (let i = 0; i < 60 && workerCircles.length === 0; i += 1) {
    engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 16));
    workerCircles =
      (houghDebug.outputs.get("hcw")?.out as CirclesValue | undefined)?.circles ?? [];
  }
  const workerBest = workerCircles[0];
  check(
    "Hough on the worker finds the same circle",
    workerBest !== undefined &&
      Math.abs(workerBest.x - 0.5) < 0.08 &&
      Math.abs(workerBest.y - 0.5) < 0.08,
    workerBest
      ? `x=${workerBest.x.toFixed(2)} y=${workerBest.y.toFixed(2)} r=${workerBest.r.toFixed(3)}`
      : "nothing came back",
  );

  // --- 5b2. Corners on the shared Hough worker -----------------------------
  engine.setGraph(
    [
      { id: "src", type: "test.frame", params: {} },
      {
        id: "cn",
        type: "tracking.features",
        params: {
          ...defaultParams("tracking.features"),
          downscale: 2,
          maxCorners: 80,
          quality: 0.05,
          minDistance: 8,
          interval: 1,
          worker: false,
        },
      },
    ],
    [{ id: "a", source: "src", sourceHandle: "frame", target: "cn", targetHandle: "frame" }],
  );
  engine.tick();
  const inlineCorners =
    (houghDebug.outputs.get("cn")?.out as PointsValue | undefined)?.points ?? [];
  check(
    "Corners finds points on the synthetic frame (inline)",
    inlineCorners.length > 0,
    `points=${inlineCorners.length}`,
  );

  engine.setGraph(
    [
      { id: "src", type: "test.frame", params: {} },
      {
        id: "cnw",
        type: "tracking.features",
        params: {
          ...defaultParams("tracking.features"),
          downscale: 2,
          maxCorners: 80,
          quality: 0.05,
          minDistance: 8,
          interval: 1,
          worker: true,
        },
      },
    ],
    [{ id: "a", source: "src", sourceHandle: "frame", target: "cnw", targetHandle: "frame" }],
  );
  let workerCorners: PointsValue["points"] = [];
  for (let i = 0; i < 60 && workerCorners.length === 0; i += 1) {
    engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 16));
    workerCorners =
      (houghDebug.outputs.get("cnw")?.out as PointsValue | undefined)?.points ?? [];
  }
  check(
    "Corners on the Hough worker finds points",
    workerCorners.length > 0,
    `points=${workerCorners.length}`,
  );

  // --- 5c. Features Tracking points (not gated on minAge) ------------------
  engine.setGraph(
    [
      { id: "src", type: "test.frame", params: {} },
      {
        id: "ft",
        type: "tracking.featuresTrack",
        params: {
          ...defaultParams("tracking.featuresTrack"),
          downscale: 2,
          maxCorners: 80,
          quality: 0.05,
          minDistance: 8,
          minAge: 50,
          detectInterval: 1,
        },
      },
    ],
    [{ id: "a", source: "src", sourceHandle: "frame", target: "ft", targetHandle: "frame" }],
  );
  engine.tick();
  const ftOut = (houghDebug.outputs.get("ft") ?? {}) as {
    points?: PointsValue;
    out?: LinesValue;
  };
  const ftPoints = ftOut.points?.points ?? [];
  const ftLines = ftOut.out?.lines ?? [];
  check(
    "Features Tracking emits points on first detect (ignores minAge)",
    ftPoints.length > 0,
    `points=${ftPoints.length} lines=${ftLines.length} (lines may be 0 until age≥minAge)`,
  );

  engine.dispose();

  // --- 6. patch serialization ---------------------------------------------
  const patch = serializePatch(
    [
      {
        id: "cam-1",
        type: "patch",
        position: { x: 10, y: 20 },
        data: {
          defType: "source.media",
          params: { ...defaultParams("source.media"), mode: "video", file: { name: "x.mp4", url: "blob:zzz" } },
        },
      },
    ],
    [],
    1920,
    1080,
  );
  check(
    "blob file params are stripped on save",
    !("file" in patch.nodes[0].params),
    `params=${Object.keys(patch.nodes[0].params).join(",")}`,
  );

  const roundTrip = parsePatch(JSON.parse(JSON.stringify(patch)));
  check(
    "patch survives a save/load round trip",
    roundTrip?.nodes.length === 1 && roundTrip.width === 1920,
    `nodes=${roundTrip?.nodes.length ?? 0} width=${roundTrip?.width ?? "none"}`,
  );

  check("garbage input is rejected", parsePatch({ hello: 1 }) === null, "parsePatch({hello:1})");

  // Keyframes ride along in the patch, minus the ones that cannot survive a
  // reload: file params hold blob URLs, and tracks for deleted nodes are dead.
  const keyed = serializePatch(
    [
      {
        id: "cam-1",
        type: "patch",
        position: { x: 0, y: 0 },
        data: { defType: "source.media", params: defaultParams("source.media") },
      },
    ],
    [],
    1920,
    1080,
    {
      fps: 25,
      durationInFrames: 300,
      keyframes: {
        "cam-1:zoom": [
          { frame: 0, value: 1 },
          { frame: 100, value: 2 },
        ],
        "cam-1:file": [{ frame: 0, value: { name: "x.mp4", url: "blob:zzz" } }],
        "ghost-1:zoom": [{ frame: 0, value: 1 }],
      },
    },
  );
  const keyedTracks = Object.keys(keyed.timeline?.keyframes ?? {});
  check(
    "keyframes are saved, minus file params and dead nodes",
    keyedTracks.length === 1 && keyedTracks[0] === "cam-1:zoom",
    `tracks=${keyedTracks.join(",") || "none"}`,
  );

  const keyedRound = parsePatch(JSON.parse(JSON.stringify(keyed)));
  const restored = keyedRound?.timeline?.keyframes["cam-1:zoom"];
  check(
    "keyframes survive a save/load round trip",
    keyedRound?.timeline?.fps === 25 &&
      keyedRound.timeline.durationInFrames === 300 &&
      restored?.length === 2 &&
      restored[1]!.value === 2,
    `fps=${keyedRound?.timeline?.fps ?? "none"} duration=${keyedRound?.timeline?.durationInFrames ?? "none"} keys=${restored?.length ?? 0}`,
  );

  check(
    "a patch without a timeline still loads",
    parsePatch(JSON.parse(JSON.stringify(patch)))?.timeline === null,
    "timeline field absent → null",
  );

  // --- 6b. every builtin preset is wired to real, type-matching handles -----
  // A handle name that does not exist fails silently: the edge survives, the
  // input just never arrives. tsc cannot see any of this.
  const presetProblems: string[] = [];
  for (const preset of BUILTIN_PRESETS) {
    const built = preset.build();
    const typeById = new Map(built.nodes.map((node) => [node.id, node.type]));

    for (const node of built.nodes) {
      const def = NODE_DEFS[node.type];
      if (!def) {
        presetProblems.push(`${preset.id}: unknown node ${node.type}`);
        continue;
      }
      // A param key that does not exist is silent too: defaults fill in and the
      // value sits there doing nothing, so the preset quietly does not do what
      // it says. `mode` is the one legitimate extra — Media carries it.
      for (const key of Object.keys(node.params)) {
        if (key === "mode") continue;
        if (!def.params.some((spec) => spec.key === key)) {
          presetProblems.push(`${preset.id}: ${node.id} has no param "${key}"`);
        }
      }
    }

    for (const edge of built.edges) {
      const sourceDef = NODE_DEFS[typeById.get(edge.source) ?? ""];
      const targetDef = NODE_DEFS[typeById.get(edge.target) ?? ""];
      if (!sourceDef || !targetDef) {
        presetProblems.push(`${preset.id}: edge ${edge.id} references a missing node`);
        continue;
      }
      const outPort = sourceDef.outputs.find((port) => port.id === edge.sourceHandle);
      const inPort = targetDef.inputs.find((port) => port.id === edge.targetHandle);
      if (!outPort) {
        presetProblems.push(`${preset.id}: ${edge.source} has no output "${edge.sourceHandle}"`);
      } else if (!inPort) {
        presetProblems.push(`${preset.id}: ${edge.target} has no input "${edge.targetHandle}"`);
      } else if (outPort.type !== inPort.type) {
        presetProblems.push(
          `${preset.id}: ${edge.sourceHandle}(${outPort.type}) → ${edge.targetHandle}(${inPort.type})`,
        );
      }
    }

    if (!built.nodes.some((node) => NODE_DEFS[node.type]?.category === "output")) {
      presetProblems.push(`${preset.id}: no output node`);
    }
    if (!parsePatch(JSON.parse(JSON.stringify(built)))) {
      presetProblems.push(`${preset.id}: does not survive parsePatch`);
    }
  }
  check(
    "every builtin preset is wired correctly",
    presetProblems.length === 0,
    presetProblems.slice(0, 3).join(" | ") || `${BUILTIN_PRESETS.length} presets`,
  );

  // The presets that exist to demonstrate keyframes and modulators must
  // actually carry them, or they demonstrate nothing.
  const keyframeDemo = BUILTIN_PRESETS.find((p) => p.id === "keyframed-zoom")?.build();
  const modulatorDemo = BUILTIN_PRESETS.find((p) => p.id === "modulated-slice")?.build();
  const demoKeys = Object.keys(keyframeDemo?.timeline?.keyframes ?? {}).length;
  const demoMods = Object.keys(modulatorDemo?.modulators ?? {}).length;
  check(
    "demo presets carry their timeline and modulators",
    demoKeys > 0 && demoMods > 0,
    `keys=${demoKeys} modulators=${demoMods}`,
  );

  // --- 6c. waveform peaks ---------------------------------------------------
  // A synthetic buffer with a known envelope: silent first half, full-scale
  // sine second half. Peaks have to put the energy in the right columns.
  const rate = 8000;
  const seconds = 2;
  const fake = {
    numberOfChannels: 1,
    length: rate * seconds,
    duration: seconds,
    getChannelData: () => {
      const out = new Float32Array(rate * seconds);
      for (let i = out.length / 2; i < out.length; i += 1) {
        out[i] = Math.sin((i / rate) * Math.PI * 2 * 220);
      }
      return out;
    },
  } as unknown as AudioBuffer;

  const peaks = computePeaks(fake, 64);
  const firstHalfEnergy = Math.max(...Array.from(peaks.slice(0, 64)).map(Math.abs));
  const secondHalfEnergy = Math.max(...Array.from(peaks.slice(64)).map(Math.abs));
  check(
    "peaks follow the signal envelope",
    firstHalfEnergy < 0.01 && secondHalfEnergy > 0.9,
    `silent half=${firstHalfEnergy.toFixed(3)}, loud half=${secondHalfEnergy.toFixed(3)}`,
  );

  // Squeezing must keep the extremes — averaging them away is what flattens a
  // zoomed-out waveform into a grey bar.
  const squeezed = resamplePeaks(peaks, 8);
  const keptPeak = Math.max(...Array.from(squeezed).map(Math.abs));
  check(
    "resampling keeps transients",
    squeezed.length === 16 && keptPeak > 0.9,
    `columns=${squeezed.length / 2} peak=${keptPeak.toFixed(3)}`,
  );

  // --- 6c-bis. FFT band energy (audio modulator feed) -----------------------
  // Pure 440 Hz sine for 1 s — on-band high, off-band near silence, same call
  // twice must match (timeline / offline render lockstep).
  const toneRate = 44100;
  const toneLen = toneRate;
  const tone440 = {
    numberOfChannels: 1,
    length: toneLen,
    duration: 1,
    sampleRate: toneRate,
    getChannelData: () => {
      const out = new Float32Array(toneLen);
      for (let i = 0; i < toneLen; i += 1) {
        out[i] = Math.sin((i / toneRate) * Math.PI * 2 * 440);
      }
      return out;
    },
  } as unknown as AudioBuffer;
  const onBand = bandEnergy(tone440, 0.5, 400, 500);
  const onBandAgain = bandEnergy(tone440, 0.5, 400, 500);
  const offBand = bandEnergy(tone440, 0.5, 2000, 3000);
  const silentBand = bandEnergy(fake, 0.25, 200, 300);
  check(
    "FFT band energy peaks on the tone frequency",
    onBand > 0.5 && offBand < 0.15 && Math.abs(onBand - onBandAgain) < 1e-12,
    `on=${onBand.toFixed(3)} off=${offBand.toFixed(3)} silent@fake=${silentBand.toFixed(3)}`,
  );
  const drive = bandDrive(tone440, 0.5, 400, 500);
  check(
    "bandDrive maps energy into -1..1",
    drive > 0 && drive <= 1 && Math.abs(drive - (onBand * 2 - 1)) < 1e-12,
    `drive=${drive.toFixed(3)} from energy=${onBand.toFixed(3)}`,
  );

  // Media → band sample resolution used by useEngine.pushGraph.
  const picked = pickAudioMedia([
    { id: "img", params: { mode: "image", file: { name: "a.png", url: "test://a.png" } } },
    { id: "vid", params: { mode: "video", file: { name: "a.mp4", url: "test://a.mp4" } } },
    { id: "aud", params: { mode: "audio", file: { name: "a.wav", url: "test://tone440" } } },
  ]);
  check(
    "pickAudioMedia prefers audio mode over video",
    picked?.id === "aud",
    `got ${picked?.id ?? "null"}`,
  );
  check(
    "mediaPlayheadSec wraps by duration with speed",
    Math.abs(mediaPlayheadSec({ speed: 2 }, 3, 4) - 2) < 1e-9,
    `got ${mediaPlayheadSec({ speed: 2 }, 3, 4)}`,
  );
  primeAudioBuffer("test://tone440", tone440);
  const sampleMap = audioModulatorSamples(
    {
      "fx:amount": {
        ...DEFAULT_MODULATOR,
        source: "audio",
        bandLoHz: 400,
        bandHiHz: 500,
      },
    },
    [{ id: "aud", params: { mode: "audio", file: { name: "a.wav", url: "test://tone440" } } }],
    0.5,
  );
  const sample = sampleMap.get("fx:amount");
  check(
    "audioModulatorSamples drives from Media buffer at playhead",
    typeof sample === "number" && sample > 0,
    `sample=${sample}`,
  );

  // --- 6b-bis. node debug panels -------------------------------------------
  // The panel is built by the runtime from the ports it already has, so any
  // node gets one for free — and it must cost nothing while the toggle is off.
  engine.setGraph(
    [
      { id: "pts", type: "test.points", params: {} },
      {
        id: "dp",
        type: "draw.points",
        params: { ...defaultParams("draw.points") },
        debug: true,
      },
      { id: "out", type: "output.screen", params: { background: "#000000" } },
    ],
    [
      { id: "a", source: "pts", sourceHandle: "out", target: "dp", targetHandle: "points" },
      { id: "b", source: "dp", sourceHandle: "out", target: "out", targetHandle: "src" },
    ],
  );
  engine.tick();

  const debugStore = useNodeDebugStore.getState();
  const dpRows = debugStore.byId["dp"] ?? [];
  const rowFor = (label: string) => dpRows.find((row) => row.label === label)?.value ?? "";
  check(
    "debug panel summarises a node's ports",
    rowFor("in points") === "points ×3" &&
      rowFor("out out").startsWith("texture ") &&
      rowFor("status") !== "" &&
      rowFor("eval").endsWith("ms"),
    dpRows.map((r) => `${r.label}=${r.value}`).join(" · ") || "no rows",
  );
  check(
    "nodes without the toggle publish nothing",
    !("pts" in debugStore.byId) && !("out" in debugStore.byId),
    `panels for ${Object.keys(debugStore.byId).join(",") || "none"}`,
  );

  // --- 6b-ter. media memory -------------------------------------------------
  // Presets ship their own source type and file. Whatever is already open has
  // to outrank both, or trying a preset costs you the footage you dropped.
  const imageFile = { name: "shot.png", url: "test://image-a", mime: "image/png" };
  const videoFile = { name: "clip.mp4", url: "test://video-a", mime: "video/mp4" };
  const presetImage = { mode: "image", file: { name: "default-frame.png", url: "test://default" } };

  // Nothing opened yet: a preset must arrive exactly as authored.
  clearMediaMemory();
  check(
    "an untouched session gets the preset as authored",
    recallMediaParams(presetImage) === presetImage,
    "params passed through unchanged",
  );

  rememberMedia({ mode: "image", file: imageFile });
  const withImage = recallMediaParams(presetImage);
  check(
    "the last image beats the preset's own",
    withImage.mode === "image" && (withImage.file as typeof imageFile).url === imageFile.url,
    `mode=${String(withImage.mode)} file=${(withImage.file as { name?: string })?.name}`,
  );

  rememberMedia({ mode: "video", file: videoFile });
  const ontoImagePreset = recallMediaParams(presetImage);
  check(
    "an image preset loads as video when that is what is open",
    ontoImagePreset.mode === "video" &&
      (ontoImagePreset.file as typeof videoFile).url === videoFile.url,
    `mode=${String(ontoImagePreset.mode)} file=${(ontoImagePreset.file as { name?: string })?.name}`,
  );

  check(
    "each source type keeps its own file",
    rememberedFile("image")?.url === imageFile.url &&
      rememberedFile("video")?.url === videoFile.url &&
      rememberedFile("camera") === null,
    `image=${rememberedFile("image")?.name} video=${rememberedFile("video")?.name}`,
  );

  // Camera is remembered as a type but owns no file, so a preset switched to it
  // must not be left pointing at the image the preset shipped.
  rememberMedia({ mode: "camera" });
  const ontoCamera = recallMediaParams(presetImage);
  check(
    "switching to a type with no file clears the preset's",
    ontoCamera.mode === "camera" && ontoCamera.file === null,
    `mode=${String(ontoCamera.mode)} file=${JSON.stringify(ontoCamera.file)}`,
  );

  // --- 6c-bis. noise field --------------------------------------------------
  // Points Noise maps the field straight onto normalized coordinates, so a
  // value outside 0..1 would push points off the frame.
  let noiseMin = 1;
  let noiseMax = 0;
  for (let i = 0; i < 400; i += 1) {
    const v = fbm3(i * 0.37, i * 0.11, i * 0.03, 11, 3);
    noiseMin = Math.min(noiseMin, v);
    noiseMax = Math.max(noiseMax, v);
  }
  const repeat = fbm3(1.5, 2.5, 0.25, 11, 3);
  check(
    "fbm stays in 0..1 and is reproducible",
    noiseMin >= 0 &&
      noiseMax <= 1 &&
      noiseMax - noiseMin > 0.3 &&
      fbm3(1.5, 2.5, 0.25, 11, 3) === repeat,
    `range ${noiseMin.toFixed(3)}..${noiseMax.toFixed(3)}`,
  );

  // --- 6d. rectangle identity ----------------------------------------------
  // Granular keys a looping voice off the rectangle id, so "the same cell, one
  // frame later" must keep it — otherwise every frame retriggers every grain.
  const tracker = new RectTracker();
  const trackOptions = { minIou: 0.35, hold: 2 };
  const firstSeen = tracker.update(
    [
      { x: 0, y: 0, w: 0.4, h: 0.4 },
      { x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
    ],
    trackOptions,
  );
  const nudged = tracker.update(
    [
      { x: 0.01, y: 0.01, w: 0.4, h: 0.4 },
      { x: 0.52, y: 0.5, w: 0.4, h: 0.4 },
    ],
    trackOptions,
  );
  check(
    "moving rectangles keep their ids",
    nudged.length === 2 &&
      nudged[0]!.id === firstSeen[0]!.id &&
      nudged[1]!.id === firstSeen[1]!.id,
    `${firstSeen.map((r) => r.id).join(",")} → ${nudged.map((r) => r.id).join(",")}`,
  );

  const stayed = [{ x: 0.01, y: 0.01, w: 0.4, h: 0.4 }];
  const held = tracker.update(stayed, trackOptions);
  check(
    "a rectangle that blinks out is held, not dropped",
    held.length === 2 && held[1]!.id === firstSeen[1]!.id && held[1]!.missing === 1,
    `${held.length} tracked, missing=${held[1]?.missing}`,
  );

  tracker.update(stayed, trackOptions);
  const expired = tracker.update(stayed, trackOptions);
  check(
    "the hold expires after its frames run out",
    expired.length === 1,
    `${expired.length} tracked after 3 missed frames (hold=2)`,
  );

  const appeared = tracker.update(
    [{ x: 0.01, y: 0.01, w: 0.4, h: 0.4 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }],
    trackOptions,
  );
  check(
    "a genuinely new rectangle gets a fresh id",
    appeared.length === 2 && appeared[1]!.id > firstSeen[1]!.id,
    `new id ${appeared[1]?.id} vs previous max ${firstSeen[1]?.id}`,
  );

  // --- 6e. granular mapping -------------------------------------------------
  const cutoffMap = { sizeMin: 0.05, sizeMax: 0.6, cutoffLow: 300, cutoffHigh: 9000 };
  const tinyCut = cutoffForScale(rectScale(0.05, 0.05), cutoffMap);
  const midCut = cutoffForScale(rectScale(0.3, 0.3), cutoffMap);
  const hugeCut = cutoffForScale(rectScale(0.8, 0.8), cutoffMap);
  check(
    "smaller rectangles open the filter higher",
    tinyCut > midCut &&
      midCut > hugeCut &&
      Math.abs(tinyCut - 9000) < 1 &&
      Math.abs(hugeCut - 300) < 1,
    `${Math.round(tinyCut)} / ${Math.round(midCut)} / ${Math.round(hugeCut)} Hz`,
  );

  // The grain loops forever, so the seam has to be continuous in the source —
  // a step there is an audible click on every repeat. 137 Hz over a 0.2 s grain
  // does not land on a whole number of cycles, so a plain cut would show one.
  const grainCtx = new OfflineAudioContext(1, 8000, 8000);
  const tone = grainCtx.createBuffer(1, 8000, 8000);
  const toneData = tone.getChannelData(0);
  for (let i = 0; i < toneData.length; i += 1) {
    toneData[i] = Math.sin((i / 8000) * Math.PI * 2 * 137);
  }
  const grain = sliceLoop(grainCtx, tone, 0.1, 0.2, 0.02);
  const grainData = grain?.getChannelData(0) ?? new Float32Array(1);
  const seam = Math.abs(grainData[grainData.length - 1]! - grainData[0]!);
  const naiveSeam = Math.abs(toneData[800 + 1599]! - toneData[800]!);
  check(
    "a grain loops without a step at the seam",
    grain?.length === 1600 && seam < 0.15 && naiveSeam > 1,
    `crossfaded=${seam.toFixed(3)} vs plain cut=${naiveSeam.toFixed(3)}`,
  );

  // --- 7. modulators --------------------------------------------------------
  // Every shape has to stay inside -1..1, or depth stops meaning "fraction of
  // the half-range" and the clamp starts doing the shaping instead.
  let outOfRange = "";
  for (const { value: shape } of MODULATOR_SHAPES) {
    for (let i = 0; i <= 200; i += 1) {
      const v = waveAt(shape, i / 37);
      if (!(v >= -1.0001 && v <= 1.0001)) outOfRange = `${shape}=${v.toFixed(3)}`;
    }
  }
  check("every modulator shape stays in -1..1", outOfRange === "", outOfRange || "all shapes");

  const range: ParamSpec = {
    key: "k",
    label: "k",
    type: "range",
    min: 0,
    max: 100,
    step: 1,
    default: 50,
  };
  const mod = { ...DEFAULT_MODULATOR, shape: "sine" as const, rateHz: 1, depth: 0.5, phase: 0 };

  check(
    "depth 0 leaves the value untouched",
    modulatedValue(range, 42, { ...mod, depth: 0 }, 3.7) === 42,
    `got ${modulatedValue(range, 42, { ...mod, depth: 0 }, 3.7)}`,
  );

  // Sine at t=0 is 0, at a quarter cycle it is +1 → base + depth * half-range.
  const atZero = modulatedValue(range, 50, mod, 0);
  const atPeak = modulatedValue(range, 50, mod, 0.25);
  check(
    "modulation swings around the base value",
    Math.abs(atZero - 50) < 0.001 && Math.abs(atPeak - 75) < 0.001,
    `t=0 → ${atZero.toFixed(2)}, t=0.25 → ${atPeak.toFixed(2)} (expected 50 and 75)`,
  );

  const clamped = modulatedValue(range, 95, { ...mod, depth: 1 }, 0.25);
  check("modulation clamps to the parameter range", clamped === 100, `got ${clamped}`);

  // Audio source plugs a −1..1 sample where the LFO wave would go.
  const audioMod = { ...DEFAULT_MODULATOR, source: "audio" as const, depth: 0.5, bias: 0 };
  const audioPeak = modulatedValue(range, 50, audioMod, 0, 1);
  const audioTrough = modulatedValue(range, 50, audioMod, 0, -1);
  const audioMissing = modulatedValue(range, 50, audioMod, 0);
  check(
    "audio sample ±1 swings depth * half-range around base",
    Math.abs(audioPeak - 75) < 0.001 &&
      Math.abs(audioTrough - 25) < 0.001 &&
      Math.abs(audioMissing - 50) < 0.001,
    `+1→${audioPeak}, -1→${audioTrough}, missing→${audioMissing} (expected 75 / 25 / 50)`,
  );

  const modKeyed = new Map<string, Record<string, unknown>>([["n1", { k: 50 }]]);
  applyModulatorsToNodes(
    0,
    modKeyed,
    { "n1:k": audioMod },
    () => range,
    (path) => (path === "n1:k" ? 1 : undefined),
  );
  check(
    "applyModulatorsToNodes uses sampleAt for audio source",
    modKeyed.get("n1")!.k === 75,
    `got ${modKeyed.get("n1")!.k}`,
  );

  const parsedAudio = parseModulators(
    { "n1:k": { source: "audio", depth: 0.4, bandLoHz: 100, bandHiHz: 800 } },
    new Set(["n1"]),
  );
  check(
    "parseModulators keeps audio source and band edges",
    parsedAudio["n1:k"]?.source === "audio" &&
      parsedAudio["n1:k"]?.bandLoHz === 100 &&
      parsedAudio["n1:k"]?.bandHiHz === 800 &&
      parsedAudio["n1:k"]?.depth === 0.4,
    JSON.stringify(parsedAudio["n1:k"] ?? null),
  );

  const modPatch = serializePatch(
    [
      {
        id: "cam-1",
        type: "patch",
        position: { x: 0, y: 0 },
        data: { defType: "source.media", params: defaultParams("source.media") },
      },
    ],
    [],
    1920,
    1080,
    undefined,
    {
      "cam-1:zoom": { ...DEFAULT_MODULATOR, rateHz: 2, depth: 0.8 },
      "ghost-1:zoom": { ...DEFAULT_MODULATOR },
    },
  );
  const modRound = parsePatch(JSON.parse(JSON.stringify(modPatch)));
  const modPaths = Object.keys(modRound?.modulators ?? {});
  check(
    "modulators round-trip and drop dead nodes",
    modPaths.length === 1 &&
      modPaths[0] === "cam-1:zoom" &&
      modRound!.modulators["cam-1:zoom"]!.rateHz === 2 &&
      modRound!.modulators["cam-1:zoom"]!.source === "lfo",
    `paths=${modPaths.join(",") || "none"} source=${modRound!.modulators["cam-1:zoom"]?.source}`,
  );

  const audioPatch = serializePatch(
    [
      {
        id: "cam-1",
        type: "patch",
        position: { x: 0, y: 0 },
        data: { defType: "source.media", params: defaultParams("source.media") },
      },
    ],
    [],
    1920,
    1080,
    undefined,
    {
      "cam-1:zoom": {
        ...DEFAULT_MODULATOR,
        source: "audio",
        bandLoHz: 200,
        bandHiHz: 2000,
        depth: 0.7,
      },
    },
  );
  const audioRound = parsePatch(JSON.parse(JSON.stringify(audioPatch)));
  const audioModSaved = audioRound?.modulators["cam-1:zoom"];
  check(
    "audio modulator band persists in the patch",
    audioModSaved?.source === "audio" &&
      audioModSaved.bandLoHz === 200 &&
      audioModSaved.bandHiHz === 2000 &&
      audioModSaved.depth === 0.7,
    JSON.stringify(audioModSaved ?? null),
  );

  // --- 7b. Reel markers formula -------------------------------------------
  {
    const {
      computeReelCuts,
      zonesFromCuts,
      formatReelSeconds,
      moveCut,
      REEL_ANCHORS,
      REEL_ZONE_META,
    } = await import("./lib/reelMarkers");

    for (const anchor of REEL_ANCHORS) {
      const result = computeReelCuts(anchor.durationSec);
      const ok =
        result.warning === null &&
        anchor.cuts.every((cut, i) => Math.abs(result.cutsSec[i]! - cut) < 1e-6);
      check(
        `reel markers ${anchor.durationSec}s match table`,
        ok,
        `cuts=${JSON.stringify(result.cutsSec)} expected=${JSON.stringify(anchor.cuts)}`,
      );
    }

    const short = computeReelCuts(5);
    check(
      "reel markers <7s warn short and scale 7s formula",
      short.warning === "short" && short.cutsSec[0] > 0 && short.cutsSec[3] < 5,
      JSON.stringify(short),
    );
    const long = computeReelCuts(20);
    check(
      "reel markers >15s warn long and scale 15s formula",
      long.warning === "long" && Math.abs(long.cutsSec[2] - 12) < 0.05,
      JSON.stringify(long),
    );

    // Hook / FormWait are absolute, not proportional to the reel length.
    check(
      "hook ends at 1.0s and FormWait at 1.2s for every duration",
      [5, 7, 10, 15, 20].every((sec) => {
        const r = computeReelCuts(sec);
        return Math.abs(r.cutsSec[0] - 1) < 1e-6 && Math.abs(r.cutsSec[1] - 1.2) < 1e-6;
      }),
      JSON.stringify([computeReelCuts(7).cutsSec, computeReelCuts(20).cutsSec]),
    );

    const zones = zonesFromCuts([1, 1.2, 9, 12], 15);
    check(
      "reel zones cover 0..duration without gaps",
      zones.length === 5 &&
        zones[0]!.startSec === 0 &&
        zones[4]!.endSec === 15 &&
        zones.every((z, i) => i === 0 || z.startSec === zones[i - 1]!.endSec) &&
        zones[0]!.id === "hook" &&
        zones[1]!.id === "formwait" &&
        zones[4]!.id === "cta",
      JSON.stringify(zones.map((z) => [z.id, z.startSec, z.endSec])),
    );

    const moved = moveCut([1, 1.2, 9, 12], 2, 8, 15);
    check(
      "reel moveCut keeps ordered cuts",
      moved[0] < moved[1] &&
        moved[1] < moved[2] &&
        moved[2] < moved[3] &&
        moved[3] < 15 &&
        Math.abs(moved[2] - 8) < 1e-6,
      JSON.stringify(moved),
    );

    const { cutsFromUnknown } = await import("./lib/reelMarkers");
    const upgraded = cutsFromUnknown([3, 9, 12]);
    check(
      "legacy 3-cut patch upgrades to Hook/FormWait + old Dev/Climax",
      !!upgraded &&
        upgraded[0] === 1 &&
        upgraded[1] === 1.2 &&
        upgraded[2] === 9 &&
        upgraded[3] === 12 &&
        cutsFromUnknown([1, 2]) === null,
      JSON.stringify(upgraded),
    );

    check(
      "formatReelSeconds shows tenths when needed",
      formatReelSeconds(2.5) === "0:02.5" && formatReelSeconds(3) === "0:03",
      `${formatReelSeconds(2.5)} / ${formatReelSeconds(3)}`,
    );

    const { zoneAtSec } = await import("./lib/reelMarkers");
    check(
      "zoneAtSec maps cuts to Hook/FormWait/Dev/Climax/CTA",
      zoneAtSec([1, 1.2, 9, 12], 15, 0.5) === "hook" &&
        zoneAtSec([1, 1.2, 9, 12], 15, 1.1) === "formwait" &&
        zoneAtSec([1, 1.2, 9, 12], 15, 5) === "development" &&
        zoneAtSec([1, 1.2, 9, 12], 15, 10) === "climax" &&
        zoneAtSec([1, 1.2, 9, 12], 15, 14) === "cta",
      "ok",
    );

    const { parseDroneByZone, DEFAULT_DEVELOPMENT_BPM, DEFAULT_DRONE_BY_ZONE } = await import(
      "./lib/reelCueAudio"
    );
    const drones = parseDroneByZone({ hook: { freq: 300, gain: 0.1 } });
    check(
      "parseDroneByZone merges defaults",
      drones.hook.freq === 300 &&
        drones.development.freq > 0 &&
        drones.formwait.freq > 0 &&
        DEFAULT_DEVELOPMENT_BPM === 120,
      JSON.stringify(drones.hook),
    );
    check(
      "drone params clamp out-of-range voice fields",
      (() => {
        const clamped = parseDroneByZone({
          climax: {
            detune: 999,
            cutoff: 1,
            lfoRate: -3,
            lfoDepth: 5,
            subGain: 9,
            ratio: 99,
            fm: -1,
            crush: 4,
            glitch: 7,
          },
        }).climax;
        return (
          clamped.detune === 60 &&
          clamped.cutoff === 60 &&
          clamped.lfoRate === 0 &&
          clamped.lfoDepth === 1 &&
          clamped.subGain === 1 &&
          clamped.ratio === 8 &&
          clamped.fm === 0 &&
          clamped.crush === 1 &&
          clamped.glitch === 1
        );
      })(),
      "ok",
    );
    check(
      "each zone has its own drone character",
      new Set(
        REEL_ZONE_META.map((z) => {
          const d = DEFAULT_DRONE_BY_ZONE[z.id];
          return `${d.type}|${d.freq}|${d.cutoff}|${d.ratio}|${d.crush}|${d.glitch}`;
        }),
      ).size === REEL_ZONE_META.length,
      "ok",
    );
    check(
      "drone ratios stay inharmonic (no integer partials)",
      REEL_ZONE_META.every((z) => {
        const r = DEFAULT_DRONE_BY_ZONE[z.id].ratio;
        return Math.abs(r - Math.round(r)) > 0.02;
      }),
      REEL_ZONE_META.map((z) => DEFAULT_DRONE_BY_ZONE[z.id].ratio).join(","),
    );
    check(
      "every zone carries some digital texture",
      REEL_ZONE_META.every((z) => {
        const d = DEFAULT_DRONE_BY_ZONE[z.id];
        return d.crush + d.ring + d.fm + d.glitch + d.comb > 0.5;
      }),
      "ok",
    );
  }

  // --- 8. Media facing + recorder MIME ------------------------------------
  const mediaDefaults = defaultParams("source.media");
  check(
    "Media defaults include facing=user",
    mediaDefaults.facing === "user",
    `facing=${String(mediaDefaults.facing)}`,
  );
  const facingSpec = NODE_DEFS["source.media"]?.params.find((p) => p.key === "facing");
  const facingOptions =
    facingSpec && facingSpec.type === "select" ? facingSpec.options : [];
  check(
    "Media facing select lists front and back",
    facingSpec?.type === "select" &&
      facingOptions.some((o) => o.value === "user") &&
      facingOptions.some((o) => o.value === "environment"),
    JSON.stringify(facingOptions),
  );

  const { pickRecorderMimeType } = await import("./ui/useRecorder");
  const mime = pickRecorderMimeType();
  check(
    "pickRecorderMimeType returns a supported type or empty UA default",
    mime === null || typeof mime === "string",
    `mime=${mime === null ? "null" : JSON.stringify(mime)}`,
  );

  render();
}

function render(): void {
  const root = document.getElementById("root")!;
  const passed = results.filter((r) => r.pass).length;
  root.innerHTML = `
    <h1>visio selftest — ${passed}/${results.length}</h1>
    <ul>
      ${results
        .map(
          (r) =>
            `<li style="color:${r.pass ? "#7fe3c0" : "#ff5c7a"}">
               ${r.pass ? "PASS" : "FAIL"} · ${r.name} <em style="color:#8b93a7">${r.detail}</em>
             </li>`,
        )
        .join("")}
    </ul>`;
  (window as unknown as { __selftest: unknown }).__selftest = {
    passed,
    total: results.length,
    results,
  };
}

/**
 * Checks that can't run synchronously. They append to the same result list and
 * re-render, so the page ends up showing every check.
 */
async function asyncChecks(): Promise<void> {
  try {
    const started = performance.now();
    const mp = await loadTasksVision();
    check(
      "MediaPipe module loads on demand",
      typeof mp.PoseLandmarker === "function" && typeof mp.FilesetResolver === "function",
      `dynamic import in ${Math.round(performance.now() - started)} ms`,
    );
  } catch (error) {
    check(
      "MediaPipe module loads on demand",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  render();
}

void run()
  .catch((error: unknown) => {
    check("engine threw", false, error instanceof Error ? error.message : String(error));
    render();
  })
  // MediaPipe's check runs either way — a failure above should not hide it.
  .then(() => asyncChecks());
