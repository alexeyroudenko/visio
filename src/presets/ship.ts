import { OMITTED_PRESET_IDS } from "virtual:preset-omit";

/** Live copy: a checkbox in this session updates it before the next reload. */
const omitted = new Set(OMITTED_PRESET_IDS);

if (import.meta.hot) {
  import.meta.hot.accept("virtual:preset-omit", (mod) => {
    if (!mod) return;
    omitted.clear();
    for (const id of mod.OMITTED_PRESET_IDS) omitted.add(id);
  });
}

export function isOmitted(id: string): boolean {
  return omitted.has(id);
}

/** Persist a picker checkbox. `ship: false` writes `visio.ship.json` so the next session and `npm run build` skip it. */
export async function setPresetShipped(id: string, ship: boolean): Promise<boolean> {
  if (ship === !omitted.has(id)) return true;
  try {
    const res = await fetch("/__omit-preset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ship }),
    });
    if (!res.ok) return false;
    if (ship) omitted.delete(id);
    else omitted.add(id);
    return true;
  } catch {
    return false;
  }
}
