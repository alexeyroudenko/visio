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

function tryGit(command: string): string | null {
  try {
    const raw = execSync(command, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = raw
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    return line ?? null;
  } catch {
    return null;
  }
}

/** Latest `vX.Y.Z` reachable from HEAD; same sort as `tag.ps1`. Falls back to package.json. */
function gitTag(): string {
  const pickSemver = (command: string): string | null => {
    try {
      const raw = execSync(command, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const tag = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^v?\d+\.\d+\.\d+/.test(line));
      return tag ?? null;
    } catch {
      return null;
    }
  };
  // Prefer a tag that actually leads to this commit — `tag -l` can be empty
  // on a shallow clone that only fetched HEAD.
  return (
    pickSemver("git describe --tags --abbrev=0") ??
    pickSemver("git tag -l --sort=-v:refname") ??
    packageVersion()
  );
}

/**
 * When `tag.ps1` annotated the release (`git tag -a`), this is the tagger
 * timestamp. Falls back to creatordate (works for lightweight tags too).
 */
function gitTagAt(tag: string): string {
  const candidates = tag.startsWith("v") || tag.startsWith("V") ? [tag] : [`v${tag}`, tag];
  for (const name of candidates) {
    // creatordate = taggerdate for annotated tags, committer date for lightweight.
    // Quote the format — bare `%(…)` is a subshell to /bin/sh.
    const at = tryGit(
      `git for-each-ref --format='%(creatordate:iso-strict)' "refs/tags/${name}"`,
    );
    if (at) return at;
  }
  return "";
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
      const tag = gitTag();
      const at = gitTagAt(tag);
      return [
        `export const GIT_TAG = ${JSON.stringify(tag)};`,
        `export const GIT_TAG_AT = ${JSON.stringify(at)};`,
        "",
      ].join("\n");
    },
  };
}
