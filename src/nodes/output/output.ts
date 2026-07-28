import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, isRenderTarget } from "../../engine/gl/rt";
import { hexToRgb } from "../../engine/gl/program";
import { defineNode, paramString } from "../defineNode";

const OUTPUT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform bool uHasTex;
uniform vec3 uBackground;
out vec4 fragColor;
void main() {
  vec4 texel = uHasTex ? texture(uTex, vUv) : vec4(0.0);
  // Flatten onto the backdrop so the recorded frame is never transparent.
  fragColor = vec4(texel.rgb + uBackground * (1.0 - texel.a), 1.0);
}`;

export const outputNode = defineNode<Record<string, never>>({
  type: "output.screen",
  label: "Output",
  category: "output",
  description: "Final frame: what you see in the preview and what gets recorded.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [{ key: "background", label: "Background", type: "color", default: "#000000" }],
  createState() {
    return {};
  },
  evaluate({ ctx, nodeId, inputs, params }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;

    const program = getProgram(gl, FULLSCREEN_VS, OUTPUT_FS);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    if (isRenderTarget(source)) bindTexture(gl, program, "uTex", source.texture, 0);
    gl.uniform1i(program.uniform("uHasTex"), isRenderTarget(source) ? 1 : 0);
    gl.uniform3fv(program.uniform("uBackground"), hexToRgb(paramString(params, "background", "#000000")));
    drawFullscreen(gl, program);

    return { out: target };
  },
});
