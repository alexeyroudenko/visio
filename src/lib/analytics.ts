/**
 * Product analytics — PostHog Cloud (EU).
 *
 * Three rules this module exists to enforce:
 *
 * 1. **It never blocks the app.** `posthog-js` is a dynamic import fired after
 *    first paint; every `track()` before it lands goes into a small queue. With
 *    no key configured the whole thing is a no-op and the chunk is never fetched.
 * 2. **It never sends what the user brought in.** File names, blob URLs, shader
 *    source and free text are stripped at the boundary (`paramProps`), not left
 *    to a masking rule somewhere downstream. Autocapture is limited to
 *    buttons/links, and replay masks inputs plus anything marked `.ph-mask`.
 * 3. **It never floods.** A knob drag calls `setParam` on every pointermove;
 *    `trackParam` coalesces a burst into one event with a `moves` count.
 */
import type { ParamSpec } from "../engine/types";

const KEY = import.meta.env.VITE_POSTHOG_KEY ?? "";
const HOST = import.meta.env.VITE_POSTHOG_HOST ?? "https://eu.i.posthog.com";

/** Share of sessions that get a replay recording. Free tier is 5k/month. */
const REPLAY_SAMPLE = 0.3;
const REPLAY_DECISION_KEY = "visio.ph.replay";

/**
 * Selectors whose text is the user's own media — file names, durations, capture
 * dates. Masked in replay. `.ph-mask` is the escape hatch for anything new.
 */
const MASKED_TEXT = [
  ".media-info__value",
  ".timeline__clip-label",
  ".param__hint",
  ".editor__backdrop-caption",
  ".modal__status",
  ".ph-mask",
];

/** Quiet time after the last change before a param burst is reported. */
const PARAM_IDLE_MS = 700;
const QUEUE_LIMIT = 50;

type Props = Record<string, unknown>;
type Client = {
  init: (key: string, config: Props) => unknown;
  capture: (event: string, props?: Props) => unknown;
};

let client: Client | null = null;
let started = false;
const queue: { event: string; props: Props }[] = [];

/** DNT is checked before the import so an opted-out visitor never fetches it. */
function doNotTrack(): boolean {
  if (typeof navigator === "undefined") return true;
  const flags = [
    navigator.doNotTrack,
    (window as { doNotTrack?: string }).doNotTrack,
    (navigator as { msDoNotTrack?: string }).msDoNotTrack,
  ];
  return flags.some((flag) => flag === "1" || flag === "yes");
}

function enabled(): boolean {
  if (!KEY) return false;
  if (typeof window === "undefined") return false;
  // Dev noise would swamp real usage; opt in explicitly when testing the wiring.
  if (!import.meta.env.PROD && import.meta.env.VITE_POSTHOG_DEV !== "1") return false;
  return !doNotTrack();
}

/** Sticky per tab: a reload mid-session keeps recording instead of re-rolling. */
function recordThisSession(): boolean {
  try {
    const saved = sessionStorage.getItem(REPLAY_DECISION_KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
    const roll = Math.random() < REPLAY_SAMPLE;
    sessionStorage.setItem(REPLAY_DECISION_KEY, roll ? "1" : "0");
    return roll;
  } catch {
    return false; // private mode: no stable decision, so stay off
  }
}

declare global {
  interface Window {
    /** Dev-only tap: the last events `track()` saw, sent or not. */
    __visioEvents?: { event: string; props: Props }[];
  }
}

export function track(event: string, props: Props = {}): void {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    // Before the enabled() gate on purpose — with analytics off (the dev
    // default) this is the only way to see what a change would report.
    const seen = (window.__visioEvents ??= []);
    seen.push({ event, props });
    if (seen.length > 100) seen.shift();
  }
  if (!enabled()) return;
  if (client) {
    client.capture(event, props);
    return;
  }
  if (queue.length >= QUEUE_LIMIT) return;
  queue.push({ event, props });
}

/**
 * GPU string is the single most useful field when someone reports "it's slow" —
 * this app is a WebGL2 renderer first and a node editor second.
 */
function deviceProps(): Props {
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2");
  let renderer: string | null = null;
  if (gl) {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  }
  return {
    webgl2: Boolean(gl),
    gpu: renderer,
    cores: navigator.hardwareConcurrency ?? null,
    memory_gb: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    screen_w: window.screen?.width ?? null,
    screen_h: window.screen?.height ?? null,
    portrait: window.innerHeight > window.innerWidth,
    touch: navigator.maxTouchPoints > 0,
    media_recorder: typeof MediaRecorder !== "undefined",
  };
}

export function initAnalytics(): void {
  if (started || !enabled()) return;
  started = true;

  const start = () => {
    void import("posthog-js")
      .then(({ default: posthog }) => {
        posthog.init(KEY, {
          api_host: HOST,
          ui_host: "https://eu.posthog.com",
          // No accounts here — anonymous events keep the free tier and drop the
          // person profile nobody would ever look at.
          person_profiles: "identified_only",
          capture_pageview: true,
          capture_pageleave: true,
          capture_exceptions: true,
          respect_dnt: true,
          // Node bodies show file names and shader source; only chrome is safe
          // to autocapture, and everything real is a hand-written event anyway.
          autocapture: { element_allowlist: ["button", "a"] },
          disable_session_recording: !recordThisSession(),
          session_recording: {
            maskAllInputs: true,
            // Every place the user's own file surfaces by name. The canvas is
            // never recorded (rrweb skips it unless asked), so camera and
            // footage frames stay out of replays entirely.
            maskTextSelector: MASKED_TEXT.join(", "),
          },
        });
        client = posthog as unknown as Client;
        for (const item of queue) client.capture(item.event, item.props);
        queue.length = 0;
        client.capture("app_loaded", deviceProps());
      })
      .catch(() => {
        /* blocked by an extension or offline — analytics is never load-bearing */
      });
  };

  // After first paint: the import competes with MediaPipe and the first GL frame.
  // `in` would narrow `window` to never in the else branch — lib.dom always
  // declares requestIdleCallback, Safari just doesn't always ship it.
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(start, { timeout: 4000 });
  } else {
    window.setTimeout(start, 2000);
  }
}

// ---------------------------------------------------------------------------
// Param changes
// ---------------------------------------------------------------------------

/**
 * A param value is only reportable when its control type proves it cannot carry
 * user content. Ranges/toggles/selects/colors are authored by us; `file`, `text`,
 * `code` and `json` hold file names, prompts and shader source — those report
 * that a change happened and nothing about what it says.
 */
function paramProps(spec: ParamSpec | undefined, value: unknown): Props {
  if (!spec) return { control: "unknown" };
  switch (spec.type) {
    case "range": {
      const n = typeof value === "number" && Number.isFinite(value) ? value : null;
      const span = Math.max(1e-9, spec.max - spec.min);
      return {
        control: "range",
        value: n === null ? null : Number(n.toFixed(4)),
        // Position in the sweep — comparable across params with unlike ranges.
        t: n === null ? null : Number(Math.min(1, Math.max(0, (n - spec.min) / span)).toFixed(2)),
      };
    }
    case "toggle":
      return { control: "toggle", value: value === true };
    case "select":
      return { control: "select", value: typeof value === "string" ? value : null };
    case "color":
      return { control: "color", value: typeof value === "string" ? value : null };
    case "file":
      return { control: "file", value: null, cleared: value == null };
    case "text":
    case "code":
      return { control: spec.type, value: null, chars: typeof value === "string" ? value.length : 0 };
    default:
      return { control: "json", value: null };
  }
}

const pending = new Map<string, { timer: number; props: Props; moves: number }>();

/**
 * Coalesce a drag into one event. Keyed by node type + param rather than node id:
 * "how often does anyone touch feedback.decay" is the question, and it keeps the
 * map from growing with every node in the patch.
 */
export function trackParam(
  nodeType: string,
  key: string,
  value: unknown,
  spec: ParamSpec | undefined,
): void {
  if (!enabled()) return;
  const mapKey = `${nodeType}::${key}`;
  const existing = pending.get(mapKey);
  if (existing) window.clearTimeout(existing.timer);

  const entry = {
    props: { node_type: nodeType, param: key, ...paramProps(spec, value) },
    moves: (existing?.moves ?? 0) + 1,
    timer: window.setTimeout(() => flushParam(mapKey), PARAM_IDLE_MS),
  };
  pending.set(mapKey, entry);
}

function flushParam(mapKey: string): void {
  const entry = pending.get(mapKey);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  pending.delete(mapKey);
  track("param_changed", { ...entry.props, moves: entry.moves });
}

export function flushPendingParams(): void {
  for (const mapKey of [...pending.keys()]) flushParam(mapKey);
}

if (typeof window !== "undefined") {
  // pagehide, not unload: the only one that fires on iOS/bfcache.
  window.addEventListener("pagehide", flushPendingParams);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Extensions this app opens or writes — the tail of any name worth hiding. */
const MEDIA_EXT =
  "mp4|webm|mov|m4v|ogv|mp3|wav|ogg|oga|m4a|aac|flac|opus|png|jpe?g|gif|webp|bmp|avif|json";

/**
 * Blob URLs, paths and bare file names all name the user's footage.
 *
 * Paths run first and are extension-aware, because a path regex otherwise has
 * to stop at whitespace and `C:\Videos\SECRET clip.mp4` would leave `clip.mp4`
 * behind. The bare-name rule then takes up to two leading words for the same
 * reason — it eats a word of context now and then, which is the right trade
 * against emitting someone's file name.
 */
export function scrub(message: string): string {
  return message
    .replace(/blob:\S+/gi, "blob:…")
    .replace(/https?:\/\/\S+/gi, "url:…")
    .replace(new RegExp(`[A-Za-z]:\\\\[^"']*?\\.(?:${MEDIA_EXT})\\b`, "gi"), "path:…")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "path:…")
    .replace(/(?:\/[\w\-. ()]+){2,}/g, "path:…")
    .replace(
      new RegExp(`(?:[\\w\\-.()\\[\\]]+ ){0,2}[\\w\\-.()\\[\\]]+\\.(?:${MEDIA_EXT})\\b`, "gi"),
      "file:…",
    )
    .slice(0, 180);
}
