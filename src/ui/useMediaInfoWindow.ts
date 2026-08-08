import { useCallback, useEffect, useRef } from "react";

import { useMediaInfoStore, type MediaInfo } from "../store/mediaInfoStore";
import { mediaInfoRows, type InfoGroup, type InfoRow } from "./MediaInfoPanel";

const WINDOW_NAME = "visio-media-info";

/**
 * The playhead rows move every frame, so the window polls instead of waiting on
 * a store subscription — at four reads a second off an in-memory object the cost
 * is nothing, and there is no way to miss an update that lands mid-render.
 */
const REFRESH_MS = 250;

const GROUPS: { id: InfoGroup; title: string }[] = [
  { id: "stream", title: "Stream" },
  { id: "capture", title: "Capture" },
  { id: "playback", title: "Playback" },
];

const DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>visio — media info</title>
    <style>
      :root { color-scheme: dark; }
      html, body { margin: 0; height: 100%; }
      body {
        background: #0d0f14;
        color: #e6e8ee;
        font: 13px/1.5 ui-sans-serif, system-ui, sans-serif;
        display: flex;
        flex-direction: column;
      }
      header {
        display: flex;
        align-items: baseline;
        gap: 12px;
        padding: 14px 18px 12px;
        border-bottom: 1px solid #232733;
      }
      h1 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        flex: 1 1 auto;
        overflow-wrap: anywhere;
      }
      button {
        flex: 0 0 auto;
        padding: 4px 10px;
        border: 1px solid #2f3543;
        border-radius: 3px;
        background: #161a22;
        color: #b6bcca;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      button:hover { border-color: #4a5162; color: #e6e8ee; }
      main { flex: 1 1 auto; overflow-y: auto; padding: 4px 18px 24px; }
      section { margin-top: 16px; }
      h2 {
        margin: 0 0 6px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #6b7280;
      }
      dl {
        margin: 0;
        display: grid;
        grid-template-columns: minmax(90px, max-content) 1fr;
        gap: 3px 16px;
      }
      dt {
        color: #8b92a3;
        font-size: 11px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        padding-top: 1px;
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
        font-variant-numeric: tabular-nums;
      }
      a { color: #7fb2e3; }
      #map { display: inline-block; margin-top: 8px; font-size: 12px; }
      #map[hidden] { display: none; }
      .empty { color: #6b7280; }
    </style>
  </head>
  <body>
    <header>
      <h1 id="title"></h1>
      <button id="copy" type="button">Copy JSON</button>
    </header>
    <main>
      <div id="rows"></div>
      <a id="map" hidden target="_blank" rel="noreferrer noopener">Open location in map</a>
    </main>
  </body>
</html>`;

/**
 * Detached read-out of everything the Media probe pulled from a file.
 *
 * The Inspector panel has to fit a sidebar and truncates a lens model to an
 * ellipsis; this window wraps, groups, and can be left open on a second screen
 * while the patch runs.
 */
export function useMediaInfoWindow() {
  const popupRef = useRef<Window | null>(null);
  const targetRef = useRef<string | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);

  const close = useCallback(() => {
    if (timerRef.current != null) popupRef.current?.clearInterval(timerRef.current);
    timerRef.current = null;
    renderRef.current = null;
    popupRef.current?.close();
    popupRef.current = null;
    targetRef.current = null;
  }, []);

  const open = useCallback((nodeId: string) => {
    targetRef.current = nodeId;

    // Already open — repoint it at the node just selected rather than stacking
    // one window per node.
    if (popupRef.current && !popupRef.current.closed) {
      renderRef.current?.();
      popupRef.current.focus();
      return;
    }

    const popup = window.open("", WINDOW_NAME, "width=560,height=760");
    if (!popup) {
      window.alert("Browser blocked the info window — allow pop-ups for this site.");
      return;
    }
    popup.document.write(DOCUMENT);
    popup.document.close();

    const doc = popup.document;
    const titleEl = doc.getElementById("title")!;
    const host = doc.getElementById("rows")!;
    const mapLink = doc.getElementById("map") as HTMLAnchorElement;
    const copyButton = doc.getElementById("copy") as HTMLButtonElement;

    let valueNodes = new Map<string, HTMLElement>();
    let signature = "";

    const render = () => {
      const info = currentInfo(targetRef.current);
      const rows = info ? mediaInfoRows(info) : [];
      const nextSignature = rows.map((row) => `${row.group ?? "stream"}:${row.label}`).join("|");
      if (nextSignature !== signature) {
        signature = nextSignature;
        valueNodes = buildRows(doc, host, rows, mapLink);
      }
      for (const row of rows) {
        const node = valueNodes.get(row.label);
        // Writing an unchanged string still replaces the text node and would
        // drop a selection the user is in the middle of making.
        if (node && node.textContent !== row.value) node.textContent = row.value;
      }
      titleEl.textContent = info ? (info.name ?? `${info.kind} source`) : "No source";
      applyMapLink(mapLink, info);
    };

    copyButton.addEventListener("click", () => {
      const info = currentInfo(targetRef.current);
      if (!info) return;
      void popup.navigator.clipboard
        .writeText(JSON.stringify(info, null, 2))
        .then(() => flash(popup, copyButton, "Copied"))
        .catch(() => flash(popup, copyButton, "Copy blocked"));
    });

    render();
    const timer = popup.setInterval(render, REFRESH_MS);

    popup.addEventListener("pagehide", () => {
      popup.clearInterval(timer);
      if (popupRef.current === popup) {
        popupRef.current = null;
        renderRef.current = null;
        timerRef.current = null;
      }
    });

    popupRef.current = popup;
    renderRef.current = render;
    timerRef.current = timer;
  }, []);

  // Never leave an orphaned window behind when the app unmounts.
  useEffect(() => close, [close]);

  return { open, close };
}

function currentInfo(nodeId: string | null): MediaInfo | null {
  if (!nodeId) return null;
  return useMediaInfoStore.getState().byId[nodeId] ?? null;
}

/** Rebuilds the table and returns the value cells, keyed by their label. */
export function buildRows(
  doc: Document,
  host: HTMLElement,
  rows: InfoRow[],
  /** Moved under the Capture group, where the coordinates it points at are. */
  mapLink?: HTMLElement,
): Map<string, HTMLElement> {
  const values = new Map<string, HTMLElement>();
  host.replaceChildren();

  if (rows.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "empty";
    empty.textContent = "This Media node has no source right now.";
    host.append(empty);
    return values;
  }

  for (const group of GROUPS) {
    const groupRows = rows.filter((row) => (row.group ?? "stream") === group.id);
    if (groupRows.length === 0) continue;

    const heading = doc.createElement("h2");
    heading.textContent = group.title;
    const list = doc.createElement("dl");
    for (const row of groupRows) {
      const term = doc.createElement("dt");
      term.textContent = row.label;
      const value = doc.createElement("dd");
      list.append(term, value);
      values.set(row.label, value);
    }

    const section = doc.createElement("section");
    section.append(heading, list);
    if (group.id === "capture" && mapLink) section.append(mapLink);
    host.append(section);
  }

  // A source with no capture group at all would otherwise strand the link in
  // the section that just got replaced.
  if (mapLink && !mapLink.isConnected) host.append(mapLink);
  return values;
}

function applyMapLink(link: HTMLAnchorElement, info: MediaInfo | null): void {
  const lat = info?.latitude;
  const lon = info?.longitude;
  if (lat == null || lon == null) {
    link.hidden = true;
    return;
  }
  link.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
  link.hidden = false;
}

function flash(popup: Window, button: HTMLButtonElement, message: string): void {
  const original = "Copy JSON";
  button.textContent = message;
  popup.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}
