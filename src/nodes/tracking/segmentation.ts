import type { ImageSegmenter, ImageSegmenterResult } from "@mediapipe/tasks-vision";
import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, type RenderTarget } from "../../engine/gl/rt";
import type { EngineContext, FrameValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { paramsKey } from "../shared/paramsKey";
import { loadTasksVision, loadVisionFileset, Monotonic } from "./mediapipeShared";

/**
 * MediaPipe Image Segmenter as a mask generator: the picked class comes out
 * white, everything else black.
 *
 * Each model carries its own label list, and the confidence masks come back in
 * that order — so the category is picked by *name* and resolved against
 * `getLabels()` at runtime rather than against a table of indices that would
 * quietly rot. The four models disagree about names for the same thing (the
 * selfie model calls a person "selfie", DeepLab calls it "person"), which is
 * what the alias lists below are for.
 */

const MODELS: Record<string, string> = {
  selfie:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite",
  multiclass:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
  hair: "https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/1/hair_segmenter.tflite",
  deeplab:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite",
};

/** Param value → the label names that mean it, in the order to try. */
export const CATEGORY_ALIASES: Record<string, string[]> = {
  person: ["person", "selfie"],
  hair: ["hair"],
  "body-skin": ["body-skin"],
  "face-skin": ["face-skin"],
  clothes: ["clothes"],
  others: ["others"],
  background: ["background"],
  aeroplane: ["aeroplane"],
  bicycle: ["bicycle"],
  bird: ["bird"],
  boat: ["boat"],
  bottle: ["bottle"],
  bus: ["bus"],
  car: ["car"],
  cat: ["cat"],
  chair: ["chair"],
  cow: ["cow"],
  "dining-table": ["dining table"],
  dog: ["dog"],
  horse: ["horse"],
  motorbike: ["motorbike"],
  "potted-plant": ["potted plant"],
  sheep: ["sheep"],
  sofa: ["sofa"],
  train: ["train"],
  tv: ["tv"],
};

const CATEGORY_OPTIONS = [
  { value: "person", label: "person" },
  { value: "hair", label: "hair" },
  { value: "body-skin", label: "body skin" },
  { value: "face-skin", label: "face skin" },
  { value: "clothes", label: "clothes" },
  { value: "others", label: "accessories" },
  { value: "background", label: "background" },
  { value: "cat", label: "cat" },
  { value: "dog", label: "dog" },
  { value: "car", label: "car" },
  { value: "bus", label: "bus" },
  { value: "bicycle", label: "bicycle" },
  { value: "motorbike", label: "motorbike" },
  { value: "aeroplane", label: "aeroplane" },
  { value: "train", label: "train" },
  { value: "boat", label: "boat" },
  { value: "bird", label: "bird" },
  { value: "cow", label: "cow" },
  { value: "horse", label: "horse" },
  { value: "sheep", label: "sheep" },
  { value: "bottle", label: "bottle" },
  { value: "chair", label: "chair" },
  { value: "sofa", label: "sofa" },
  { value: "dining-table", label: "dining table" },
  { value: "potted-plant", label: "potted plant" },
  { value: "tv", label: "tv" },
];

/** Which confidence mask holds this category, or -1 if the model has no such class. */
export function resolveMaskIndex(labels: readonly string[], category: string): number {
  const aliases = CATEGORY_ALIASES[category] ?? [category];
  for (const alias of aliases) {
    const index = labels.findIndex((label) => label.toLowerCase() === alias);
    if (index >= 0) return index;
  }
  return -1;
}

const MASK_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uMask;
uniform float uThreshold;
uniform float uSoft;
uniform bool uInvert;
out vec4 fragColor;
void main() {
  float m = texture(uMask, vUv).r;
  // Never a zero-width step: at Soft 0 the edge still gets the one texel the
  // upscale gives it, instead of aliasing into a staircase.
  float edge = max(uSoft, 0.002);
  m = smoothstep(uThreshold - edge, uThreshold + edge, m);
  fragColor = vec4(vec3(uInvert ? 1.0 - m : m), 1.0);
}`;

/** A single-channel texture holding the last mask, plus the buffer that fills it. */
export interface MaskUpload {
  texture: WebGLTexture | null;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export function createMaskUpload(): MaskUpload {
  return { texture: null, width: 0, height: 0, bytes: new Uint8Array(0) };
}

export function disposeMaskUpload(gl: WebGL2RenderingContext, upload: MaskUpload): void {
  if (upload.texture) gl.deleteTexture(upload.texture);
  upload.texture = null;
  upload.width = 0;
  upload.height = 0;
}

/** Confidence values (0..1) into the R8 texture the mask pass samples. */
export function uploadMask(
  gl: WebGL2RenderingContext,
  upload: MaskUpload,
  values: Float32Array,
  width: number,
  height: number,
): void {
  const count = Math.min(values.length, width * height);
  if (upload.bytes.length !== width * height) upload.bytes = new Uint8Array(width * height);
  const bytes = upload.bytes;
  for (let i = 0; i < count; i += 1) {
    const v = values[i]!;
    bytes[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }

  if (!upload.texture) {
    upload.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, upload.texture);
    // Linear: the mask is computed small and stretched over the whole frame.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    upload.width = 0;
    upload.height = 0;
  }

  gl.bindTexture(gl.TEXTURE_2D, upload.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (upload.width !== width || upload.height !== height) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    upload.width = width;
    upload.height = height;
  } else {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }
}

/** Stretches the mask over the frame and turns it into black and white. */
export function drawMask(
  ctx: EngineContext,
  nodeId: string,
  upload: MaskUpload,
  opts: { threshold: number; soft: number; invert: boolean },
): RenderTarget {
  const gl = ctx.gl;
  const target = ctx.target(nodeId, "out");
  if (!upload.texture) {
    // Nothing segmented yet — an opaque black mask, not a transparent hole.
    clearTarget(gl, target, opts.invert ? 1 : 0, opts.invert ? 1 : 0, opts.invert ? 1 : 0, 1);
    return target;
  }
  const program = getProgram(gl, FULLSCREEN_VS, MASK_FS);
  bindTarget(gl, target);
  gl.disable(gl.BLEND);
  program.use();
  bindTexture(gl, program, "uMask", upload.texture, 0);
  gl.uniform1f(program.uniform("uThreshold"), opts.threshold);
  gl.uniform1f(program.uniform("uSoft"), opts.soft);
  gl.uniform1i(program.uniform("uInvert"), opts.invert ? 1 : 0);
  drawFullscreen(gl, program);
  return target;
}

interface SegmentState {
  instance: ImageSegmenter | null;
  loading: boolean;
  failed: boolean;
  clock: Monotonic;
  lastFrameId: number;
  /** Which model file is loaded — a change tears the task down. */
  loadedModelKey: string | null;
  paramsFingerprint: string;
  labels: string[];
  scratch: HTMLCanvasElement;
  upload: MaskUpload;
  /** Label the mask currently comes from, for the status line. */
  activeLabel: string | null;
}

export const segmentationNode = defineNode<SegmentState>({
  type: "tracking.segment",
  label: "Segmentation",
  category: "tracking",
  description:
    "MediaPipe Image Segmenter: the picked class comes out white, everything else black.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [{ id: "out", label: "mask", type: "texture" }],
  params: [
    {
      key: "model",
      label: "Model",
      type: "select",
      options: [
        { value: "selfie", label: "selfie (person)" },
        { value: "multiclass", label: "selfie multiclass" },
        { value: "hair", label: "hair" },
        { value: "deeplab", label: "DeepLab v3 (20 things)" },
      ],
      default: "selfie",
    },
    { key: "category", label: "Class", type: "select", options: CATEGORY_OPTIONS, default: "person" },
    {
      key: "size",
      label: "Mask size",
      type: "select",
      options: [
        { value: "128", label: "128" },
        { value: "256", label: "256" },
        { value: "384", label: "384" },
      ],
      default: "256",
    },
    { key: "threshold", label: "Threshold", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "soft", label: "Soft edge", type: "range", min: 0, max: 0.5, step: 0.01, default: 0.05 },
    { key: "invert", label: "Invert", type: "toggle", default: false },
    { key: "interval", label: "Every N frames", type: "range", min: 1, max: 8, step: 1, default: 2 },
  ],
  createState() {
    return {
      instance: null,
      loading: false,
      failed: false,
      clock: new Monotonic(),
      lastFrameId: -1,
      loadedModelKey: null,
      paramsFingerprint: "",
      labels: [],
      scratch: document.createElement("canvas"),
      upload: createMaskUpload(),
      activeLabel: null,
    };
  },
  disposeState(state, ctx) {
    state.instance?.close();
    state.instance = null;
    disposeMaskUpload(ctx.gl, state.upload);
  },
  evaluate({ ctx, nodeId, inputs, params, runtime, debug }) {
    const state = runtime.state;
    const frame = inputs.frame as FrameValue | null;
    const threshold = paramNumber(params, "threshold", 0.5);
    const soft = paramNumber(params, "soft", 0.05);
    const invert = paramBool(params, "invert", false);
    const maskOpts = { threshold, soft, invert };

    if (!frame) {
      if (!state.failed) ctx.report(nodeId, "idle", "connect a frame from a source");
      disposeMaskUpload(ctx.gl, state.upload);
      return { out: drawMask(ctx, nodeId, state.upload, maskOpts) };
    }

    const fingerprint = paramsKey(params);
    if (fingerprint !== state.paramsFingerprint) {
      state.paramsFingerprint = fingerprint;
      // A still keeps its frameId, so a class change has to force a re-segment.
      state.lastFrameId = -1;
    }

    const modelKey = paramString(params, "model", "selfie");
    if (state.instance && state.loadedModelKey !== modelKey) {
      state.instance.close();
      state.instance = null;
      state.loadedModelKey = null;
      state.labels = [];
      state.failed = false;
    }

    if (!state.instance && !state.loading && !state.failed) {
      state.loading = true;
      ctx.report(nodeId, "loading", "loading model…");
      void Promise.all([loadVisionFileset(), loadTasksVision()])
        .then(([fileset, mp]) =>
          mp.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODELS[modelKey] ?? MODELS.selfie, delegate: "GPU" },
            runningMode: "VIDEO",
            // Confidence masks only: they come one per label, in label order,
            // and their soft edges are the point of a mask.
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          }),
        )
        .then((instance) => {
          state.instance = instance;
          state.loadedModelKey = modelKey;
          state.labels = instance.getLabels();
          state.loading = false;
          state.lastFrameId = -1;
          ctx.report(nodeId, "ready", null);
        })
        .catch((error: unknown) => {
          state.loading = false;
          state.failed = true;
          ctx.report(nodeId, "error", error instanceof Error ? error.message : "model error");
        });
    }

    const instance = state.instance;
    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 2)));
    const isNewFrame = frame.frameId !== state.lastFrameId;
    const dueThisTick = state.lastFrameId < 0 || ctx.frameCount % interval === 0;

    if (instance && isNewFrame && dueThisTick) {
      state.lastFrameId = frame.frameId;
      const category = paramString(params, "category", "person");
      const index = resolveMaskIndex(state.labels, category);
      if (index < 0) {
        // Every model has its own vocabulary; say which one this one speaks.
        ctx.report(nodeId, "error", `no “${category}” in ${modelKey}: ${state.labels.join(", ")}`);
        disposeMaskUpload(ctx.gl, state.upload);
        state.activeLabel = null;
      } else {
        try {
          const long = Number(paramString(params, "size", "256")) || 256;
          const scale = long / Math.max(1, Math.max(frame.width, frame.height));
          const width = Math.max(1, Math.round(frame.width * scale));
          const height = Math.max(1, Math.round(frame.height * scale));
          if (state.scratch.width !== width || state.scratch.height !== height) {
            state.scratch.width = width;
            state.scratch.height = height;
          }
          // The frame is already composed at patch resolution, so a plain
          // uniform downscale keeps the mask aligned with what is on screen.
          const canvas2d = state.scratch.getContext("2d");
          canvas2d?.drawImage(frame.element, 0, 0, width, height);

          const result = instance.segmentForVideo(
            state.scratch,
            state.clock.next(frame.timestampMs),
          ) as ImageSegmenterResult;
          const mask = result.confidenceMasks?.[index];
          if (mask) {
            uploadMask(ctx.gl, state.upload, mask.getAsFloat32Array(), mask.width, mask.height);
            state.activeLabel = state.labels[index] ?? null;
            ctx.report(nodeId, "ready", state.activeLabel);
          }
          result.close();
        } catch (error) {
          ctx.report(nodeId, "error", error instanceof Error ? error.message : "segment failed");
        }
      }
    }

    if (debug) {
      ctx.debugRows(nodeId, [
        { label: "class", value: state.activeLabel ?? "—" },
        { label: "labels", value: state.labels.join(", ") || "—" },
        {
          label: "mask",
          value: state.upload.width ? `${state.upload.width}×${state.upload.height}` : "—",
        },
      ]);
    }

    return { out: drawMask(ctx, nodeId, state.upload, maskOpts) };
  },
});
