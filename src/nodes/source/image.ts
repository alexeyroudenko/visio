import { copyTexture } from "../../engine/gl/quad";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { FrameValue } from "../../engine/types";
import { defineNode, paramBool, paramString } from "../defineNode";
import { fileParam } from "../shared/fileParam";
import { StageCanvas, type FitMode } from "../shared/stage";

interface ImageState {
  image: HTMLImageElement;
  stage: StageCanvas;
  texture: SourceTexture | null;
  loadedUrl: string | null;
  frameId: number;
  ready: boolean;
}

export const imageNode = defineNode<ImageState>({
  type: "source.image",
  label: "Image File",
  category: "source",
  description: "Still image (drop onto the graph or pick a file). Outputs texture + frame.",
  inputs: [],
  outputs: [
    { id: "out", label: "texture", type: "texture" },
    { id: "frame", label: "frame", type: "frame" },
  ],
  params: [
    { key: "file", label: "File", type: "file", accept: "image/*", default: null },
    { key: "mirror", label: "Mirror", type: "toggle", default: false },
    {
      key: "fit",
      label: "Fit",
      type: "select",
      options: [
        { value: "cover", label: "cover" },
        { value: "contain", label: "contain" },
        { value: "stretch", label: "stretch" },
      ],
      default: "cover",
    },
  ],
  createState() {
    const image = new Image();
    image.decoding = "async";
    return {
      image,
      stage: new StageCanvas(),
      texture: null,
      loadedUrl: null,
      frameId: 0,
      ready: false,
    };
  },
  disposeState(state) {
    state.image.removeAttribute("src");
    state.texture?.dispose();
  },
  evaluate({ ctx, nodeId, params, runtime }) {
    const state = runtime.state;
    if (!state.texture) state.texture = new SourceTexture(ctx.gl);

    const file = fileParam(params);
    if (file && file.url !== state.loadedUrl) {
      state.loadedUrl = file.url;
      state.ready = false;
      state.frameId = 0;
      ctx.report(nodeId, "loading", file.name);
      state.image.onload = () => {
        state.ready = true;
        state.frameId += 1;
        ctx.report(nodeId, "ready", file.name);
      };
      state.image.onerror = () => {
        state.ready = false;
        ctx.report(nodeId, "error", "failed to open image");
      };
      state.image.src = file.url;
    }

    const target = ctx.target(nodeId, "out");
    if (!state.loadedUrl) {
      if (runtime.status === "idle") ctx.report(nodeId, "idle", "drop an image file");
      return { out: target, frame: null };
    }

    if (!state.ready || state.image.naturalWidth === 0) {
      return { out: target, frame: null };
    }

    state.stage.draw(state.image, state.image.naturalWidth, state.image.naturalHeight, ctx.width, ctx.height, {
      mode: paramString(params, "fit", "cover") as FitMode,
      mirror: paramBool(params, "mirror", false),
    });
    state.texture.upload(state.stage.canvas, state.frameId);
    copyTexture(ctx.gl, state.texture.texture, target);

    const frame: FrameValue = {
      element: state.stage.canvas,
      width: ctx.width,
      height: ctx.height,
      timestampMs: ctx.timeMs,
      frameId: state.frameId,
    };
    return { out: target, frame };
  },
});
