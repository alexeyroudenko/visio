# visio

Node environment in the browser: **image, video, or camera → tracking → WebGL graphics with feedback**. Drop an image/video onto the graph to create a source node.
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
| Sources | Camera, Image File, Video File |
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

`Use content edge` hugs the silhouette instead of the canvas: cells touching a
border are trimmed to the outermost content pixel in their own band. The mask
behind it is built at 480 px wide from the Media `frame` when one is wired up,
and otherwise from a readback of the background — either way it describes the
*background*, which changes far slower than the cells riding on it, so it is
cached and rebuilt on `Edge mask every N frames`. Trimming itself still runs
every frame; only the mask is throttled. At 1080×1920 that is 24 ms per frame
at 1, 8.9 ms at 4, 4.4 ms at 8.

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
- **Pixel Sort** — the only CPU one: span finding is sequential by nature. The sort is
  not, though. Luminance is the key, it rounds to a byte, and it does not change while
  a frame is being sorted — so it is computed once into a `Uint8Array` and each span is
  ordered by a stable counting sort with no comparisons at all. Pixels move as 32-bit
  words, and every buffer is preallocated, so a frame costs no allocations. That is
  roughly an order of magnitude off a comparator sort that recomputes luminance on
  every comparison.
  Sorted bytes go straight into the target texture with `texSubImage2D` — the 2D-canvas
  roundtrip the drawing nodes need would be three extra full-frame copies here.
  That leaves the readback. `readPixels` blocks until the GPU has drained every
  queued command, which measured 20 ms at 1080×1920 — about a third of the node.
  `Async readback` routes it through a pixel-pack buffer instead: a fence records
  when the GPU is done, and the pixels are pulled on a later frame once it has
  signalled, so nothing ever waits. Read time drops to 0.6 ms and the whole node
  from 64 to 51 ms. The catch is that what comes back is the frame the readback
  started on — the effect runs exactly one frame behind, which is why it is a
  toggle and not the default. (The fence needs an explicit `gl.flush()`, or it can
  sit unflushed in the client queue and never signal at all.)
  `Scale` sorts at a fraction of the resolution and upscales —
  cost falls quadratically and the effect stays live, unlike “every N frames”, which
  just freezes the result between runs. The node reports its own `read / sort / write`
  split in the status line.

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
- **Keyframes, fps and duration are part of the patch** — they save, export and
  reload with everything else. The playhead is not: it is where you are looking,
  not what the document says, and saving it would rewrite the patch every frame
  during playback. The `timeline` field is optional rather than a format bump, so
  patches written before keyframes existed still load. Keys on file params are
  dropped for the same reason the params are, and a deleted node takes its tracks
  with it.
- **Inspector follows the playhead.** An animated parameter shows its value at the
  current frame, because that is what the engine renders — a slider parked at its
  base value while the output moves is just a lie. The ◆ next to each control
  keys the current value (filled when a key sits exactly on the playhead, and
  clicking it again removes that key). Dragging a parameter that already has keys
  writes one whether or not ● Record is armed: its base value is overridden by the
  curve, so editing it any other way would appear to do nothing.
- **Output window** — double-click the Output node (or the button under the preview).
  Opens a separate window with the image: drag it to a projector or second screen;
  double-click inside for fullscreen. Uses `captureStream()`, so the WebGL context
  stays in the main window and nothing is rendered twice.
- **Recording** to webm — toolbar ● Record (realtime canvas capture).
- **Render** — toolbar Render: offline frame-by-frame timeline export (not realtime).
- **Right panel width** is dragged via the splitter between graph and preview;
  double-click resets it to 340 px. Width lives in localStorage separately from the
  patch — a workspace setting, not part of the document.

## Deploy

```bash
../deploy.sh visio ./dist --build "cd visio && npm run build"
```

Live: https://visio.aa.arthew0.online/  
(New subdomain needs LE expand: `certbot --cert-name aa.arthew0.online --expand -d … -d visio.aa.arthew0.online`.)

## What’s next

- Shader node with custom GLSL
- Particles driven by landmarks
- Modulators: LFO/audio → any numeric parameter
- Hough in a worker so heavy frames do not drop the main loop’s fps
