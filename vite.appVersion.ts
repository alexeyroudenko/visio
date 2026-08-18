import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_ID = "virtual:app-version";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

function packageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.trim()) return version.trim();
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

/** Latest `vX.Y.Z` in the repo; same sort as `tag.ps1`. Falls back to package.json. */
function gitTag(): string {
  try {
    const raw = execSync("git tag -l --sort=-v:refname", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tag = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^v?\d+\.\d+\.\d+/.test(line));
    if (tag) return tag;
  } catch {
    /* shallow CI clone, missing git, … */
  }
  return packageVersion();
}

/**
 * Bakes the git tag into the welcome screen / toolbar. The browser cannot read
 * the repo, so this is resolved once at config/serve/build time.
 */
export function appVersion(): Plugin {
  return {
    name: "visio-app-version",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export const GIT_TAG = ${JSON.stringify(gitTag())};\n`;
    },
  };
}
