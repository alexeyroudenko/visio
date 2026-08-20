# visio

Node environment in the browser: **image, video, camera, or audio → tracking →
WebGL graphics → granular audio**. Drop a file anywhere on the window to load it
into the Media source. A simplified cables.gl for one job — visualizing tracking data in real
time, and letting the picture drive the sound when you wire Features Grid
`rects` into **Granular**.

```bash
npm install
npm run dev
```

Render-core self-test: [http://localhost:5173/selftest.html](http://localhost:5173/selftest.html) (157 checks — draw)
coordinates, rings, detection style, grid and its effect, glitch effects, feedback
decay, blending, Hough detectors on a synthetic frame, patch serialization,
capture metadata off synthetic MP4 boxes, lazy MediaPipe import, point-mesh
Voronoi/Delaunay/MST/Radial, source type of a dropped file, visio.ship.json, Text title card). Dev-only page: it
is not built into `dist`.

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
- **The image library is a folder.** The Media inspector’s Library row lists whatever
sits in `public/imgs` — drop a `.png/.jpg/.webp/.gif/.avif` in and it appears (dev reloads
on add/remove). The `vite.imageLibrary.ts` plugin reads the folder and serves the names as
`virtual:image-library`, because `public/` is copied verbatim and never seen by the bundler.
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
| Sources  | Media (camera · image · video · audio), **Noise**, **Text**                                                                      |
| Tracking | Pose (33 points), Hands, Face Mesh, Objects (EfficientDet), **Segmentation** (Image Segmenter), Corners (Shi–Tomasi), **Features Tracking** (PyrLK trails), Hough Circles, Hough Lines, Landmarks → Points, **Points Noise** |
| Draw     | Draw Skeleton, Draw Points, Draw Boxes, Draw Circles, Draw Lines, Features Grid, Connectors, **Voronoi**, **Delaunay**, **MST**, **Radial**, Quadtree, **Particles**             |
| FX       | Feedback, **Displace Feedback**, Blend, Color, **Threshold**, Zoom, Slice Shift, Block Scatter, Pixel Sort, **Motion Vectors**, **Gen Motion Vectors**, **Datamosh**, **Shader**           |
| Audio    | **Granular**                                                                                                                     |
| Output   | Output                                                                                                                           |


Ports are typed (`frame`, `texture`, `landmarks`, `points`, `boxes`, `circles`,
`lines`, `audio`) — the editor will not connect incompatible ones.

**Media reads the file, not just the picture.** Alongside size and duration the
Inspector reports container, video/audio codec, average bitrate, and — for
footage that carries it — when and where it was shot, on which camera and lens,
and the rotation stored in the track matrix. All of that lives in the `moov`
box, and a phone writes `moov` *after* the samples: on a 20 MB iPhone clip it
starts at 99.9% of the file, so the old head-only read found the brand and
nothing else. `lib/mp4Boxes.ts` hops top-level box headers to locate it, which
costs a handful of small reads instead of a scan. Timestamps are shown as the
file recorded them rather than converted to the viewer's clock: Apple's
`creationdate` states its UTC offset, the `mvhd` fallback does not, and cameras
routinely write local time into a field defined as UTC.

The sidebar has to fit a lens model into one ellipsised line, so **Info ↗** above
the panel opens the same read-out in its own window: grouped into Stream /
Capture / Playback, wrapped instead of clipped, with a link to the coordinates
on a map and a Copy JSON button. It stays live — leave it open on a second
screen while the patch runs. Values are rewritten only when they actually
change, so a selection you are dragging across a coordinate survives the next
refresh.

CPU detectors (Corners, Hough) share one `GrayFrame`: downscale, grayscale, and
Sobel run once per node, with no allocations per frame. Each has an
“every N frames” throttle — Hough is expensive; every 2–3 frames it is barely noticeable.

**Hough + Corners run in a worker** (`Run in worker`, on by default). The split
follows what can actually move: reading the frame and downscaling it needs a canvas
and stays on the main thread, while turning gradients into edges/shapes (or
Shi–Tomasi corners) is pure arithmetic and goes to `hough.worker.ts`. Corners posts
the same Sobel buffers circles/lines already use — only the structure-tensor loop
moves. On a busy 1080×1920 frame at downscale 2 that takes the per-tick
main-thread cost from 139 ms to 0.1 ms — the remaining spikes are the frame read
and Sobel, which cannot leave.

One job per node is in flight at a time; queueing more would only build a backlog
of stale frames. Results therefore arrive a frame or two late and the node keeps
showing the previous ones, which is the same deal as the throttle. The gradients
are copied before being posted, because `GrayFrame` reuses its arrays and posting
transfers ownership. Turning the toggle off runs the identical functions inline.

**Features Tracking** — [FeaturesTracking](https://alexeyroudenko.net/ru/projects/features-tracking/)
pipeline in-browser: Shi–Tomasi corners each few frames, pyramidal Lucas–Kanade
(`calcOpticalFlowPyrLK`) between frames, forward–backward error cull, then only
tracks that lived `Min age` frames (default 50) emit **motion-line** segments.
The `points` port lists every live track immediately (a still Media frame never
bumps `frameId`, so gating points on age left them stuck at zero). Wire `out` →
Draw Lines (and optionally `points` → Draw Points / Connectors).

**Draw Points** supports three styles, like tracking layers in cv-reels:
`point` · `ring (detection)` — a ring with radius from score between min/max plus a
center dot · `cross`. Plus a “web” of links between nearby points.

**Features Grid** — Mondrian grid from cv-reels: the frame is recursively split in half
at the median point (guillotine k-d split); leaves are outlined and labeled.
Frames and labels are built on a 2D canvas and uploaded as a texture (premultiplied,
blended on top) — text has no cheap WebGL equivalent. Everything else is GPU.

`Use content edge` hugs the silhouette instead of the canvas: cells touching a
border are trimmed to the outermost content pixel in their own band, and
`Min content` (default 5%) then drops whatever is left sitting on the backdrop.
That cull is what stops a point found on the background — the frame's own
corners are strong Shi–Tomasi corners — from splitting out a block over empty
space; edge trimming alone cannot see those, since a cell in the middle of the
frame touches nothing. Set it to 0 to trim without culling.

The mask behind it comes from a **downscaled** readback of `bg` (GPU blit to
480-wide, then `readPixels` — never the full frame), because `bg` is the only
input in the cells' own coordinate space. Media `frame` is the raw decoded
picture and knows nothing of the source node's fit, zoom or mirror, so a mask
stretched from it puts the silhouette somewhere other than where it is on
screen; it stays as a fallback for a grid drawn with no background at all. The
mask describes the *background*, which changes far slower than the cells riding
on it, so it is cached and rebuilt on `Edge mask every N frames` (default 4),
floored at 4 whenever the readback is the source — that path is the stall.
Trimming itself still runs every frame; only the mask is throttled. At
1080×1920 the old full-frame fallback was 24 ms per frame at interval 1; with
the downscale + throttle it stays in the single-digit ms range.

`Effect cell fraction` + `Effect seed` enable smear from the original: for cells
picked by a seeded LCG, a 1 px-wide column from the center is stretched across the
whole cell. Each such cell is a separate pass with `gl.viewport` set to its
rectangle, so the shader does not iterate cells per pixel. `Filled frames`
outlines only those cells, so the grid reads as a set of solid blocks rather
than a wireframe with a few of them shaded.

**Voronoi** — dual of Delaunay over the point cloud. Modes: `edges` (cell
borders), `mosaic` (each cell filled with the colour sampled at its seed —
stained-glass), or `both`. Mosaic uses a CPU readback + canvas upload like
Quadtree; throttle with `Every N frames`.

**Delaunay** — triangulation of the same cloud. Modes: `edges`, `low-poly`
(fill each triangle with the colour at its centroid), or `both`. The classic
feature-point low-poly look.

**MST** — Prim minimum spanning tree: a constellation / star-sign web with
exactly `n−1` segments — cleaner than dense Connectors.

**Radial** — hub-and-spoke. `centroid` links every point to the cloud centre;
`k-nearest` links each point to its `k` neighbours.

The **`points` output** is the cuts, not the cloud: the medians a split was
actually made at, each reported once however many cuts it served, and minus any
whose cells the content cull removed. Most of an incoming cloud never becomes a
cut — the recursion bottoms out on `Depth` or `Min cell` long before every point
has had a turn — so this is the only honest answer to which points the grid was
built from. Wire it into Draw Points to see the skeleton of the split.

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
`Run in worker` (default on) posts a copy of those words to `pixelSort.worker.ts` so
the counting sort does not block the main thread; the node keeps the previous texture
until the sorted buffer lands, same latency model as Hough. Toggle it off for a
single-tick deterministic path (selftests do).
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
need a cycle in the graph. **Displace Feedback** reuses the same ping-pong and adds
a second texture input that warps the accumulation (or the incoming content) each
frame. For real cycles a node can declare `delayedInputs` — those edges are
excluded from topo-sort.

### Segmentation

**Segmentation** runs MediaPipe's Image Segmenter and hands back a mask: the
picked class white, everything else black, at patch resolution. Four models are
wired up — selfie (person), selfie multiclass (hair / body skin / face skin /
clothes / accessories), hair, and DeepLab v3 with the twenty Pascal classes.

Each model has its own vocabulary and reports it through `getLabels()`; the
confidence masks come back in exactly that order. So the class is picked by
*name* in the Inspector and resolved against the running model's labels, with a
short alias list for the places the models disagree — the selfie model calls a
person "selfie", DeepLab calls it "person". Ask a model for a class it does not
have and the node says so in its status line, listing what it does know, rather
than quietly masking nothing.

Confidence masks rather than the category mask: they are soft at the edges,
which is the point of a mask, and `Threshold` / `Soft edge` decide how hard the
cut is. Inference runs on a downscale of the frame (`Mask size`, 128–384 on the
long edge) and the result is stretched back over the frame — the frame a tracker
sees is already composed at patch resolution, so a uniform downscale keeps the
mask aligned with the picture pixel for pixel. The mask lands in a single-channel
`R8` texture; the black-and-white pass is a shader, so Threshold, Soft edge and
Invert respond without re-running the model.

### Datamosh

The effect is a codec with one thing taken away. **Motion Vectors** does the
estimation: luma at 1/2–1/8 resolution, one vector per block, block matching in
two passes — every second offset out to the search radius, then a refinement
ring, which covers the same offsets a full search would for a fraction of the
taps. A short vector is preferred by a small penalty on length, or a flat wall
that matches equally well everywhere comes back with whatever offset the loop
tried first. Confidence is how much better the winner is than standing still, so
an unchanged block scores zero and never invents motion. Vectors are RG centred
on 0.5, the same encoding the displacement maps use, so the field also drops
straight into Displace Feedback's map input.

**Datamosh** decodes a P-frame with that field and never accepts an I-frame:
the accumulator is resampled along the vectors and the difference between the
two source frames is added on top. When the prediction is right that is exactly
the picture again — a still frame passes through untouched. When the reference
is wrong, which is what dropping the I-frame guarantees at every cut, the
residual lands on a picture it was never computed against, and that is the
bloom. `I-frame every` puts the refresh back (0 never refreshes), `Bleed` mixes
in a little of the live frame so ten seconds of prediction does not end as mush,
and the `vectors` input takes a field from anywhere — a second clip's motion
over this one is the original technique.

With nothing wired into `vectors` the node estimates its own, so it works as a
single node; wire the field in and its own estimator is skipped.

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
A reload or a new visit **resets** to the empty drop screen by default in
production (Settings → **Reset on visit**). Uncheck that to restore the last
patch. `npm run dev` defaults the checkbox off so a refresh keeps the graph.
Export/import JSON via toolbar buttons; “Reset” still clears while the tab is
open, regardless of the setting.
The preset list covers most nodes, including two that exist to
demonstrate the timeline itself — one keyframed, one modulated. A selftest walks
every preset and checks each edge names a real handle of a matching type: a
wrong handle name is not an error anywhere, the input simply never arrives.
A builtin left unchecked in `npm run dev` (the checkbox on the card) is written
to [`visio.ship.json`](visio.ship.json) and skipped by the next `npm run build`:
out of the picker, thumb stripped from `dist`. The default preset cannot be omitted.
`getPreset` still resolves an omitted id, so a stored `activePresetId` keeps
working. Dev shows omitted cards dimmed so they can be checked back in.
The same file stores + Node checkboxes (`omitNodes`). Production hides those
types from the menu; existing patches still load them. Media and Output cannot
be omitted. Restarting `npm run dev` keeps the last set of ticks.
In `npm run dev` the picker also has a red **Save**: it overwrites the selected
builtin with the current patch (`src/presets/overrides/<id>.json`, and the
standalone `.ts` source when that preset has one) and recaptures
`public/presets/<id>.jpg` from the live output.
An empty node list is a valid patch (first launch / Reset); `parsePatch`
used to reject it.
Video files are not saved: their `blob:` URLs die with the tab, so the patch
loads with all connections, but you must pick the file again.
- **Dropping a file replaces the source, it does not add a node.** A drag over
the window is caught on `window` — panels, toolbar and timeline included, since
a drop zone the size of the graph is a target you have to aim at, and the
browser would otherwise navigate the tab to the file and take the session with
it. `.drop-hint` is the highlight. The file lands on the Media node you have
selected, else one already on that kind (an mp3 goes to the audio node, not the
image one), else the first; the node switches image/video/audio to match, and a
patch with no Media node gets one (and an Output wired to it, if the graph was
empty). A drop onto that empty graph pauses playback, blinks Presets for a
second, then opens the picker; video starts when the modal closes or a preset
loads. Only the first usable file is taken: the
memory below keeps one `blob:` URL per kind and revokes the one it replaces, so
two images in a single drop would leave the first node holding a dead URL.
- **The footage outlives the patch, in this tab.** Presets ship their own source type and
file, and loading one used to throw away the video you had just dropped.
`mediaMemory` remembers the last file per source type plus the type itself, and
a patch load (preset, import) applies both over whatever the patch said —
so you can flip through presets against your own material. Reload with Reset-on-visit
on (and the Reset button) forget the remembered footage too, and land on the empty drop
screen rather than the template. Switching type in the
Inspector swaps its file back in too, so image → video → image gets both back;
a type you have never opened a file for clears the field instead of leaving a
video source pointed at a PNG. It also owns the `blob:` URLs, releasing one only
when no source type still remembers it. Survives a reload when Reset-on-visit is off.
- **Keyframes, fps and duration are part of the patch** — they save, export and
reload with everything else. The playhead is not: it is where you are looking,
not what the document says, and saving it would rewrite the patch every frame
during playback. The `timeline` field is optional rather than a format bump, so
patches written before keyframes existed still load. Keys on file params are
dropped for the same reason the params are, and a deleted node takes its tracks
with it.
- **Modulators.** The ∿ next to any range parameter binds a drive to it. Source
**LFO** offers sine, triangle, saw, square, or smooth value noise, with rate,
depth, bias and phase. Source **Audio** reads an FFT band from the first Media
video/audio buffer at the timeline playhead (low / mid / high presets, or custom
lo–hi Hz) — the same −1..1 slot the LFO wave would fill. Depth is a fraction of
that parameter's own half-range, and the swing is centred on whatever the value
already is — so depth 0 changes nothing, and a modulator on a keyframed parameter
rides the curve instead of replacing it. The result is clamped to the parameter's
bounds. They run on **timeline time**, not wall clock: an offline render
reproduces exactly what playback showed, and scrubbing moves them. The flip side
is that a parked playhead means a frozen drive — press play. Bindings live in the
patch, next to keyframes.
- **Modulator node (graph routing).** Add a **Modulator** node (Audio menu) to
share one LFO or audio band across several params. Soft-binds in the Inspector
(+ / −) pick a target node and range param, each with its own depth and bias —
same −1..1 drive, different swing. Graph routing runs after per-param ∿
bindings and before Audio Analyzer soft-binds.
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
- **Render video** — toolbar: offline frame-by-frame timeline export (not realtime).
  On finish it downloads the video **and** a matching patch JSON with the same
  basename (`clip-render-….webm` + `clip-render-….json`).
- **Render image** — toolbar, next to video: PNG of the playhead frame at the
  patch resolution (preview quality does not apply). Basename `clip-still-….png`.
Both video writers use the bitrate set in Settings (12 Mbps by default); fps is a
Render setting alone, since Record follows the clock.
- **Exported patches** lead with the footage they were built on —
`clip-visio-patch-2026-08-08.json`, and a `source` field inside. Dropped files
live behind a `blob:` URL the params cannot keep, so the name is all that is
left to say which clip a patch belongs to.
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

## Install as an app (PWA)

The site installs to the desktop, the Start menu and the iOS home screen, and
runs in its own window with no browser chrome. Settings (☰) carries an
**Install as app** section: an in-app button where Chromium offers one, and the
Share → Add to Home Screen instructions where WebKit does not.

| Piece | File | Note |
|---|---|---|
| Manifest | [`public/manifest.json`](public/manifest.json) | `.json`, not `.webmanifest` — nginx ships no MIME type for the latter, and a manifest served as `octet-stream` is ignored |
| Worker | [`public/sw.js`](public/sw.js) | plain JS in `public/` so it lands at the dist root and gets scope `/` |
| Wiring | [`src/lib/pwa.ts`](src/lib/pwa.ts) | captures `beforeinstallprompt` at module scope — it fires once, early, and only that object can open the dialog later |
| Icons | `public/icons/`, `public/apple-touch-icon.png` | regenerate with `python scripts/generate-icons.py` after replacing `assets/icon-master.png` |
| Window size | [`src/lib/appWindow.ts`](src/lib/appWindow.ts) | no manifest field exists for it — `resizeTo` is the only lever, and only installed windows are allowed to pull it |

The installed window takes the patch's shape (1080×1920 by default): once on the
first launch after install, again on Reset, and on demand from Settings. A
1920-tall window does not fit a 1080p monitor, so it is scaled down to the
tallest 9:16 window the work area holds rather than clamped on one axis into the
wrong shape. Later launches reopen at whatever size the window was dragged to —
the browser remembers that, and re-imposing a size every launch would be a fight
with the user. In a tab every one of these calls is a no-op.

Caching is three strategies, chosen per request: network-first for navigations
(HTML must follow deploys), cache-first for hashed `/assets/` (immutable by
construction), stale-while-revalidate for everything else same-origin. Audio and
video are skipped outright — they stream over Range requests the Cache API
cannot answer. The MediaPipe wasm comes from jsDelivr, so tracking still needs
the network on first use; the shell itself boots offline.

Chrome only fires `beforeinstallprompt` for a worker with a **non-empty** fetch
handler, so the offline story is also the price of admission for the install
prompt. Registration is skipped in `npm run dev`, which instead unregisters any
worker left behind by `npm run preview` on the same host — otherwise stale
chunks make dev edits look like they never happened.

iOS ignores the manifest for home-screen installs and reads the `apple-*` tags
in `index.html`. The status bar is `black-translucent`, which is only safe
because the portrait shell already pads with `env(safe-area-inset-*)`.

## Analytics

Product analytics via **PostHog Cloud (EU)**, wired in [`src/lib/analytics.ts`](src/lib/analytics.ts).
It answers three questions: where do people give up, which node chains do they
actually build, and which knobs do they turn.

Off unless `VITE_POSTHOG_KEY` is set — no key, no network, no chunk. Also off
under Do Not Track, and off in `npm run dev` unless `VITE_POSTHOG_DEV=1`.

**Excluding yourself:** open `…/?analytics=off` once per browser and that device
never sends again (`?analytics=on` undoes it); it logs which state it is in.
Device-scoped on purpose — an IP filter breaks the moment you switch networks
or pick up the phone, and PostHog's own internal-user filter only hides events
in the UI after they have already been ingested and billed.
Copy `.env.example` → `.env.local` to run it locally; CI reads the repo
variables `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` (Settings → Secrets and
variables → Actions → **Variables**). The key is public by design — it ships in
the bundle, so it is a variable, not a secret.

`posthog-js` is a dynamic import fired on `requestIdleCallback`, so it never
competes with MediaPipe or the first GL frame: a separate 82 kB gzip chunk that
loads after the app is interactive. Events fired before it lands are queued.

### Events

| Event | Fired at | Why |
|---|---|---|
| `app_loaded` | init | GPU string, cores, WebGL2, portrait — triage for “it’s slow”. Also `first_visit`. `restored` is true when the last patch came back (Reset-on-visit off). `nodes`/`edges` at launch |
| `first_source_ready` | first source node reporting ready | time-to-first-picture, once per session. Not the output node: draw and output nodes own no async resource and never leave `idle` |
| `media_added` | Media node created | `kind` only (image/video/camera/audio), never the file |
| `media_dropped` | file dropped on the window | `kind` only — how often footage arrives by drag rather than the file picker |
| `node_added` / `node_removed` / `node_bypass` | graph edits | which nodes get reached for |
| `edge_connected` | wire accepted | the chains people build — from/to type and port |
| `edge_refused` | type mismatch | a wrong mental model of the graph, i.e. a затык |
| `param_changed` | 700 ms after the last change | the knobs; a drag is one event with a `moves` count |
| `preset_applied`, `patch_imported`/`_exported`/`_reset`, `resolution_changed` | toolbar & Settings | entry points |
| `render_started` / `_finished` / `_cancelled` / `_failed` | offline render | the main conversion, plus how long people wait |
| `record_started` / `_saved` / `_failed` | canvas recording | where MediaRecorder support gives out (Safari/iOS) |
| `node_error`, `app_error` | node status, app console | catch-all; `app_error` overlaps the specific ones by design |
| `pwa_installable`, `pwa_install_choice`, `pwa_installed` | install prompt | whether anyone actually installs it. `app_loaded` also carries `standalone`, i.e. this session runs from the home screen |

Autocapture is limited to `button`/`a`, so clicks on chrome are free but node
bodies are not captured. Uncaught exceptions go to PostHog Error Tracking.

### What is never sent

File names, blob URLs and Windows paths (`scrub()` strips them from every
message), and the value of any `file`, `text`, `code` or `json` param — shader
source and prompts report only that they changed and how long they are. Only
`range`/`toggle`/`select`/`color` params, which we author ourselves, report a value.

Session replay records 30% of sessions (sticky per tab via `sessionStorage`;
the free tier is 5k recordings/month) — but only once **Session replay is
switched on in the PostHog project settings**. Until then the client asks and
the server declines: `recorder.js` never loads and no `/s/` snapshots are sent,
with nothing in the console to say so. React Flow is DOM, so the graph replays
properly — the canvas does not, because rrweb skips canvas unless asked, which
keeps camera and footage frames out of recordings entirely. Inputs are masked,
as is the text of `.media-info__value`, `.timeline__clip-label`, `.param__hint`,
`.editor__backdrop-caption`, `.modal__status` and anything marked `.ph-mask`.
Known gap: a `title` attribute on those same elements can still carry a file
name into a replay.

## What’s next

- (open) —

