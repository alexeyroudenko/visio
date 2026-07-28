import { copyTexture } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget, type RenderTarget } from "../../engine/gl/rt";
import type { EngineContext, ParamSpec, PortValue } from "../../engine/types";

/**
 * Every draw node starts the same way: take its own target, lay the incoming
 * background under the drawing (or clear to transparent), leave it bound.
 */
export function beginDraw(
  ctx: EngineContext,
  nodeId: string,
  background: PortValue,
): RenderTarget {
  const target = ctx.target(nodeId, "out");
  if (isRenderTarget(background)) {
    copyTexture(ctx.gl, background.texture, target);
  } else {
    clearTarget(ctx.gl, target, 0, 0, 0, 0);
  }
  bindTarget(ctx.gl, target);
  return target;
}

export const BLEND_PARAM: ParamSpec = {
  key: "blend",
  label: "Blend",
  type: "select",
  options: [
    { value: "normal", label: "normal" },
    { value: "add", label: "add" },
  ],
  default: "normal",
};
