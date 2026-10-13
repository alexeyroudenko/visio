import type { ParamSpec } from "../engine/types";
import { getValueAtFrame, parseParamPath } from "../lib/keyframes";
import { modulatedValue } from "../lib/modulators";
import { NODE_DEFS } from "../nodes/registry";
import { useGraphStore, type PatchNode } from "../store/graphStore";
import { useModulatorStore } from "../store/modulatorStore";
import { useTimelineStore } from "../store/timelineStore";
import { Knob } from "./Knob";

type PublishedRange = {
  kind: "range";
  path: string;
  node: PatchNode;
  nodeLabel: string;
  spec: Extract<ParamSpec, { type: "range" }>;
};

type PublishedToggle = {
  kind: "toggle";
  path: string;
  node: PatchNode;
  nodeLabel: string;
  spec: Extract<ParamSpec, { type: "toggle" }>;
};

type PublishedItem = PublishedRange | PublishedToggle;

function publishedItems(nodes: PatchNode[], published: string[]): PublishedItem[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const items: PublishedItem[] = [];
  for (const path of published) {
    const parsed = parseParamPath(path);
    if (!parsed) continue;
    const node = byId.get(parsed.nodeId);
    if (!node) continue;
    const spec = NODE_DEFS[node.data.defType]?.params.find((param) => param.key === parsed.key);
    if (!spec) continue;
    const nodeLabel = NODE_DEFS[node.data.defType]?.label ?? node.data.defType;
    if (spec.type === "range") {
      items.push({ kind: "range", path, node, nodeLabel, spec });
    } else if (spec.type === "toggle") {
      items.push({ kind: "toggle", path, node, nodeLabel, spec });
    }
  }
  return items;
}

/**
 * Live mixer for params the user published with ↑. Desktop: left column.
 * Phone: a strip under the toolbar. The graph is hidden while this is up.
 * Ranges become knobs; toggles become checkboxes (e.g. Datamosh4 Auto / Latch).
 * Params render sequentially in one panel (publish order), not grouped by node.
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

  const items = publishedItems(nodes, published);
  const frame = Math.round(currentFrame);
  const compact = variant === "bar";
  const knobSize = compact ? 32 : 44;

  const renderToggle = (item: PublishedToggle) => {
    const { path, node, nodeLabel, spec } = item;
    const base = node.data.params[spec.key];
    const value = typeof base === "boolean" ? base : spec.default;
    return (
      <div
        key={path}
        className="param-block param-block--toggle"
        title={`${nodeLabel} · ${spec.label}`}
      >
        <label className="param param--row">
          <input
            type="checkbox"
            checked={value}
            onChange={(event) => setParam(node.id, spec.key, event.target.checked)}
          />
          <span className="param__label">{spec.label}</span>
        </label>
      </div>
    );
  };

  const renderKnob = (item: PublishedRange) => {
    const { path, node, nodeLabel, spec } = item;
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

    return (
      <div key={path} className="param-block param-block--knob" title={`${nodeLabel} · ${spec.label}`}>
        <Knob
          label={spec.label}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={numeric}
          onChange={(next) => setParam(node.id, spec.key, next)}
          size={knobSize}
          publish
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
  };

  const list =
    items.length === 0 ? null : (
      <div className="published-mixer__list">
        {items.map((item) => (item.kind === "toggle" ? renderToggle(item) : renderKnob(item)))}
      </div>
    );

  if (variant === "bar") {
    return (
      <div className="published-mixer published-mixer--bar">
        {items.length === 0 ? (
          <p className="published-mixer__empty">
            No published controls. Turn ⚙ off, then press ↑ on a knob or checkbox.
          </p>
        ) : (
          list
        )}
      </div>
    );
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
          No published controls. Turn ⚙ off, then press ↑ on a knob or checkbox to put it here.
        </p>
      ) : (
        <div className="inspector__params inspector__params--mixer">{list}</div>
      )}
    </aside>
  );
}
