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
  PointsValue,
} from "./engine/types";
import { defineNode } from "./nodes/defineNode";
import { defaultParams, NODE_DEFS } from "./nodes/registry";
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

function run(): void {
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
  engine.setGraph(
    [
      { id: "grad", type: "test.gradient", params: { reverse: true } },
      {
        id: "fx",
        type: "fx.pixelSort",
        params: { ...defaultParams("fx.pixelSort"), thresh: 20, vert: false, interval: 1 },
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

try {
  run();
} catch (error) {
  check("engine threw", false, error instanceof Error ? error.message : String(error));
  render();
}

void asyncChecks();
