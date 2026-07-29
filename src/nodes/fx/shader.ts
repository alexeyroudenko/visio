import { hexToRgb, tryGetProgram, type Program } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { defineNode, paramNumber, paramString } from "../defineNode";

/**
 * Everything above the user's code. Writing the version pragma, precision and
 * uniform block by hand every time is noise, and getting one of them subtly
 * wrong is a confusing way to start.
 */
const PREAMBLE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform float uTime;
uniform float uFrame;
uniform vec3 uColor;
uniform float uK1;
uniform float uK2;
uniform float uK3;
uniform float uK4;
#line 1
`;

/** `#line 1` resets the counter, so reported lines already match the editor. */
const PREAMBLE_LINES = PREAMBLE.split("\n").length - 1;

const DEFAULT_SOURCE = `// vUv is 0..1 with v=0 at the top, like every target here.
// Knobs K1..K4 and Color are params — keyframe them like anything else.
void main() {
  vec2 uv = vUv;
  uv.x += sin(uv.y * 20.0 + uTime * 2.0) * 0.02 * uK1;

  vec4 texel = texture(uTex, uv);

  // Everything in the graph is premultiplied: tint the rgb, keep alpha.
  texel.rgb = mix(texel.rgb, uColor * texel.a, uK2);

  fragColor = texel;
}`;

interface ShaderState {
  /** Source the cached program was built from, so editing is what triggers a rebuild. */
  builtFrom: string | null;
  program: Program | null;
  error: string | null;
}

/**
 * The compiler counts lines from the start of what it was handed. `#line 1`
 * makes that the user's first line, but drivers differ on whether they honour
 * it, so a log pointing past the preamble gets folded back anyway.
 */
function rebaseErrorLines(log: string): string {
  return log.replace(/ERROR:\s*(\d+):(\d+)/g, (whole, file: string, line: string) => {
    const n = Number(line);
    if (!Number.isFinite(n) || n <= PREAMBLE_LINES) return whole;
    return `ERROR: ${file}:${n - PREAMBLE_LINES}`;
  });
}

export const shaderNode = defineNode<ShaderState>({
  type: "fx.shader",
  label: "Shader",
  category: "fx",
  description: "Your own fragment shader over the input texture.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "source", label: "Fragment shader", type: "code", rows: 16, default: DEFAULT_SOURCE },
    { key: "k1", label: "K1", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "k2", label: "K2", type: "range", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "k3", label: "K3", type: "range", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "k4", label: "K4", type: "range", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "color", label: "Color", type: "color", default: "#6b8afd" },
  ],
  createState() {
    return { builtFrom: null, program: null, error: null };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;
    if (!isRenderTarget(source)) {
      clearTarget(gl, target, 0, 0, 0, 0);
      return { out: target };
    }

    const state = runtime.state;
    const text = paramString(params, "source", DEFAULT_SOURCE);

    // Compile only when the text actually changed. A broken shader would
    // otherwise be recompiled every frame for as long as it stays broken.
    if (state.builtFrom !== text) {
      const built = tryGetProgram(gl, FULLSCREEN_VS, PREAMBLE + text);
      state.builtFrom = text;
      state.program = built.program;
      state.error = built.error ? rebaseErrorLines(built.error) : null;
      ctx.report(nodeId, state.error ? "error" : "ready", state.error);
    }

    // Nothing to draw with — pass the input through rather than blanking the
    // chain, so a typo does not black out everything downstream.
    if (!state.program) return { out: source };

    const program = state.program;
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    program.use();
    bindTexture(gl, program, "uTex", source.texture, 0);
    gl.uniform2f(program.uniform("uResolution"), target.width, target.height);
    gl.uniform1f(program.uniform("uTime"), ctx.timeMs / 1000);
    gl.uniform1f(program.uniform("uFrame"), ctx.frameCount);
    const [r, g, b] = hexToRgb(paramString(params, "color", "#6b8afd"));
    gl.uniform3f(program.uniform("uColor"), r, g, b);
    gl.uniform1f(program.uniform("uK1"), paramNumber(params, "k1", 0.5));
    gl.uniform1f(program.uniform("uK2"), paramNumber(params, "k2", 0));
    gl.uniform1f(program.uniform("uK3"), paramNumber(params, "k3", 0));
    gl.uniform1f(program.uniform("uK4"), paramNumber(params, "k4", 0));
    drawFullscreen(gl, program);

    return { out: target };
  },
});
