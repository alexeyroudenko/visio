# visio

Node environment in the browser: **camera or video → tracking → WebGL graphics with feedback**.
A simplified cables.gl for one job — visualizing tracking data in real time.

```bash
npm install
npm run dev
```

Render-core self-test: <http://localhost:5173/selftest.html> (37 checks — draw
coordinates, rings, detection style, grid and its effect, glitch effects, feedback
decay, blending, Hough detectors on a synthetic frame, patch serialization,
lazy MediaPipe import). Dev-only page: it is not built into `dist`.

> Test gradients are drawn column-by-column, not via `createLinearGradient`:
> Chrome dithers gradients, so identical rows stop matching byte-for-byte and
> exact comparisons fail falsely.

## How it works

```
src/
  engine/          engine: knows nothing about React
    types.ts       port types and node contract
    graph.ts       topo-sort (delayedInputs break cycles)
    runtime.ts     WebGL2 context, one graph pass per frame
    gl/            RT (texture+FBO), shader cache, fullscreen passes,
                   instanced vector renderer (points/segments)
  nodes/           node definitions by category
  ui/              React Flow editor, inspector, preview, recording
  store/           zustand: graph, params, statuses
```

The engine is imperative and fully separate from the UI: React hands it a graph
description; once per frame it walks nodes in topological order and writes
results into textures.

### Conventions everything rests on

- **Orientation.** On every render target `v=0` is the top of the frame (as in canvas).
  The vector shader writes y without flipping; the flip happens once when presenting to the screen.
- **Normalized coordinates.** The source draws the frame onto a “stage canvas” already
  with fit and mirror, and the tracker gets **the same canvas**. So landmarks in `[0..1]`
  land on the output texture one-to-one — draw nodes do no remapping.
- **Premultiplied alpha.** Draw nodes write premultiplied, so `over` is simply
  `src + dst*(1-src.a)`.
- **State lives in the node.** Models, cameras, and accumulators survive graph edits:
  `setGraph` diffs by id and type and only recreates what changed.
- **MediaPipe loads on demand.** `@mediapipe/tasks-vision` is a separate chunk
  (137 kB / 41 kB gzip), pulled in via dynamic import on first task creation.
  A patch of CPU-only detectors never touches it. That is why connection tables
  (`POSE_CONNECTIONS` and the rest) are filled lazily inside `create()` — they used
  to be read at module top level and dragged the whole package into the main bundle.

## Nodes

| Category | Nodes |
|---|---|
| Sources | Camera, Video File |
| Tracking | Pose (33 points), Hands, Face Mesh, Objects (EfficientDet), Corners (Shi–Tomasi), **Hough Circles**, **Hough Lines** |
| Draw | Draw Skeleton, Draw Points, Draw Boxes, Draw Circles, Draw Lines, **Features Grid** |
| FX | Feedback, Blend, Color, **Slice Shift**, **Block Scatter**, **Pixel Sort** |
| Output | Output |

Ports are typed (`frame`, `texture`, `landmarks`, `points`, `boxes`, `circles`,
`lines`) — the editor will not connect incompatible ones.

CPU detectors (Corners, Hough) share one `GrayFrame`: downscale, grayscale, and
Sobel run once per node, with no allocations per frame. Each has an
“every N frames” throttle — Hough is expensive; every 2–3 frames it is barely noticeable.

**Draw Points** supports three styles, like tracking layers in cv-reels:
`point` · `ring (detection)` — a ring with radius from score between min/max plus a
center dot · `cross`. Plus a “web” of links between nearby points.

**Features Grid** — Mondrian grid from cv-reels: the frame is recursively split in half
at the median point (guillotine k-d split); leaves are outlined and labeled.
Frames and labels are built on a 2D canvas and uploaded as a texture (premultiplied,
blended on top) — text has no cheap WebGL equivalent. Everything else is GPU.

`Effect cell fraction` + `Effect seed` enable smear from the original: for cells
picked by a seeded LCG, a 1 px-wide column from the center is stretched across the
whole cell. Each such cell is a separate pass with `gl.viewport` set to its
rectangle, so the shader does not iterate cells per pixel.

### Glitch effects (port from [glitcher](../glitcher))

The original works with `ImageData` on the CPU. Two of three effects map to the GPU
without losing precision; only one stays on the CPU — by the nature of the problem:

- **Slice Shift** — shader + per-row shift table (`R32F`, h×1). The original applies
  bands in sequence to an untouched copy, so a row under two bands keeps the last
  one’s shift — “one shift per row” is an exact model, not a simplification. Shifts
  are rounded to whole pixels: a fractional shift would make the linear sampler blend
  neighbors instead of rotating the row cleanly.
- **Block Scatter** — instanced textured quads. In the original, blocks are copied from
  an untouched frame snapshot, which matches sampling the input texture. Tint
  (`overlay` + alpha) is computed in the shader.
- **Pixel Sort** — the only CPU one: span finding and luminance sort are sequential by
  nature. It costs a full-frame `readPixels`, so the node has “every N frames” —
  on skipped frames the target simply keeps the previous result.

Seeds match glitcher (mulberry32 with the same offset), so the same seed yields the
same layout. Block Scatter adds `Jitter` — at zero the scatter is static like the
original; above zero the seed is re-rolled over time.

**Feedback** keeps its accumulator inside (ping-pong of two FBOs), so trails do not
need a cycle in the graph. For real cycles a node can declare `delayedInputs` —
those edges are excluded from topo-sort.

## Patches and output

- **Autosave** to localStorage on every edit (400 ms debounce).
  Export/import JSON via toolbar buttons; “Reset” restores the starter patch.
  Video files are not saved: their `blob:` URLs die with the tab, so the patch
  loads with all connections, but you must pick the file again.
- **Output window** — double-click the Output node (or the button under the preview).
  Opens a separate window with the image: drag it to a projector or second screen;
  double-click inside for fullscreen. Uses `captureStream()`, so the WebGL context
  stays in the main window and nothing is rendered twice.
- **Recording** to webm — toolbar button; writes exactly what is on the output.
- **Right panel width** is dragged via the splitter between graph and preview;
  double-click resets it to 340 px. Width lives in localStorage separately from the
  patch — a workspace setting, not part of the document.

## Deploy

```bash
../deploy.sh visio ./dist --build "cd visio && npm run build"
```

## What’s next

- Shader node with custom GLSL
- Particles driven by landmarks
- Modulators: LFO/audio → any numeric parameter
- Hough in a worker so heavy frames do not drop the main loop’s fps
