import type { AudioValue } from "../../engine/types";
import { finalizeAnalyzerOut } from "../../lib/analyzerBindings";
import { ensureAudioBuffer } from "../../lib/audioBuffers";
import { rmsAt } from "../../lib/audioRms";
import { defineNode, paramNumber, paramString } from "../defineNode";

interface AnalyzerState {
  /** Last raw RMS before gain — debug only. */
  raw: number;
}

/**
 * Listens to an `audio` wire, measures RMS, exposes it as number port `out`
 * and as the live `out` param. Optional soft-bind: pick another node + range
 * param in the Inspector and RMS drives that value each frame (smoothing /
 * depth applied in the analyzer-bindings pass).
 */
export const analyzerNode = defineNode<AnalyzerState>({
  type: "audio.analyzer",
  label: "Audio Analyzer",
  category: "audio",
  description:
    "RMS level from an audio input — bind Out to another node's range param (e.g. Points Noise displacement).",
  inputs: [{ id: "audio", label: "audio", type: "audio" }],
  outputs: [{ id: "out", label: "out", type: "number" }],
  params: [
    {
      key: "out",
      label: "Out (RMS)",
      type: "range",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      key: "gain",
      label: "Gain",
      type: "range",
      min: 0,
      max: 8,
      step: 0.05,
      default: 2,
    },
    {
      key: "smoothing",
      label: "Smoothing",
      type: "range",
      min: 0,
      max: 0.95,
      step: 0.01,
      default: 0.7,
    },
    {
      key: "depth",
      label: "Bind depth",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      key: "targetNode",
      label: "Target node",
      type: "select",
      options: [{ value: "", label: "(none)" }],
      default: "",
    },
    {
      key: "targetParam",
      label: "Target param",
      type: "select",
      options: [{ value: "", label: "(none)" }],
      default: "",
    },
  ],
  createState: () => ({ raw: 0 }),
  evaluate({ inputs, params, runtime, nodeId, ctx, debug }) {
    const audio = inputs.audio as AudioValue | null | undefined;
    const gain = paramNumber(params, "gain", 2);

    let raw = 0;
    if (audio?.url) {
      const entry = ensureAudioBuffer(audio.url);
      const buffer = audio.buffer ?? entry.buffer;
      if (buffer) {
        raw = rmsAt(buffer, audio.timeSec);
      } else if (entry.status === "loading") {
        ctx.report(nodeId, "loading", "decoding audio…");
      } else if (entry.status === "error") {
        ctx.report(nodeId, "error", entry.message ?? "no audio");
      }
    } else {
      ctx.report(nodeId, "idle", "connect audio");
    }

    runtime.state.raw = raw;
    // Instant level for the number port; EMA + soft-bind live in applyAnalyzerBindings.
    const level = finalizeAnalyzerOut(nodeId, Math.min(1, Math.max(0, raw * gain)));

    if (debug) {
      const target = paramString(params, "targetNode", "");
      const key = paramString(params, "targetParam", "");
      ctx.debugRows(nodeId, [
        { label: "raw", value: raw.toFixed(3) },
        { label: "out", value: level.toFixed(3) },
        { label: "bind", value: target && key ? `${target}.${key}` : "—" },
      ]);
    }

    if (audio?.url && runtime.status !== "ready") {
      ctx.report(nodeId, "ready", `rms ${level.toFixed(2)}`);
    }

    return { out: level };
  },
});
