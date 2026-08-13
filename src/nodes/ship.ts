import { OMITTED_NODE_TYPES } from "virtual:node-omit";

/** Live copy: a checkbox in this session updates it before the next reload. */
const omitted = new Set(OMITTED_NODE_TYPES);

if (import.meta.hot) {
  import.meta.hot.accept("virtual:node-omit", (mod) => {
    if (!mod) return;
    omitted.clear();
    for (const type of mod.OMITTED_NODE_TYPES) omitted.add(type);
  });
}

/** A graph without a source or a screen is not a patch. */
export const LOCKED_NODE_TYPES = ["source.media", "output.screen"] as const;

export function isNodeLocked(type: string): boolean {
  return (LOCKED_NODE_TYPES as readonly string[]).includes(type);
}

export function isNodeOmitted(type: string): boolean {
  return omitted.has(type);
}

/** Persist a + Node checkbox. `ship: false` writes `visio.ship.json` so the next session and `npm run build` skip it. */
export async function setNodeShipped(type: string, ship: boolean): Promise<boolean> {
  if (ship === !omitted.has(type)) return true;
  try {
    const res = await fetch("/__omit-node", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: type, ship }),
    });
    if (!res.ok) return false;
    if (ship) omitted.delete(type);
    else omitted.add(type);
    return true;
  } catch {
    return false;
  }
}
