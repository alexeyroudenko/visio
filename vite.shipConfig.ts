import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SHIP_FILE = path.resolve(ROOT, "visio.ship.json");
const LEGACY_PRESET_FILE = path.resolve(ROOT, "src/presets/omit.json");
const LEGACY_NODE_FILE = path.resolve(ROOT, "src/nodes/omit.json");

const PRESET_VIRTUAL = "virtual:preset-omit";
const NODE_VIRTUAL = "virtual:node-omit";
const PRESET_RESOLVED = `\0${PRESET_VIRTUAL}`;
const NODE_RESOLVED = `\0${NODE_VIRTUAL}`;

const LOCKED_PRESETS = new Set(["pixel-sort-start"]);
const LOCKED_NODES = new Set(["source.media", "output.screen"]);
const PRESET_ID_OK = /^[a-z0-9][a-z0-9-]{0,80}$/i;
const NODE_ID_OK = /^[a-z][a-z0-9.-]{0,80}$/i;

interface ShipConfig {
  omitPresets: string[];
  omitNodes: string[];
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanIds(raw: unknown, idOk: RegExp, locked: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((id): id is string => typeof id === "string" && idOk.test(id) && !locked.has(id)),
    ),
  ].sort();
}

function readLegacyList(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function emptyConfig(): ShipConfig {
  return { omitPresets: [], omitNodes: [] };
}

function readConfig(): ShipConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SHIP_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyConfig();
    const body = parsed as Partial<ShipConfig>;
    return {
      omitPresets: cleanIds(body.omitPresets, PRESET_ID_OK, LOCKED_PRESETS),
      omitNodes: cleanIds(body.omitNodes, NODE_ID_OK, LOCKED_NODES),
    };
  } catch {
    return {
      omitPresets: cleanIds(readLegacyList(LEGACY_PRESET_FILE), PRESET_ID_OK, LOCKED_PRESETS),
      omitNodes: cleanIds(readLegacyList(LEGACY_NODE_FILE), NODE_ID_OK, LOCKED_NODES),
    };
  }
}

function writeConfig(config: ShipConfig): void {
  fs.writeFileSync(
    SHIP_FILE,
    `${JSON.stringify(
      { omitPresets: config.omitPresets, omitNodes: config.omitNodes },
      null,
      2,
    )}\n`,
  );
}

/**
 * Dev checkboxes → `visio.ship.json` → production filter.
 * One file so a restart of `npm run dev` keeps the same shipped nodes and presets.
 */
export function shipConfig(): Plugin {
  return {
    name: "visio-ship-config",
    resolveId(id) {
      if (id === PRESET_VIRTUAL) return PRESET_RESOLVED;
      if (id === NODE_VIRTUAL) return NODE_RESOLVED;
      return null;
    },
    load(id) {
      const config = readConfig();
      if (id === PRESET_RESOLVED) {
        return `export const OMITTED_PRESET_IDS = ${JSON.stringify(config.omitPresets)};\n`;
      }
      if (id === NODE_RESOLVED) {
        return `export const OMITTED_NODE_TYPES = ${JSON.stringify(config.omitNodes)};\n`;
      }
      return null;
    },
    configureServer(server) {
      server.watcher.add(SHIP_FILE);
      server.watcher.on("change", (file) => {
        if (path.resolve(file) !== SHIP_FILE) return;
        for (const resolved of [PRESET_RESOLVED, NODE_RESOLVED]) {
          const module = server.moduleGraph.getModuleById(resolved);
          if (module) server.moduleGraph.invalidateModule(module);
        }
      });
      server.middlewares.use(async (req, res, next) => {
        const isPreset = req.url === "/__omit-preset";
        const isNode = req.url === "/__omit-node";
        if ((!isPreset && !isNode) || req.method !== "POST") {
          next();
          return;
        }
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as { id?: unknown; ship?: unknown };
          const id = typeof body.id === "string" ? body.id : "";
          const idOk = isPreset ? PRESET_ID_OK : NODE_ID_OK;
          const locked = isPreset ? LOCKED_PRESETS : LOCKED_NODES;
          if (!idOk.test(id)) {
            res.statusCode = 400;
            res.end("bad id");
            return;
          }
          const ship = body.ship !== false;
          if (!ship && locked.has(id)) {
            res.statusCode = 400;
            res.end(isPreset ? "default preset always ships" : "Media and Output always ship");
            return;
          }
          const next = readConfig();
          const list = new Set(isPreset ? next.omitPresets : next.omitNodes);
          if (ship) list.delete(id);
          else list.add(id);
          const omitted = [...list].sort();
          if (isPreset) next.omitPresets = omitted;
          else next.omitNodes = omitted;
          writeConfig(next);
          const resolved = isPreset ? PRESET_RESOLVED : NODE_RESOLVED;
          const module = server.moduleGraph.getModuleById(resolved);
          if (module) server.moduleGraph.invalidateModule(module);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, omitted }));
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : "write failed");
        }
      });
    },
    writeBundle(bundleOptions) {
      const dir = bundleOptions.dir;
      if (!dir) return;
      for (const id of readConfig().omitPresets) {
        fs.rmSync(path.join(dir, "presets", `${id}.jpg`), { force: true });
      }
    },
  };
}
