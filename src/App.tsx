import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PatchNode } from "./ui/PatchNode";
import { FloatingInspector } from "./ui/FloatingInspector";
import { Inspector } from "./ui/Inspector";
import { Toolbar } from "./ui/Toolbar";
import { AppConsole } from "./ui/AppConsole";
import { useEngine } from "./ui/useEngine";
import { useFileDrop } from "./ui/useFileDrop";
import { useRecorder } from "./ui/useRecorder";
import { useOfflineRender } from "./ui/useOfflineRender";
import { useOutputWindow } from "./ui/useOutputWindow";
import { Timeline } from "./ui/Timeline";
import { NODE_DEFS } from "./nodes/registry";
import { mediaKind } from "./nodes/shared/fileParam";
import { fitAppWindowOnFirstLaunch } from "./lib/appWindow";
import {
  APP_MARK,
  APP_VERSION_LABEL,
  AUTHOR_FULL,
  AUTHOR_HANDLE,
  AUTHOR_URL,
  WELCOME_CAMERA_LABEL,
  WELCOME_DESKTOP_NOTE,
  WELCOME_HINT,
  WELCOME_PLUS_LABEL,
  WELCOME_TEMPLATE_LABEL,
  welcomeCameraParams,
} from "./lib/appVersion";
import {
  chromeHintDurationMs,
  chromeHintsPending,
  markChromeHintsDone,
} from "./lib/firstRun";
import { sourceMediaStem } from "./lib/mediaName";
import { DEFAULT_PRESET_ID } from "./presets";
import { useGraphStore, type PatchNode as PatchNodeType } from "./store/graphStore";

const LEFT_WIDTH_KEY = "visio.leftWidth";
const RIGHT_WIDTH_KEY = "visio.rightWidth";
const SIDE_MIN = 240;
const SIDE_MAX = 720;

/** True when the browser window is portrait — switches the shell into vertical layout. */
function isPortraitWindow(winW: number, winH: number): boolean {
  return winH > winW;
}

function usePortraitWindow(): boolean {
  const [portrait, setPortrait] = useState(
    () => typeof window !== "undefined" && isPortraitWindow(window.innerWidth, window.innerHeight),
  );
  useEffect(() => {
    const sync = () => setPortrait(isPortraitWindow(window.innerWidth, window.innerHeight));
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return portrait;
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof navigator !== "undefined" && navigator.maxTouchPoints > 0,
  );
  useEffect(() => {
    const sync = () => setCoarse(navigator.maxTouchPoints > 0);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return coarse;
}

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
  /** Hide the dotted grid so the output backdrop reads through. */
  vertical?: boolean;
  /** Coarse pointer — larger wires, tap-to-connect, drag threshold. */
  touch?: boolean;
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
  vertical = false,
  touch = false,
}: GraphCanvasProps) {
  const finger = vertical || touch;
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
      deleteKeyCode={null}
      fitView
      proOptions={{ hideAttribution: false }}
      defaultEdgeOptions={{ animated: true, style: { stroke: "#ffffff", strokeWidth: finger ? 3 : 1.5 } }}
      className={vertical ? "react-flow--vertical" : undefined}
      connectOnClick={finger}
      nodeDragThreshold={finger ? 8 : 0}
      zoomOnPinch
      panOnDrag
      minZoom={0.2}
      maxZoom={2.5}
    >
      {vertical ? null : (
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2e2e2e" />
      )}
      <Controls />
    </ReactFlow>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const width = useGraphStore((state) => state.width);
  const height = useGraphStore((state) => state.height);
  const vertical = usePortraitWindow();
  const touch = useCoarsePointer();
  const { engineRef, error, paused, togglePause, setEnginePaused } = useEngine(
    canvasRef,
    vertical ? "vertical" : "horizontal",
  );
  const { recording, toggle } = useRecorder(() => canvasRef.current);
  const {
    rendering,
    renderingImage,
    progress: renderProgress,
    toggle: toggleRender,
    renderImage,
  } = useOfflineRender(engineRef);
  const outputWindow = useOutputWindow(() => canvasRef.current);

  const dropMediaFiles = useGraphStore((state) => state.dropMediaFiles);
  const loadPreset = useGraphStore((state) => state.loadPreset);
  const setParam = useGraphStore((state) => state.setParam);
  const startWelcomeCamera = useCallback(() => {
    if (!loadPreset(DEFAULT_PRESET_ID)) return;
    const camera = welcomeCameraParams();
    for (const node of useGraphStore.getState().nodes) {
      if (node.data.defType !== "source.media") continue;
      setParam(node.id, "mode", camera.mode);
      setParam(node.id, "facing", camera.facing);
      setParam(node.id, "mirror", camera.mirror);
    }
  }, [loadPreset, setParam]);
  const [presetNudge, setPresetNudge] = useState(0);
  const [openPresetsTick, setOpenPresetsTick] = useState(0);
  const [chromeHint, setChromeHint] = useState(false);
  const [holdUntilPresets, setHoldUntilPresets] = useState(false);
  const sawGraph = useRef<boolean | null>(null);

  const onDropFiles = useCallback(
    (files: File[]) => {
      const empty = useGraphStore.getState().nodes.length === 0;
      const usable = files.some((file) => mediaKind(file));
      if (empty && usable) {
        setHoldUntilPresets(true);
        setEnginePaused(true);
      }
      dropMediaFiles(files);
      if (empty && usable) setPresetNudge((nudge) => nudge + 1);
    },
    [dropMediaFiles, setEnginePaused],
  );
  const dropOver = useFileDrop(onDropFiles);

  const onPresetsGateClose = useCallback(() => {
    setHoldUntilPresets(false);
    setEnginePaused(false);
  }, [setEnginePaused]);

  const ackChromeHint = useCallback(() => {
    setChromeHint(false);
    markChromeHintsDone();
  }, []);

  const onTogglePause = useCallback(() => {
    if (holdUntilPresets) return;
    togglePause();
  }, [holdUntilPresets, togglePause]);

  const nodes = useGraphStore((state) => state.nodes);
  const edges = useGraphStore((state) => state.edges);
  const onNodesChange = useGraphStore((state) => state.onNodesChange);
  const onEdgesChange = useGraphStore((state) => state.onEdgesChange);
  const onConnect = useGraphStore((state) => state.onConnect);
  const select = useGraphStore((state) => state.select);
  // Recompute when the graph changes so captions/downloads follow the open file.
  const mediaStem = sourceMediaStem();

  const nodeTypes = useMemo(() => ({ patch: PatchNode }), []);

  useEffect(() => {
    if (sawGraph.current === null) {
      sawGraph.current = nodes.length > 0;
      return;
    }
    if (sawGraph.current || nodes.length === 0) return;
    sawGraph.current = true;
    if (!chromeHintsPending()) return;
    setChromeHint(true);
    const timer = window.setTimeout(() => {
      setChromeHint(false);
      markChromeHintsDone();
    }, chromeHintDurationMs());
    return () => window.clearTimeout(timer);
  }, [nodes.length]);

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
    fitAppWindowOnFirstLaunch(useGraphStore.getState().width, useGraphStore.getState().height);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, button, [contenteditable='true']")
      ) {
        return;
      }

      if (event.code === "Space") {
        if (event.repeat) return;
        event.preventDefault();
        if (holdUntilPresets) return;
        togglePause();
        return;
      }

      if (event.key !== "Delete") return;
      const { selectedId, removeNode } = useGraphStore.getState();
      if (!selectedId) return;
      event.preventDefault();
      removeNode(selectedId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [holdUntilPresets, togglePause]);

  const stage = (
    <>
      <canvas ref={canvasRef} />
      {error ? <div className="preview__error">{error}</div> : null}
      {paused && !holdUntilPresets ? <div className="preview__paused">❚❚ paused</div> : null}
    </>
  );

  return (
    <div className={`app${vertical ? " app--vertical" : ""}${touch ? " app--touch" : ""}`}>
      {dropOver ? (
        <div className="drop-hint" aria-hidden="true">
          <span>Drop to load — image · video · audio</span>
        </div>
      ) : null}
      {nodes.length === 0 ? (
        <div className="welcome">
          <div className="welcome__copy">
            <div className="welcome__brand">
              <p className="welcome__mark">{APP_MARK}</p>
              <p className="welcome__ver">{APP_VERSION_LABEL}</p>
              <p className="welcome__credit">
                by{" "}
                <a href={AUTHOR_URL} target="_blank" rel="noopener">
                  {AUTHOR_HANDLE}
                </a>{" "}
                ({AUTHOR_FULL})
              </p>
            </div>
            <p className="welcome__hint">{WELCOME_HINT}</p>
            <button
              type="button"
              className="welcome__link"
              onClick={() => loadPreset(DEFAULT_PRESET_ID)}
            >
              {WELCOME_TEMPLATE_LABEL}
            </button>
            <p className="welcome__desktop">{WELCOME_DESKTOP_NOTE}</p>
          </div>
          <button
            type="button"
            className="welcome__plus"
            onClick={() => setOpenPresetsTick((tick) => tick + 1)}
            title="Add output — open the preset grid"
            aria-label="Add output — choose a preset"
          >
            {WELCOME_PLUS_LABEL}
          </button>
          {vertical ? (
            <button type="button" className="welcome__camera" onClick={startWelcomeCamera}>
              {WELCOME_CAMERA_LABEL}
            </button>
          ) : null}
        </div>
      ) : null}
      <Toolbar
        recording={recording}
        onToggleRecord={toggle}
        rendering={rendering}
        renderProgress={renderProgress}
        onToggleRender={toggleRender}
        renderingImage={renderingImage}
        onRenderImage={renderImage}
        paused={paused}
        onTogglePause={onTogglePause}
        hideRecord={vertical}
        presetNudge={presetNudge}
        openPresetsTick={openPresetsTick}
        chromeHint={chromeHint}
        onChromeHintAck={ackChromeHint}
        onPresetsGateClose={onPresetsGateClose}
      />

      <main className="app__body">
        {!vertical ? (
          <>
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
          </>
        ) : null}

        <section className={`editor${vertical ? " editor--vertical" : ""}`}>
          {vertical ? (
            <div className="editor__backdrop" aria-hidden>
              <div
                className="editor__backdrop-frame"
                style={{ aspectRatio: `${width} / ${height}` }}
              >
                {stage}
              </div>
              <span className="editor__backdrop-caption">
                {mediaStem ? `${mediaStem} · ` : null}
                window · {width}×{height}
              </span>
            </div>
          ) : null}

          <div className="editor__graph">
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
                vertical={vertical}
                touch={touch}
              />
            </ReactFlowProvider>
          </div>

          {vertical ? <FloatingInspector /> : null}
        </section>

        {!vertical ? (
          <>
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
                  {stage}
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
          </>
        ) : null}
      </main>

      {!vertical ? <Timeline /> : null}
      {!vertical ? <AppConsole /> : null}

      {vertical ? (
        <div className="shutter-bar" role="toolbar" aria-label="Record">
          <button
            type="button"
            className={`shutter${recording ? " shutter--recording" : ""}`}
            onClick={toggle}
            disabled={paused || rendering}
            title={
              recording
                ? "Stop recording the output"
                : paused
                  ? "Resume playback to record"
                  : "Record the output canvas"
            }
            aria-label={recording ? "Stop recording" : "Record"}
          >
            <span className="shutter__inner" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
