import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { PatchNode } from "./ui/PatchNode";
import { Inspector } from "./ui/Inspector";
import { Toolbar } from "./ui/Toolbar";
import { AppConsole } from "./ui/AppConsole";
import { useEngine } from "./ui/useEngine";
import { useRecorder } from "./ui/useRecorder";
import { useOfflineRender } from "./ui/useOfflineRender";
import { useOutputWindow } from "./ui/useOutputWindow";
import { Timeline } from "./ui/Timeline";
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

function mediaKind(file: File): "image" | "video" | "audio" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  const lower = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/.test(lower)) return "image";
  if (/\.(mp4|webm|mov|m4v|ogg)$/.test(lower)) return "video";
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(lower)) return "audio";
  return null;
}

interface GraphCanvasProps {
  nodes: PatchNodeType[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  onNodesChange: (changes: NodeChange<PatchNodeType>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onNodeClick: NodeMouseHandler<PatchNodeType>;
  onNodeDoubleClick: NodeMouseHandler<PatchNodeType>;
  onPaneClick: () => void;
}

function GraphCanvas({
  nodes,
  edges,
  nodeTypes,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onNodeDoubleClick,
  onPaneClick,
}: GraphCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const addNode = useGraphStore((state) => state.addNode);

  const onDragOver = useCallback((event: DragEvent) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;

      const origin = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      let offset = 0;
      for (const file of files) {
        const kind = mediaKind(file);
        if (!kind) continue;
        addNode(
          "source.media",
          { x: origin.x + offset, y: origin.y + offset },
          {
            mode: kind,
            file: { name: file.name, url: URL.createObjectURL(file), mime: file.type || undefined },
            mirror: false,
          },
        );
        offset += 48;
      }
    },
    [addNode, screenToFlowPosition],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onPaneClick={onPaneClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
      deleteKeyCode={null}
      fitView
      proOptions={{ hideAttribution: false }}
      defaultEdgeOptions={{ animated: true, style: { stroke: "#6b8afd", strokeWidth: 1.5 } }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2f3a" />
      <Controls />
    </ReactFlow>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { engineRef, error, paused, togglePause } = useEngine(canvasRef);
  const { recording, toggle } = useRecorder(() => canvasRef.current);
  const { rendering, progress: renderProgress, toggle: toggleRender } = useOfflineRender(engineRef);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const { selectedId, removeNode } = useGraphStore.getState();
      if (!selectedId) return;
      event.preventDefault();
      removeNode(selectedId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="app">
      <Toolbar
        recording={recording}
        onToggleRecord={toggle}
        rendering={rendering}
        renderProgress={renderProgress}
        onToggleRender={toggleRender}
        paused={paused}
        onTogglePause={togglePause}
      />

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
          aria-label="Inspector width"
          title="Drag · double-click to reset"
        />

        <section className="editor">
          <ReactFlowProvider>
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onPaneClick={() => select(null)}
            />
          </ReactFlowProvider>
        </section>

        <div
          className="splitter"
          onPointerDown={startRightResize}
          onDoubleClick={() => setRightWidth(380)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Output width"
          title="Drag · double-click to reset"
        />

        <section className="side side--right" style={{ width: rightWidth }}>
          <div className="preview preview--fill">
            <div className="preview__frame" style={{ aspectRatio: `${width} / ${height}` }}>
              <canvas ref={canvasRef} />
              {error ? <div className="preview__error">{error}</div> : null}
              {paused ? <div className="preview__paused">❚❚ paused</div> : null}
            </div>
            <div className="preview__bar">
              <span className="preview__caption">
                output · {width}×{height}
              </span>
              <button type="button" className="button button--small" onClick={outputWindow.open}>
                Output window
              </button>
            </div>
          </div>
        </section>
      </main>

      <Timeline />

      <AppConsole />
    </div>
  );
}
