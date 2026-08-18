import type { ParamSpec } from "../engine/types";
import type { ReactNode } from "react";
import { getValueAtFrame, parseParamPath } from "../lib/keyframes";
import { modulatedValue } from "../lib/modulators";
import { NODE_DEFS } from "../nodes/registry";
import { useGraphStore, type PatchNode } from "../store/graphStore";
import { useModulatorStore } from "../store/modulatorStore";
import { useTimelineStore } from "../store/timelineStore";
import { Knob } from "./Knob";

function publishedKnobs(nodes: PatchNode[], published: string[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const items: {
    path: string;
    node: PatchNode;
    nodeLabel: string;
    spec: Extract<ParamSpec, { type: "range" }>;
  }[] = [];
  for (const path of published) {
    const parsed = parseParamPath(path);
    if (!parsed) continue;
    const node = byId.get(parsed.nodeId);
    if (!node) continue;
    const spec = NODE_DEFS[node.data.defType]?.params.find((param) => param.key === parsed.key);
    if (!spec || spec.type !== "range") continue;
    items.push({
      path,
      node,
      nodeLabel: NODE_DEFS[node.data.defType]?.label ?? node.data.defType,
      spec,
    });
  }
  return items;
}

/**
 * Live mixer for params the user published with ↑. Desktop: left column.
 * Phone: a strip under the toolbar. The graph is hidden while this is up.
 */
export function PublishedMixer({ variant = "panel" }: { variant?: "panel" | "bar" }) {
  const nodes = useGraphStore((state) => state.nodes);
  const published = useGraphStore((state) => state.published);
  const setParam = useGraphStore((state) => state.setParam);
  const currentFrame = useTimelineStore((state) => state.currentFrame);
  const paramKeyframes = useTimelineStore((state) => state.paramKeyframes);
  const recordParam = useTimelineStore((state) => state.recordParam);
  const removeParamKeyframe = useTimelineStore((state) => state.removeParamKeyframe);
  const fps = useTimelineStore((state) => state.fps);
  const modulators = useModulatorStore((state) => state.byPath);

  const items = publishedKnobs(nodes, published);
  const frame = Math.round(currentFrame);

  const knobs = items.map(({ path, node, nodeLabel, spec }) => {
    const keys = paramKeyframes[path];
    const animated = !!keys?.length;
    const onFrame = !!keys?.some((key) => key.frame === frame);
    const base = node.data.params[spec.key];
    let value = animated ? getValueAtFrame(frame, base, keys) : base;
    const modulator = modulators[path];
    if (modulator) {
      value = modulatedValue(
        spec,
        typeof value === "number" ? value : spec.default,
        modulator,
        currentFrame / fps,
      );
    }
    const numeric = typeof value === "number" ? value : spec.default;
    const label = variant === "bar" ? `${nodeLabel} ${spec.label}` : spec.label;

    return (
      <div key={path} className="param-block param-block--knob">
        <Knob
          label={label}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={numeric}
          onChange={(next) => setParam(node.id, spec.key, next)}
        />
        <button
          type="button"
          className={`param-key${animated ? " param-key--animated" : ""}${onFrame ? " param-key--on" : ""}`}
          title={
            onFrame
              ? "Remove the keyframe at the playhead"
              : animated
                ? "Key this value at the playhead"
                : "Animate: key this value at the playhead"
          }
          onClick={() => {
            if (keys?.some((key) => key.frame === frame)) {
              removeParamKeyframe(path, frame);
            } else {
              recordParam(node.id, spec.key, numeric);
            }
          }}
        >
          ◆
        </button>
      </div>
    );
  });

  if (variant === "bar") {
    return (
      <div className="published-mixer published-mixer--bar">
        {items.length === 0 ? (
          <p className="published-mixer__empty">
            No published knobs. Turn ⚙ off, then press ↑ on a knob.
          </p>
        ) : (
          knobs
        )}
      </div>
    );
  }

  let lastNode = "";
  const grouped: ReactNode[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.node.id !== lastNode) {
      lastNode = item.node.id;
      grouped.push(
        <p key={`h-${item.node.id}`} className="published-mixer__node">
          {item.nodeLabel}
        </p>,
      );
    }
    grouped.push(knobs[i]);
  }

  return (
    <aside className="published-mixer">
      <header className="inspector__header">
        <div>
          <h2>Patch</h2>
          <span className="inspector__category">Performance</span>
        </div>
      </header>
      {items.length === 0 ? (
        <p className="inspector__empty">
          No published knobs. Turn ⚙ off, then press ↑ on a knob to put it here.
        </p>
      ) : (
        <div className="inspector__params">{grouped}</div>
      )}
    </aside>
  );
}
