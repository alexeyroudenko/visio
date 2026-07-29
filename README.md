# visio

Node environment in the browser: **image, video, or camera → tracking → WebGL graphics with feedback**. Drop an image/video onto the graph to create a source node.
A simplified cables.gl for one job — visualizing tracking data in real time.

```bash
npm install
npm run dev
```

Render-core self-test: [http://localhost:5173/selftest.html](http://localhost:5173/selftest.html) (37 checks — draw
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

The engine is imperative and fully separate from 

the UI: React hands it a graph
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


| Category | Nodes                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Sources  | Media (camera · image · video · audio)                                                                                           |
| Tracking | Pose (33 points), Hands, Face Mesh, Objects (EfficientDet), Corners (Shi–Tomasi), Hough Circles, Hough Lines, Landmarks → Points, **Points Noise** |
| Draw     | Draw Skeleton, Draw Points, Draw Boxes, Draw Circles, Draw Lines, Features Grid, Connectors, Quadtree, **Particles**             |
| FX       | Feedback, Blend, Color, Zoom, Slice Shift, Block Scatter, Pixel Sort, **Shader**                                                 |
| Audio    | **Granular**                                                                                                                     |
| Output   | Output                                                                                                                           |


Ports are typed (`frame`, `texture`, `landmarks`, `points`, `boxes`, `circles`,
`lines`, `audio`) — the editor will not connect incompatible ones.

CPU detectors (Corners, Hough) share one `GrayFrame`: downscale, grayscale, and
Sobel run once per node, with no allocations per frame. Each has an
“every N frames” throttle — Hough is expensive; every 2–3 frames it is barely noticeable.

**Hough runs in a worker** (`Run in worker`, on by default). The split follows what
can actually move: reading the frame and downscaling it needs a canvas and stays on
the main thread, while turning gradients into edges and edges into shapes is pure
arithmetic and goes to `hough.worker.ts`. On a busy 1080×1920 frame at downscale 2
that takes the per-tick main-thread cost from 139 ms to 0.1 ms — the remaining
spikes are the frame read and Sobel, which cannot leave.

One job per node is in flight at a time; queueing more would only build a backlog
of stale frames. Results therefore arrive a frame or two late and the node keeps
showing the previous ones, which is the same deal as the throttle. The gradients
are copied before being posted, because `GrayFrame` reuses its arrays and posting
transfers ownership. Turning the toggle off runs the identical functions inline.

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

The **`rects` output** hands the same leaf cells on as normalized `boxes`, which
is what drives Granular (and plugs into Draw Boxes unchanged). The grid is rebuilt
from scratch every frame, so identity is reconstructed: `rectTracker.ts` matches
this frame's cells against the last by intersection-over-union (`Rect match`) and
carries the id over. `Rect hold` keeps a cell that blinked out reporting its last
box for a few frames — without it a single dropped tracking point would retrigger
every grain hanging off the grid.

**Points Noise** — noise displacement for a point cloud, from either end. Wire
`points` in and it shakes those (landmarks, corners), sampling a 3D value-noise
field at each point's own position so neighbours move together instead of
scattering; wire nothing and it generates the cloud itself from a fixed home per
point (random / grid / ring), which is enough to build and tune a patch before a
tracker is in it at all. `Count` and `Layout` only apply to that fallback, and a
connected-but-empty input still counts as driven from outside — a tracker that
loses everything for a frame must not make 160 synthetic points appear.

`Frequency` sets the scale of the field, `Displacement` how far it pushes,
`Speed` + `Animate` walk it (off freezes in place rather than snapping to
wall-clock time), and `Point size` + `Size noise` write into `score` — scaled by
the incoming score when there is one, so a shaky detection stays small. `Drift
X/Y` necessarily means two things: generated points have no anchor, so their
homes slide and the cloud flows across the frame; incoming points do, so there
drift only moves where the field is *sampled* and the noise flows past points
that stay put. Like Particles, the phase advances by a fixed `1/fps`, so an
offline render reproduces what playback showed.

**Particles** — emitted from whatever `points` you feed it (landmarks go through
Landmarks → Points), then pushed around by gravity, drag and an attraction that
pulls each particle toward its *nearest* source rather than the centroid, so a
cloud tracks individual landmarks instead of collapsing between them. State lives
in fixed typed arrays sized to `Max particles`, and dead slots are recycled, so a
frame allocates nothing; drawing is one instanced call through the same vector
renderer the other draw nodes use.

The step is a fixed `1/fps`, not the wall-clock delta. The simulation carries
state, so an 80 ms hitch would otherwise fling everything off screen, and an
offline render would not reproduce what playback showed.

**Shader** — write the fragment shader yourself. The version pragma, precision,
`vUv`, `fragColor` and the uniform block are prepended for you, so the editor
starts at `void main()`; a `#line 1` directive makes the compiler count from your
first line, and any log that still points past the preamble is folded back, so
reported line numbers match what you are looking at.

Available: `uTex`, `uResolution`, `uTime` (seconds), `uFrame`, `uColor`, and four
knobs `uK1`–`uK4` wired to range params — which means they keyframe and animate
like any other parameter.

Six presets sit above the editor as starting points, not modes: clicking one
writes its source into the param, and it stays yours to edit. **Pixelate**
(blocks + posterise), **Pixel Sort (GPU)**, **RGB Shift**, **Dither** (ordered
4×4 Bayer), **Edges** (Sobel in `uColor`), **Kaleidoscope**. Each names its knobs
in its first line, since `K1`–`K4` mean something different in each. A selftest
compiles all six — GLSL a driver rejects is invisible to the type checker.

> **Pixel Sort (GPU) is an approximation, not a port of the node.** Sorting a
> span is sequential: knowing which pixel lands at a position needs every
> candidate's rank, which one fragment pass cannot gather, and a real GPU sort
> takes many bitonic passes. The preset instead marches out to find each
> above-threshold run and its luminance range, works out which luminance would
> sit at this position if the run were sorted, and fetches the nearest run pixel
> — two bounded marches, ~2.5 ms at 1080×1920 against 1.3 ms for a pass-through.
> Because the marches stop at `K2` steps the ordering is *local*: texture inside
> a run turns into ramps, but a long smooth gradient is already locally sorted
> and comes back nearly untouched. The CPU node sees the whole span and is the
> one that can actually reverse it. Compilation happens only when the text changes, so a
> shader that does not build is not recompiled every frame; it reports the compiler
> log to the node status and **passes its input through**, rather than blacking out
> everything downstream while you are mid-edit.



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

### Audio (approach from [granular-video](../granular-video))

**Granular** turns the picture into the score: one rectangle, one looping voice.
Wire Features Grid `rects` into it and Media `audio` alongside, and every cell
that appears cuts a grain out of the source at that instant and loops it for as
long as the cell is on screen. The chain per voice is
`bufferSource(loop) → lowpass → gain → pan → master → limiter`.

- **Size sets the cutoff.** The rectangle's perceptual size (`√(w·h)`, normalized)
maps log-wise onto `Cutoff — biggest` … `Cutoff — smallest`, so a small cell is
bright and a large one is a rumble; the window itself is set by `Size → min/max`.
The mapping updates live, so a growing cell audibly closes down.
- **Loops without clicks.** A plain cut repeats with a step at the seam. `sliceLoop`
reads one extra crossfade's worth past the slice and folds it back over the head
with an equal-power curve, so the loop point is continuous in the *original*
material — the selftest measures both (0.09 crossfaded vs 1.45 for a plain cut).
- **Identity comes from the grid.** Voices are keyed by `box.id`, so a cell that
merely moves keeps playing instead of retriggering. Boxes from sources without a
tracker fall back to their slot index.
- **Decoding is the consumer's job.** The `audio` port carries a URL, a playhead
and a duration — not samples. A Media node that decoded its whole file eagerly
would pay for it even with nothing wired up; `lib/audioBuffers.ts` decodes once
per URL, on demand, and hands out the buffer synchronously afterwards.
- The shared `AudioContext` (`lib/audioEngine.ts`) starts suspended under the
autoplay policy — the node reports *click anywhere to start audio* and resumes on
the next gesture. Pausing the engine releases every voice, since a paused graph
stops ticking and nothing would ever tell them to stop.

Mute the Media node to hear the grains alone rather than the film under them.
Turn the node's **D** toggle on to watch it work: the panel reports the context
state, the decoded buffer, live voice count, the cutoff range across them, and an
**out level** metered inline on the master — "8 grains" and "8 grains you can
actually hear" are not the same claim, and only the meter settles it.

### Debug panels

Every node's title bar carries a square **D** next to the round bypass dot.
Switched on, the node body grows a panel in the same shape as the Media probe:
what each port is carrying right now (`points ×143`, `texture 1080×1920`,
`audio 4.12/6.7s ▶`), how long `evaluate` took, and the node's status. That much
the runtime builds on its own from ports it already has, so every node gets a
panel for free, including ones written later. A node with more to say pushes
extra lines through `ctx.debugRows` — which it only does while `EvalArgs.debug`
is set, since formatting numbers every frame for every node is the cost the
toggle exists to avoid. Panels refresh four times a second and re-render only
when a line actually changes.

## Patches and output

- **Autosave** to localStorage on every edit (400 ms debounce).
Export/import JSON via toolbar buttons; “Reset” restores the starter patch.
The preset list covers every node at least once, including two that exist to
demonstrate the timeline itself — one keyframed, one modulated. A selftest walks
every preset and checks each edge names a real handle of a matching type: a
wrong handle name is not an error anywhere, the input simply never arrives.
Video files are not saved: their `blob:` URLs die with the tab, so the patch
loads with all connections, but you must pick the file again.
- **Keyframes, fps and duration are part of the patch** — they save, export and
reload with everything else. The playhead is not: it is where you are looking,
not what the document says, and saving it would rewrite the patch every frame
during playback. The `timeline` field is optional rather than a format bump, so
patches written before keyframes existed still load. Keys on file params are
dropped for the same reason the params are, and a deleted node takes its tracks
with it.
- **Modulators.** The ∿ next to any range parameter binds an LFO to it: sine,
triangle, saw, square, or smooth value noise, with rate, depth, bias and phase.
Depth is a fraction of that parameter's own half-range, and the swing is centred
on whatever the value already is — so depth 0 changes nothing, and a modulator on
a keyframed parameter rides the curve instead of replacing it. The result is
clamped to the parameter's bounds.
They run on **timeline time**, not wall clock: an offline render reproduces
exactly what playback showed, and scrubbing moves them. The flip side is that a
parked playhead means a frozen LFO — press play. Bindings live in the patch, next
to keyframes.
- **Inspector follows the playhead.** An animated parameter shows its value at the
current frame, because that is what the engine renders — a slider parked at its
base value while the output moves is just a lie. The ◆ next to each control
keys the current value (filled when a key sits exactly on the playhead, and
clicking it again removes that key). Dragging a parameter that already has keys
writes one whether or not ● Record is armed: its base value is overridden by the
curve, so editing it any other way would appear to do nothing.
- **Waveforms in the timeline** (approach from [granular-video](../granular-video)).
Video and audio clips draw their own waveform: the file is fetched once, decoded
through an `OfflineAudioContext` — no autoplay policy to fight, since nothing is
played — and reduced to 4096 min/max columns cached per URL. Zooming only
re-buckets those columns; it never decodes again. Re-bucketing takes the extreme
of each group rather than the average, or a zoomed-out waveform would flatten
into a grey bar.
Drawing normalises to the file's own loudest peak: a lane is about 20 px tall, so
a quiet recording at true scale is a flat line. A file with no decodable audio
track just stays a plain block.
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

Manual (same target as CI):

```bash
../deploy.sh visio ./dist --build "cd visio && npm run build"
```

CI: push to `main` (or Actions → **Deploy** → Run workflow) builds and rsyncs to `/var/www/AA/visio/` on `aa.arthew0.online`. Secrets: `AA_SSH_KEY` (base64 of the private key), `AA_SSH_HOST`, `AA_SSH_USER`.

Live: [https://visio.aa.arthew0.online/](https://visio.aa.arthew0.online/)  
(New subdomain needs LE expand: `certbot --cert-name aa.arthew0.online --expand -d … -d visio.aa.arthew0.online`.)

## What’s next

- Audio as a modulation source — the modulator layer takes any per-frame value,
so an FFT band would plug in where the LFO does
- Modulator routing from the graph itself, so one source can drive several params
- A worker for Pixel Sort, the last transform still sorting on the main thread
- Corners (Shi–Tomasi) could share the Hough worker; it already has the gradients

