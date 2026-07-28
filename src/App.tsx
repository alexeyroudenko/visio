import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PatchNode } from "./ui/PatchNode";
import { Inspector } from "./ui/Inspector";
import { Toolbar } from "./ui/Toolbar";
import { useEngine } from "./ui/useEngine";
import { useRecorder } from "./ui/useRecorder";
import { useOutputWindow } from "./ui/useOutputWindow";
import { NODE_DEFS } from "./nodes/registry";
import { useGraphStore, type PatchNode as PatchNodeType } from "./store/graphStore";

const LEFT_WIDTH_KEY = "visio.leftWidth";
const RIGHT_WIDTH_KEY = "visio.rightWidth";
const SIDE_MIN = 240;
const SIDE_MAX = 720;

function loadWidth(key: string, fallback: number): number {
  const saved = Number(localStorage.getItem(key));
  if (!Number.isFinite(saved) || saved <= 0) return fallback;
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, saved));
}

function useSideResize(
  key: string,
  side: "left" | "right",
  width: number,
  setWidth: (n: number) => void,
) {
  useEffect(() => {
    localStorage.setItem(key, String(Math.round(width)));
  }, [key, width]);

  return useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const onMove = (moveEvent: PointerEvent) => {
        const next =
          side === "left" ? moveEvent.clientX : window.innerWidth - moveEvent.clientX;
        setWidth(Math.min(SIDE_MAX, Math.max(SIDE_MIN, next)));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("is-resizing");
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.classList.add("is-resizing");
    },
    [setWidth, side],
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { error, stats } = useEngine(canvasRef);
  const { recording, toggle } = useRecorder(() => canvasRef.current);
  const outputWindow = useOutputWindow(() => canvasRef.current);

  const nodes = useGraphStore((state) => state.nodes);
  const edges = useGraphStore((state) => state.edges);
  const onNodesChange = useGraphStore((state) => state.onNodesChange);
  const onEdgesChange = useGraphStore((state) => state.onEdgesChange);
  const onConnect = useGraphStore((state) => state.onConnect);
  const select = useGraphStore((state) => state.select);
  const width = useGraphStore((state) => state.width);
  const height = useGraphStore((state) => state.height);

  const nodeTypes = useMemo(() => ({ patch: PatchNode }), []);

  const [leftWidth, setLeftWidth] = useState(() => loadWidth(LEFT_WIDTH_KEY, 300));
  const [rightWidth, setRightWidth] = useState(() => loadWidth(RIGHT_WIDTH_KEY, 380));
  const startLeftResize = useSideResize(LEFT_WIDTH_KEY, "left", leftWidth, setLeftWidth);
  const startRightResize = useSideResize(RIGHT_WIDTH_KEY, "right", rightWidth, setRightWidth);

  const onNodeClick = useCallback<NodeMouseHandler<PatchNodeType>>(
    (_event, node) => select(node.id),
    [select],
  );

  const onNodeDoubleClick = useCallback<NodeMouseHandler<PatchNodeType>>(
    (_event, node) => {
      if (NODE_DEFS[node.data.defType]?.category === "output") outputWindow.open();
    },
    [outputWindow],
  );

  return (
    <div className="app">
      <Toolbar stats={stats} recording={recording} onToggleRecord={toggle} />

      <main className="app__body">
        <aside className="side side--left" style={{ width: leftWidth }}>
          <Inspector />
        </aside>

        <div
          className="splitter"
          onPointerDown={startLeftResize}
          onDoubleClick={() => setLeftWidth(300)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Ширина параметров"
          title="Тяни · двойной клик — сбросить"
        />

        <section className="editor">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onPaneClick={() => select(null)}
              fitView
              proOptions={{ hideAttribution: false }}
              defaultEdgeOptions={{ animated: true, style: { stroke: "#6ea8fe", strokeWidth: 2 } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2f3a" />
              <Controls />
            </ReactFlow>
          </ReactFlowProvider>
        </section>

        <div
          className="splitter"
          onPointerDown={startRightResize}
          onDoubleClick={() => setRightWidth(380)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Ширина вывода"
          title="Тяни · двойной клик — сбросить"
        />

        <section className="side side--right" style={{ width: rightWidth }}>
          <div className="preview preview--fill">
            <div className="preview__frame" style={{ aspectRatio: `${width} / ${height}` }}>
              <canvas ref={canvasRef} />
              {error ? <div className="preview__error">{error}</div> : null}
            </div>
            <div className="preview__bar">
              <span className="preview__caption">
                выход · {width}×{height}
              </span>
              <button type="button" className="button button--small" onClick={outputWindow.open}>
                Окно вывода
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
