import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";

const PREFIX = "/__visio/local-file";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogg: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
};

const MEDIA_EXT = /^(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|m4v|ogg|mp3|wav|oga|m4a|aac|flac|opus)$/i;

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "";
  if (!url.startsWith(PREFIX)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "GET only");
    return true;
  }

  const parsed = new URL(url, "http://vite.local");
  const raw = parsed.searchParams.get("path") ?? "";
  if (!raw || raw.includes("\0")) {
    send(res, 400, "missing path");
    return true;
  }

  const resolved = path.resolve(raw);
  const ext = path.extname(resolved).slice(1);
  if (!MEDIA_EXT.test(ext)) {
    send(res, 415, `unsupported type .${ext || "?"}`);
    return true;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    send(res, 404, "file not found");
    return true;
  }
  if (!stat.isFile()) {
    send(res, 404, "file not found");
    return true;
  }

  const mime = MIME[ext.toLowerCase()] ?? "application/octet-stream";
  const name = path.basename(resolved);
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(resolved).on("error", () => {
    if (!res.headersSent) send(res, 500, "read failed");
    else res.destroy();
  }).pipe(res);
  return true;
}

function attach(middlewares: Connect.Server): void {
  middlewares.use((req, res, next) => {
    try {
      if (handle(req, res)) return;
    } catch (error) {
      send(res, 500, error instanceof Error ? error.message : "read failed");
      return;
    }
    next();
  });
}

/**
 * Serves a local image/video/audio by absolute path so the Media inspector can
 * Load a pasted Explorer path. Dev and `vite preview` only — production has
 * nothing to read the user's disk with.
 */
export function localFile(): Plugin {
  return {
    name: "visio-local-file",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
