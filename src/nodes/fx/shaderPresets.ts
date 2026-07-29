/**
 * Ready-made sources for the Shader node. Each one is written against the
 * preamble that node prepends — `vUv`, `fragColor`, `uTex`, `uResolution`,
 * `uTime`, `uFrame`, `uColor`, `uK1`–`uK4` — so they drop straight into the
 * editor and stay editable afterwards. Nothing here is a hidden built-in.
 *
 * Every preset says which knob does what in its first lines, because K1–K4 are
 * the only names the uniform block can offer and they mean something different
 * in each effect.
 */
export interface ShaderPreset {
  id: string;
  label: string;
  /** One line for the button tooltip. */
  description: string;
  source: string;
}

const PIXELATE = `// K1 block size · K2 colour levels
// Position is snapped before sampling, so the blur is free — one fetch.
void main() {
  float blocks = mix(240.0, 8.0, uK1);
  vec2 grid = vec2(blocks, max(1.0, blocks * uResolution.y / uResolution.x));
  vec2 uv = (floor(vUv * grid) + 0.5) / grid;

  vec4 texel = texture(uTex, uv);
  if (uK2 > 0.0) {
    // Posterise unpremultiplied, or the steps land on colour × alpha.
    vec3 rgb = texel.a > 0.001 ? texel.rgb / texel.a : texel.rgb;
    float levels = mix(64.0, 2.0, uK2);
    rgb = floor(rgb * levels + 0.5) / levels;
    texel.rgb = rgb * texel.a;
  }
  fragColor = texel;
}`;

const SORT = `// K1 threshold · K2 span length · K3 > 0.5 vertical · K4 keep original
//
// An approximation of the Pixel Sort node, not a port of it. Sorting a span is
// sequential: knowing which pixel lands at a position needs every candidate's
// rank, which one fragment pass cannot gather, and a real GPU sort takes many
// bitonic passes. This gets the same shape in two bounded marches — find the
// run of above-threshold neighbours and its luminance range, work out which
// luminance would sit at this position if the run were sorted, then fetch the
// run pixel nearest to it. Spans come back as luminance ramps, which is the
// look; the exact ordering is the CPU node's job.
//
// Note what the window costs: the marches stop at K2 steps, so ordering is
// local. Texture inside a run gets pulled into ramps, but a long smooth
// gradient is already locally sorted and passes through nearly untouched — the
// CPU node, which sees the whole span, is the one that can reverse it.
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec4 here = texture(uTex, vUv);
  float thresh = uK1;
  if (luma(here.rgb) <= thresh) {
    fragColor = here;
    return;
  }

  int maxSteps = int(mix(4.0, 48.0, uK2));
  vec2 dir = uK3 > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 stride = dir / uResolution;

  // First march: how far the run reaches each way, and how bright it gets.
  float lo = luma(here.rgb);
  float hi = lo;
  int before = 0;
  int after = 0;
  for (int i = 1; i <= 48; i++) {
    if (i > maxSteps) break;
    float l = luma(texture(uTex, vUv - stride * float(i)).rgb);
    if (l <= thresh) break;
    lo = min(lo, l); hi = max(hi, l); before = i;
  }
  for (int i = 1; i <= 48; i++) {
    if (i > maxSteps) break;
    float l = luma(texture(uTex, vUv + stride * float(i)).rgb);
    if (l <= thresh) break;
    lo = min(lo, l); hi = max(hi, l); after = i;
  }

  float span = float(before + after);
  // A run of one, or a flat one, has nothing to reorder.
  if (span < 1.0 || hi - lo < 0.004) {
    fragColor = here;
    return;
  }

  // Position within the run decides which luminance belongs here.
  float target = mix(lo, hi, float(before) / span);

  // Second march: the run pixel closest to that luminance.
  vec4 best = here;
  float bestErr = abs(luma(here.rgb) - target);
  for (int i = 1; i <= 48; i++) {
    if (i > maxSteps) break;
    if (i <= before) {
      vec4 s = texture(uTex, vUv - stride * float(i));
      float e = abs(luma(s.rgb) - target);
      if (e < bestErr) { bestErr = e; best = s; }
    }
    if (i <= after) {
      vec4 s = texture(uTex, vUv + stride * float(i));
      float e = abs(luma(s.rgb) - target);
      if (e < bestErr) { bestErr = e; best = s; }
    }
  }

  fragColor = mix(best, here, uK4);
}`;

const RGB_SHIFT = `// K1 amount · K2 angle · K3 jitter over time
void main() {
  float angle = uK2 * 6.2831853;
  float jitter = uK3 * 0.5 * sin(uTime * 13.0 + vUv.y * 40.0);
  vec2 offset = vec2(cos(angle), sin(angle)) * (uK1 * 0.04 + jitter * 0.01);

  // Alpha stays put; only the colour planes separate.
  vec4 base = texture(uTex, vUv);
  fragColor = vec4(
    texture(uTex, vUv + offset).r,
    base.g,
    texture(uTex, vUv - offset).b,
    base.a
  );
}`;

const DITHER = `// K1 levels · K2 dither strength · K3 pixel scale
// Ordered 4x4 Bayer: the threshold varies per pixel, so banding turns into a
// stable pattern instead of the crawling noise a random threshold gives.
const float BAYER[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0
);

void main() {
  float scale = mix(1.0, 6.0, uK3);
  vec2 cell = floor(gl_FragCoord.xy / scale);
  int index = int(mod(cell.x, 4.0)) + int(mod(cell.y, 4.0)) * 4;
  float threshold = (BAYER[index] + 0.5) / 16.0 - 0.5;

  vec4 texel = texture(uTex, vUv);
  vec3 rgb = texel.a > 0.001 ? texel.rgb / texel.a : texel.rgb;

  float levels = max(2.0, floor(mix(16.0, 2.0, uK1)));
  rgb = floor(rgb * levels + threshold * uK2 * 2.0 + 0.5) / levels;
  rgb = clamp(rgb, 0.0, 1.0);

  fragColor = vec4(rgb * texel.a, texel.a);
}`;

const EDGES = `// K1 gain · K2 fade the source · K3 thickness
// Sobel on luma, drawn in Color over whatever is left of the original.
float luma(vec2 uv) {
  vec3 c = texture(uTex, uv).rgb;
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 px = mix(1.0, 3.0, uK3) / uResolution;

  float tl = luma(vUv + px * vec2(-1.0, -1.0));
  float tc = luma(vUv + px * vec2( 0.0, -1.0));
  float tr = luma(vUv + px * vec2( 1.0, -1.0));
  float ml = luma(vUv + px * vec2(-1.0,  0.0));
  float mr = luma(vUv + px * vec2( 1.0,  0.0));
  float bl = luma(vUv + px * vec2(-1.0,  1.0));
  float bc = luma(vUv + px * vec2( 0.0,  1.0));
  float br = luma(vUv + px * vec2( 1.0,  1.0));

  float gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  float edge = clamp(length(vec2(gx, gy)) * mix(0.5, 6.0, uK1), 0.0, 1.0);

  vec4 texel = texture(uTex, vUv);
  vec3 rgb = mix(texel.rgb * (1.0 - uK2), uColor * texel.a, edge);
  fragColor = vec4(rgb, texel.a);
}`;

const KALEIDOSCOPE = `// K1 segments · K2 zoom · K3 spin
void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 c = vUv - 0.5;
  c.x *= aspect;

  float radius = length(c);
  float angle = atan(c.y, c.x) + uTime * uK3;

  // Fold the circle into one wedge, then mirror it so edges meet.
  float segments = max(2.0, floor(mix(2.0, 16.0, uK1)));
  float wedge = 6.2831853 / segments;
  angle = abs(mod(angle, wedge) - wedge * 0.5);

  vec2 p = vec2(cos(angle), sin(angle)) * radius * mix(1.6, 0.6, uK2);
  p.x /= aspect;
  fragColor = texture(uTex, clamp(p + 0.5, 0.0, 1.0));
}`;

export const SHADER_PRESETS: ShaderPreset[] = [
  {
    id: "pixelate",
    label: "Pixelate",
    description: "Blocky downsample with optional colour posterisation.",
    source: PIXELATE,
  },
  {
    id: "sort",
    label: "Pixel Sort (GPU)",
    description:
      "Ramps each above-threshold run by luminance. Approximation — the CPU node does the real sort.",
    source: SORT,
  },
  {
    id: "rgbShift",
    label: "RGB Shift",
    description: "Chromatic separation with an angle and time jitter.",
    source: RGB_SHIFT,
  },
  {
    id: "dither",
    label: "Dither",
    description: "Ordered 4×4 Bayer dithering down to a few colour levels.",
    source: DITHER,
  },
  {
    id: "edges",
    label: "Edges",
    description: "Sobel outlines drawn in Color over a faded source.",
    source: EDGES,
  },
  {
    id: "kaleidoscope",
    label: "Kaleidoscope",
    description: "Radial mirror fold with zoom and spin.",
    source: KALEIDOSCOPE,
  },
];
