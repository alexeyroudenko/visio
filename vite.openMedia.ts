import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";

const PREFIX = "/__visio/open";
const EVENTS = `${PREFIX}/events`;

const MEDIA_EXT = /^(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|m4v|ogg|mp3|wav|oga|m4a|aac|flac|opus)$/i;

/** Open tabs waiting for something to show — one entry per live EventSource. */
const clients = new Set<ServerResponse>();

function cors(res: ServerResponse): void {
  // The caller is another local app on its own port (media-lib on :8790).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function subscribe(req: IncomingMessage, res: ServerResponse): void {
  cors(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  // Vite sits behind no proxy here, but a tunnel would buffer the stream dead.
  res.setHeader("X-Accel-Buffering", "no");
  res.write(": visio open channel\n\n");
  clients.add(res);

  const beat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      drop();
    }
  }, 25_000);
  function drop(): void {
    clearInterval(beat);
    clients.delete(res);
  }
  req.on("close", drop);
  res.on("close", drop);
}

/** Hands the path to every open tab; the count is what tells the caller whether to open one. */
function dispatch(fsPath: string): number {
  const frame = `data: ${JSON.stringify({ path: fsPath })}\n\n`;
  let sent = 0;
  for (const client of [...clients]) {
    try {
      client.write(frame);
      sent += 1;
    } catch {
      clients.delete(client);
    }
  }
  return sent;
}

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "";
  if (!url.startsWith(PREFIX)) return false;
  const parsed = new URL(url, "http://vite.local");
  if (parsed.pathname !== PREFIX && parsed.pathname !== EVENTS) return false;

  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (parsed.pathname === EVENTS) {
    if (req.method !== "GET") {
      json(res, 405, { error: "GET only" });
      return true;
    }
    subscribe(req, res);
    return true;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    json(res, 405, { error: "GET or POST only" });
    return true;
  }

  const raw = parsed.searchParams.get("path") ?? "";
  if (!raw || raw.includes("\0")) {
    json(res, 400, { error: "missing path" });
    return true;
  }
  const resolved = path.resolve(raw);
  const ext = path.extname(resolved).slice(1);
  if (!MEDIA_EXT.test(ext)) {
    json(res, 415, { error: `unsupported type .${ext || "?"}` });
    return true;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    json(res, 404, { error: "file not found" });
    return true;
  }
  if (!stat.isFile()) {
    json(res, 404, { error: "file not found" });
    return true;
  }

  const delivered = dispatch(resolved);
  json(res, 200, { ok: true, delivered: delivered > 0, clients: delivered, path: resolved });
  return true;
}

function attach(middlewares: Connect.Server): void {
  middlewares.use((req, res, next) => {
    try {
      if (handle(req, res)) return;
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : "open failed" });
      return;
    }
    next();
  });
}

/**
 * Lets another local app hand Visio a file to open: `GET /__visio/open?path=…`
 * pushes the path to every tab listening on `/__visio/open/events`, and the
 * `delivered` flag in the reply tells the caller whether a tab took it or a new
 * one has to be opened (`/?media=…`). The tab then reads the bytes through
 * `/__visio/local-file`, so this is dev and `vite preview` only — the same
 * reason: production has nothing to read the user's disk with.
 */
export function openMedia(): Plugin {
  return {
    name: "visio-open-media",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
