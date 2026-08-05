import type { AudioValue } from "../../engine/types";
import {
  finalizeAnalyzerOut,
  queueAnalyzerBind,
  smoothAnalyzerLevel,
} from "../../lib/analyzerBindings";
import { bandEnergy } from "../../lib/audioBands";
import { ensureAudioBuffer } from "../../lib/audioBuffers";
import { appLog } from "../../store/consoleStore";
import { defineNode, paramNumber, paramString } from "../defineNode";

interface AnalyzerState {
  /** Last raw band level before gain — debug only. */
  raw: number;
  /** Last time we wrote a heartbeat log (performance.now). */
  lastLogAt: number;
  /** Out at last heartbeat — to see if the level is stuck. */
  lastLoggedOut: number;
}

/**
 * Listens to an `audio` wire, measures band energy (FFT, lo..hi Hz), exposes it
 * as number port `out` and queues an optional soft-bind onto another node's
 * range param for the next engine tick.
 */
export const analyzerNode = defineNode<AnalyzerState>({
  type: "audio.analyzer",
  label: "Audio Analyzer",
  category: "audio",
  description:
    "Band level from an audio input — set Min/Max Hz, then bind Out to another node's range param.",
  inputs: [{ id: "audio", label: "audio", type: "audio" }],
  outputs: [{ id: "out", label: "out", type: "number" }],
  params: [
    {
      key: "out",
      label: "Out",
      type: "range",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0,
    },
    {
      key: "bandLoHz",
      label: "Min Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: 20,
    },
    {
      key: "bandHiHz",
      label: "Max Hz",
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
  createState: () => ({ raw: 0, lastLogAt: 0, lastLoggedOut: 0 }),
  evaluate({ inputs, params, runtime, nodeId, ctx, debug }) {
    const audio = inputs.audio as AudioValue | null | undefined;
    const gain = paramNumber(params, "gain", 2);
    const loHz = paramNumber(params, "bandLoHz", 20);
    const hiHz = paramNumber(params, "bandHiHz", 8000);
    const smoothing = paramNumber(params, "smoothing", 0.35);
    const depth = paramNumber(params, "depth", 1);
    const targetNode = paramString(params, "targetNode", "");
    const targetParam = paramString(params, "targetParam", "");

    let raw = 0;
    let bufferStatus = "none";
    if (audio?.url) {
      const entry = ensureAudioBuffer(audio.url);
      const buffer = audio.buffer ?? entry.buffer;
      bufferStatus = entry.status;
      if (buffer) {
        raw = bandEnergy(buffer, audio.timeSec, loHz, hiHz);
        bufferStatus = "ready";
      } else if (entry.status === "loading") {
        ctx.report(nodeId, "loading", "decoding audio…");
      } else if (entry.status === "error") {
        ctx.report(nodeId, "error", entry.message ?? "no audio");
      }
    } else {
      ctx.report(nodeId, "idle", "connect audio");
    }

    runtime.state.raw = raw;
    const level = finalizeAnalyzerOut(
      nodeId,
      smoothAnalyzerLevel(nodeId, Math.min(1, Math.max(0, raw * gain)), smoothing),
    );
    queueAnalyzerBind(level, targetNode, targetParam, depth);

    if (debug) {
      ctx.debugRows(nodeId, [
        { label: "band", value: `${Math.round(loHz)}–${Math.round(hiHz)} Hz` },
        { label: "time", value: audio ? `${audio.timeSec.toFixed(2)}s` : "—" },
        { label: "raw", value: raw.toFixed(3) },
        { label: "out", value: level.toFixed(3) },
        { label: "bind", value: targetNode && targetParam ? `${targetNode}.${targetParam}` : "—" },
      ]);
    }

    // Heartbeat while a source is wired — every ~2.5s so Console shows motion.
    const now = performance.now();
    if (audio?.url && now - runtime.state.lastLogAt >= 2500) {
      const delta = level - runtime.state.lastLoggedOut;
      appLog(
        "info",
        "analyzer",
        `${nodeId} t=${audio.timeSec.toFixed(2)}s play=${audio.playing ? "1" : "0"} ` +
          `buf=${bufferStatus} band=${Math.round(loHz)}-${Math.round(hiHz)} ` +
          `raw=${raw.toFixed(3)} out=${level.toFixed(3)} Δ=${delta.toFixed(3)} ` +
          `bind=${targetNode && targetParam ? `${targetNode}.${targetParam}` : "—"}`,
      );
      runtime.state.lastLogAt = now;
      runtime.state.lastLoggedOut = level;
    }

    if (audio?.url) {
      ctx.report(nodeId, "ready", `out ${level.toFixed(2)}`);
    }

    return { out: level };
  },
});
