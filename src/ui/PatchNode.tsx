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

/** One box in the editor: title bar, typed ports, live status dot. */
function PatchNodeView({ id, data, selected }: NodeProps<PatchNodeType>) {
  const definition = NODE_DEFS[data.defType];
  const status = useGraphStore((state) => state.statuses[id]);

  if (!definition) {
    return <div className="node node--missing">неизвестная нода: {data.defType}</div>;
  }

  const accent = CATEGORY_COLORS[definition.category] ?? "#8b8b8b";

  return (
    <div className={`node ${selected ? "node--selected" : ""}`} style={{ borderColor: accent }}>
      <div className="node__title" style={{ background: accent }}>
        <span>{definition.label}</span>
        <span
          className="node__status"
          title={status?.message ?? status?.status ?? "idle"}
          style={{ background: STATUS_DOT[status?.status ?? "idle"] }}
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
