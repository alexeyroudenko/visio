import type { ParamSpec } from "../engine/types";
import type { ReactNode } from "react";
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

type PublishedGroup = {
  nodeId: string;
  nodeLabel: string;
  toggles: PublishedToggle[];
  ranges: PublishedRange[];
};

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

/** Keep publish order, but cluster by node — toggles then knobs inside each. */
function groupPublished(items: PublishedItem[]): PublishedGroup[] {
  const groups: PublishedGroup[] = [];
  const indexById = new Map<string, number>();
  for (const item of items) {
    let index = indexById.get(item.node.id);
    if (index === undefined) {
      index = groups.length;
      indexById.set(item.node.id, index);
      groups.push({
        nodeId: item.node.id,
        nodeLabel: item.nodeLabel,
        toggles: [],
        ranges: [],
      });
    }
    const group = groups[index]!;
    if (item.kind === "toggle") group.toggles.push(item);
    else group.ranges.push(item);
  }
  return groups;
}

/**
 * Live mixer for params the user published with ↑. Desktop: left column.
 * Phone: a strip under the toolbar. The graph is hidden while this is up.
 * Ranges become knobs; toggles become checkboxes (e.g. Datamosh4 Auto / Latch).
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
  const groups = groupPublished(items);
  const frame = Math.round(currentFrame);

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

  if (variant === "bar") {
    return (
      <div className="published-mixer published-mixer--bar">
        {groups.length === 0 ? (
          <p className="published-mixer__empty">
            No published controls. Turn ⚙ off, then press ↑ on a knob or checkbox.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.nodeId} className="published-mixer__group" aria-label={group.nodeLabel}>
              <header className="published-mixer__group-head">{group.nodeLabel}</header>
              {group.toggles.length > 0 ? (
                <div className="published-mixer__group-toggles">
                  {group.toggles.map((item) => renderToggle(item))}
                </div>
              ) : null}
              {group.ranges.length > 0 ? (
                <div className="published-mixer__group-knobs">
                  {group.ranges.map((item) => renderKnob(item))}
                </div>
              ) : null}
            </section>
          ))
        )}
      </div>
    );
  }

  const grouped: ReactNode[] = [];
  for (const group of groups) {
    grouped.push(
      <section key={group.nodeId} className="published-mixer__cluster">
        <p className="published-mixer__node">{group.nodeLabel}</p>
        {group.toggles.length > 0 ? (
          <div className="published-mixer__cluster-toggles">
            {group.toggles.map((item) => renderToggle(item))}
          </div>
        ) : null}
        {group.ranges.length > 0 ? (
          <div className="published-mixer__cluster-knobs">
            {group.ranges.map((item) => renderKnob(item))}
          </div>
        ) : null}
      </section>,
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
      {groups.length === 0 ? (
        <p className="inspector__empty">
          No published controls. Turn ⚙ off, then press ↑ on a knob or checkbox to put it here.
        </p>
      ) : (
        <div className="inspector__params inspector__params--mixer">{grouped}</div>
      )}
    </aside>
  );
}
