import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.resolve(ROOT, "public/imgs");
const VIRTUAL_ID = "virtual:image-library";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

function listImages(): string[] {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs
    .readdirSync(IMAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXT.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Feeds the Media inspector's image library from `public/imgs`: drop a file in,
 * it shows up. The names are read at config/serve time rather than globbed from
 * the client, because `public/` is copied verbatim and never seen by the bundler.
 */
export function imageLibrary(): Plugin {
  return {
    name: "visio-image-library",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export const IMAGE_LIBRARY_FILES = ${JSON.stringify(listImages())};\n`;
    },
    configureServer(server) {
      server.watcher.add(IMAGES_DIR);
      const refresh = (file: string) => {
        if (path.dirname(path.resolve(file)) !== IMAGES_DIR) return;
        if (!IMAGE_EXT.test(file)) return;
        const module = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", refresh);
      server.watcher.on("unlink", refresh);
    },
  };
}
