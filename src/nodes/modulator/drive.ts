import {
  parseModulatorBinds,
  parseModulatorDriveConfig,
} from "../../lib/modulatorBindings";
import {
  AUDIO_BAND_PRESETS,
  DEFAULT_MODULATOR,
  MODULATOR_SHAPES,
  MODULATOR_SOURCES,
} from "../../lib/modulators";
import { defineNode } from "../defineNode";

/**
 * Shared LFO / audio drive on the graph. Soft-binds in `binds[]` map the same
 * −1..1 wave onto any other nodes' range params (Inspector + / −).
 *
 * No ports — routing is Inspector soft-binds, like Audio Analyzer. The engine
 * applies drives in pushGraph / export before analyzer overrides.
 */
export const modulatorDriveNode = defineNode<Record<string, never>>({
  type: "modulator.drive",
  label: "Modulator",
  category: "audio",
  description:
    "One LFO or audio band that can drive several parameters — add bindings in the Inspector.",
  inputs: [],
  outputs: [],
  params: [
    {
      key: "source",
      label: "Source",
      type: "select",
      options: MODULATOR_SOURCES.map((s) => ({ value: s.value, label: s.label })),
      default: DEFAULT_MODULATOR.source,
    },
    {
      key: "shape",
      label: "Shape",
      type: "select",
      options: MODULATOR_SHAPES.map((s) => ({ value: s.value, label: s.label })),
      default: DEFAULT_MODULATOR.shape,
    },
    {
      key: "rateHz",
      label: "Rate Hz",
      type: "range",
      min: 0,
      max: 8,
      step: 0.01,
      default: DEFAULT_MODULATOR.rateHz,
    },
    {
      key: "phase",
      label: "Phase",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: DEFAULT_MODULATOR.phase,
    },
    {
      key: "bandLoHz",
      label: "Band min Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: DEFAULT_MODULATOR.bandLoHz ?? AUDIO_BAND_PRESETS[0]!.lo,
    },
    {
      key: "bandHiHz",
      label: "Band max Hz",
      type: "range",
      min: 20,
      max: 8000,
      step: 10,
      default: DEFAULT_MODULATOR.bandHiHz ?? AUDIO_BAND_PRESETS[0]!.hi,
    },
    { key: "binds", label: "Bindings", type: "json", default: [] },
  ],
  createState: () => ({}),
  evaluate({ params, nodeId, ctx, debug }) {
    const config = parseModulatorDriveConfig(params);
    const binds = parseModulatorBinds(params);
    const active = binds.filter((b) => b.targetNode && b.targetParam).length;
    const detail =
      config.source === "audio"
        ? `audio ${config.bandLoHz ?? 20}–${config.bandHiHz ?? 200} Hz · ${active} bind${active === 1 ? "" : "s"}`
        : `${config.shape} ${config.rateHz.toFixed(2)} Hz · ${active} bind${active === 1 ? "" : "s"}`;
    ctx.report(nodeId, "ready", detail);
    if (debug) {
      ctx.debugRows(nodeId, [
        { label: "source", value: config.source },
        {
          label: "wave",
          value:
            config.source === "audio"
              ? `${config.bandLoHz ?? 20}–${config.bandHiHz ?? 200}`
              : `${config.shape} @ ${config.rateHz}Hz`,
        },
        { label: "binds", value: String(active) },
      ]);
    }
    return {};
  },
});
