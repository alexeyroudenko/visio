import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { CATEGORY_COLORS, NODE_DEFS, PORT_COLORS } from "../nodes/registry";
import { useGraphStore, type PatchNode as PatchNodeType } from "../store/graphStore";

const STATUS_DOT: Record<string, string> = {
  idle: "#6b7280",
  loading: "#ffd166",
  ready: "#7fe3c0",
  error: "#ff5c7a",
};

/** One box in the editor: title bar, typed ports, live status / bypass dot. */
function PatchNodeView({ id, data, selected }: NodeProps<PatchNodeType>) {
  const definition = NODE_DEFS[data.defType];
  const status = useGraphStore((state) => state.statuses[id]);
  const setBypass = useGraphStore((state) => state.setBypass);
  const bypassed = data.bypass === true;

  if (!definition) {
    return <div className="node node--missing">unknown node: {data.defType}</div>;
  }

  const accent = CATEGORY_COLORS[definition.category] ?? "#8b8b8b";
  const statusKey = status?.status ?? "idle";

  return (
    <div
      className={`node ${selected ? "node--selected" : ""} ${bypassed ? "node--bypassed" : ""}`}
      style={{ borderColor: accent }}
    >
      <div className="node__title" style={{ background: accent }}>
        <span>{definition.label}</span>
        <button
          type="button"
          className={`node__bypass nodrag nopan ${bypassed ? "node__bypass--on" : ""}`}
          title={bypassed ? "Bypass on — click to enable" : `${statusKey} — click: bypass`}
          aria-pressed={bypassed}
          style={bypassed ? undefined : { background: STATUS_DOT[statusKey] }}
          onClick={(event) => {
            event.stopPropagation();
            setBypass(id, !bypassed);
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      </div>

      <div className="node__ports">
        <div className="node__column">
          {definition.inputs.map((port) => (
            <div className="node__port" key={port.id}>
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                style={{ background: PORT_COLORS[port.type] ?? "#888" }}
              />
              <span>{port.label}</span>
            </div>
          ))}
        </div>

        <div className="node__column">
          {definition.outputs.map((port) => (
            <div className="node__port node__port--out" key={port.id}>
              <span>{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                style={{ background: PORT_COLORS[port.type] ?? "#888" }}
              />
            </div>
          ))}
        </div>
      </div>

      {status?.message ? <div className="node__message">{status.message}</div> : null}
    </div>
  );
}

export const PatchNode = memo(PatchNodeView);
