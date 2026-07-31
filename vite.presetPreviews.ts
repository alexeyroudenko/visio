import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.resolve(ROOT, "public/presets");

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Dev-only: POST /__save-preset-preview { id, dataUrl } → public/presets/<id>.jpg
 * Used by window.__visioCapturePresetPreviews while collecting picker thumbs.
 */
export function presetPreviewWriter(): Plugin {
  return {
    name: "visio-preset-preview-writer",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__save-preset-preview" || req.method !== "POST") {
          next();
          return;
        }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { id?: unknown; dataUrl?: unknown };
          const id = typeof body.id === "string" ? body.id : "";
          const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
          if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(id)) {
            res.statusCode = 400;
            res.end("bad id");
            return;
          }
          const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
          if (!match) {
            res.statusCode = 400;
            res.end("bad dataUrl");
            return;
          }
          fs.mkdirSync(PRESETS_DIR, { recursive: true });
          const file = path.join(PRESETS_DIR, `${id}.jpg`);
          fs.writeFileSync(file, Buffer.from(match[1], "base64"));
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, file: `presets/${id}.jpg` }));
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : "write failed");
        }
      });
    },
  };
}
