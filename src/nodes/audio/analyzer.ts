import type { AudioValue } from "../../engine/types";
import {
  ANALYZER_BANDS,
  analyzerOutKey,
  finalizeAnalyzerOut,
  parseAnalyzerBinds,
  queueAnalyzerBind,
  smoothAnalyzerLevel,
  type AnalyzerBandId,
} from "../../lib/analyzerBindings";
import { bandEnergy } from "../../lib/audioBands";
import { ensureAudioBuffer } from "../../lib/audioBuffers";
import { appLog } from "../../store/consoleStore";
import { defineNode, paramNumber } from "../defineNode";

interface AnalyzerState {
  lastLogAt: number;
  lastLogged: Partial<Record<AnalyzerBandId, number>>;
}

/**
 * Three FFT bands (low / mid / high) from an `audio` wire. Each band has its
 * own out level; soft-binds in `binds[]` map any band onto any other node's
 * range params (Inspector + / −).
 */
export const analyzerNode = defineNode<AnalyzerState>({
  type: "audio.analyzer",
  label: "Audio Analyzer",
  category: "audio",
  description:
    "Low / mid / high band levels from audio — tune each range, then bind any band to other nodes' params.",
  inputs: [{ id: "audio", label: "audio", type: "audio" }],
  outputs: [
    { id: "low", label: "low", type: "number" },
    { id: "mid", label: "mid", type: "number" },
    { id: "high", label: "high", type: "number" },
  ],
  params: [
    {
      key: "outLow",
      label: "Low out",
      type: "range",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      key: "lowLoHz",
      label: "Low min Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: 20,
    },
    {
      key: "lowHiHz",
      label: "Low max Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: 200,
    },
    {
      key: "outMid",
      label: "Mid out",
      type: "range",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      key: "midLoHz",
      label: "Mid min Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: 200,
    },
    {
      key: "midHiHz",
      label: "Mid max Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: 2000,
    },
    {
      key: "outHigh",
      label: "High out",
      type: "range",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      key: "highLoHz",
      label: "High min Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: 2000,
    },
    {
      key: "highHiHz",
      label: "High max Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: 8000,
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
      default: 0.35,
    },
    /** Soft-binds — edited via AnalyzerBindPanel, not a generic control. */
    { key: "binds", label: "Bindings", type: "json", default: [] },
  ],
  createState: () => ({ lastLogAt: 0, lastLogged: {} }),
  evaluate({ inputs, params, runtime, nodeId, ctx, debug }) {
    const audio = inputs.audio as AudioValue | null | undefined;
    const gain = paramNumber(params, "gain", 2);
    const smoothing = paramNumber(params, "smoothing", 0.35);
    const binds = parseAnalyzerBinds(params);

    let buffer: AudioBuffer | null = null;
    let bufferStatus = "none";
    if (audio?.url) {
      const entry = ensureAudioBuffer(audio.url);
      buffer = audio.buffer ?? entry.buffer;
      bufferStatus = buffer ? "ready" : entry.status;
      if (!buffer && entry.status === "loading") {
        ctx.report(nodeId, "loading", "decoding audio…");
      } else if (!buffer && entry.status === "error") {
        ctx.report(nodeId, "error", entry.message ?? "no audio");
      }
    } else {
      ctx.report(nodeId, "idle", "connect audio");
    }

    // Legacy single-band Hz → low band defaults when new keys are missing.
    const legacyLo =
      typeof params.bandLoHz === "number" ? (params.bandLoHz as number) : undefined;
    const legacyHi =
      typeof params.bandHiHz === "number" ? (params.bandHiHz as number) : undefined;

    const levels: Record<AnalyzerBandId, number> = { low: 0, mid: 0, high: 0 };
    for (const band of ANALYZER_BANDS) {
      const fallbackLo = band.id === "low" && legacyLo != null ? legacyLo : band.defaultLo;
      const fallbackHi = band.id === "low" && legacyHi != null ? legacyHi : band.defaultHi;
      const loHz = paramNumber(params, band.loKey, fallbackLo);
      const hiHz = paramNumber(params, band.hiKey, fallbackHi);
      const raw = buffer && audio ? bandEnergy(buffer, audio.timeSec, loHz, hiHz) : 0;
      const slot = analyzerOutKey(nodeId, band.id);
      levels[band.id] = finalizeAnalyzerOut(
        slot,
        smoothAnalyzerLevel(slot, Math.min(1, Math.max(0, raw * gain)), smoothing),
      );
    }

    for (const bind of binds) {
      queueAnalyzerBind(levels[bind.band], bind.targetNode, bind.targetParam, bind.depth);
    }

    if (debug) {
      ctx.debugRows(nodeId, [
        { label: "time", value: audio ? `${audio.timeSec.toFixed(2)}s` : "—" },
        { label: "low", value: levels.low.toFixed(3) },
        { label: "mid", value: levels.mid.toFixed(3) },
        { label: "high", value: levels.high.toFixed(3) },
        {
          label: "binds",
          value: String(binds.filter((b) => b.targetNode && b.targetParam).length),
        },
      ]);
    }

    const now = performance.now();
    if (audio?.url && now - runtime.state.lastLogAt >= 2500) {
      const dLow = levels.low - (runtime.state.lastLogged.low ?? 0);
      appLog(
        "info",
        "analyzer",
        `${nodeId} t=${audio.timeSec.toFixed(2)}s play=${audio.playing ? "1" : "0"} ` +
          `buf=${bufferStatus} ` +
          `L=${levels.low.toFixed(3)}(Δ${dLow.toFixed(3)}) ` +
          `M=${levels.mid.toFixed(3)} H=${levels.high.toFixed(3)} ` +
          `binds=${binds.filter((b) => b.targetNode && b.targetParam).length}`,
      );
      runtime.state.lastLogAt = now;
      runtime.state.lastLogged = { ...levels };
    }

    if (audio?.url) {
      ctx.report(
        nodeId,
        "ready",
        `L ${levels.low.toFixed(2)} · M ${levels.mid.toFixed(2)} · H ${levels.high.toFixed(2)}`,
      );
    }

    return { low: levels.low, mid: levels.mid, high: levels.high };
  },
});
