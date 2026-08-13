import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_DIR = path.resolve(ROOT, "src/presets/overrides");
const VIRTUAL_ID = "virtual:preset-overrides";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const ID_OK = /^[a-z0-9][a-z0-9-]{0,80}$/i;

/** Standalone builtin sources — Save rewrites these so git sees the patch. */
const FILE_MAP: Record<string, { file: string; exportName: string }> = {
  "pixel-sort-start": { file: "src/presets/pixelSortStart.ts", exportName: "pixelSortStart" },
  "particles-feedback": { file: "src/presets/particlesFeedback.ts", exportName: "particlesFeedback" },
  "particles-feedback-closeup": {
    file: "src/presets/particlesFeedbackCloseup.ts",
    exportName: "particlesFeedbackCloseup",
  },
  "noise-element-grid": { file: "src/presets/noiseElementGrid.ts", exportName: "noiseElementGrid" },
  "track-noise-glitch": { file: "src/presets/trackNoiseGlitch.ts", exportName: "trackNoiseGlitch" },
};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isPatch(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const patch = value as { format?: unknown; nodes?: unknown; edges?: unknown };
  return patch.format === 1 && Array.isArray(patch.nodes) && Array.isArray(patch.edges);
}

function readOverrides(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fs.existsSync(OVERRIDES_DIR)) return out;
  for (const name of fs.readdirSync(OVERRIDES_DIR)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!ID_OK.test(id)) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(OVERRIDES_DIR, name), "utf8"));
      if (isPatch(parsed)) out[id] = parsed;
    } catch {
      /* skip a broken file rather than taking the whole catalog down */
    }
  }
  return out;
}

function writeTsModule(exportName: string, patch: unknown): string {
  return `import type { SerializedPatch } from "../store/persistence";

export function ${exportName}(): SerializedPatch {
  return ${JSON.stringify(patch, null, 2)};
}
`;
}

/**
 * Virtual module ships in production so builtins pick up saved overrides.
 * The POST endpoint is serve-only (`configureServer`).
 */
export function presetSave(): Plugin {
  return {
    name: "visio-preset-save",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export const PRESET_OVERRIDES = ${JSON.stringify(readOverrides())};\n`;
    },
    configureServer(server) {
      if (fs.existsSync(OVERRIDES_DIR)) server.watcher.add(OVERRIDES_DIR);
      server.watcher.on("change", (file) => {
        if (!file.replace(/\\/g, "/").includes("/src/presets/overrides/")) return;
        const module = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (module) server.moduleGraph.invalidateModule(module);
      });
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__save-builtin-preset" || req.method !== "POST") {
          next();
          return;
        }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { id?: unknown; patch?: unknown };
          const id = typeof body.id === "string" ? body.id : "";
          if (!ID_OK.test(id) || !isPatch(body.patch)) {
            res.statusCode = 400;
            res.end("bad id or patch");
            return;
          }
          fs.mkdirSync(OVERRIDES_DIR, { recursive: true });
          server.watcher.add(OVERRIDES_DIR);
          fs.writeFileSync(
            path.join(OVERRIDES_DIR, `${id}.json`),
            `${JSON.stringify(body.patch, null, 2)}\n`,
          );
          const mapped = FILE_MAP[id];
          if (mapped) {
            fs.writeFileSync(path.resolve(ROOT, mapped.file), writeTsModule(mapped.exportName, body.patch));
          }
          const module = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (module) server.moduleGraph.invalidateModule(module);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, id, file: mapped?.file ?? `src/presets/overrides/${id}.json` }));
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : "write failed");
        }
      });
    },
  };
}
