import {
  isPointerHeld,
  subscribePointerHeld,
} from "./pointerHold";
import { useGraphStore } from "../store/graphStore";

/** Datamosh nodes that expose the Reset (`clear`) toggle. */
const DATAMOSH_TYPES = new Set(["fx.datamosh4", "fx.datamosh"]);

/**
 * While the preview/output is held, turn on each Datamosh / Datamosh4 node's
 * Reset checkbox (`params.clear`), then restore the previous value on release.
 *
 * While Reset is on, those nodes I-frame / copy the clean source each frame —
 * the published mixer checkbox lights up to match.
 *
 * Batches graph updates (avoids setParam keyframe/analytics side effects).
 */
export function bindHoldDatamoshReset(): () => void {
  /** Prior `clear` per node id for the active hold; null when not holding. */
  let saved: Map<string, boolean> | null = null;

  const restore = () => {
    if (!saved) return;
    const prior = saved;
    saved = null;
    const { nodes } = useGraphStore.getState();
    let changed = false;
    const next = nodes.map((node) => {
      if (!prior.has(node.id)) return node;
      const was = prior.get(node.id)!;
      if (node.data.params.clear === was) return node;
      changed = true;
      return {
        ...node,
        data: { ...node.data, params: { ...node.data.params, clear: was } },
      };
    });
    if (changed) useGraphStore.setState({ nodes: next });
  };

  const apply = () => {
    const { nodes } = useGraphStore.getState();
    saved = new Map();
    let changed = false;
    const next = nodes.map((node) => {
      if (!DATAMOSH_TYPES.has(node.data.defType)) return node;
      const prev = node.data.params.clear === true;
      saved!.set(node.id, prev);
      if (prev) return node;
      changed = true;
      return {
        ...node,
        data: { ...node.data, params: { ...node.data.params, clear: true } },
      };
    });
    if (changed) useGraphStore.setState({ nodes: next });
  };

  const sync = () => {
    if (isPointerHeld()) {
      if (!saved) apply();
    } else {
      restore();
    }
  };

  sync();
  const unsubscribe = subscribePointerHeld(sync);

  return () => {
    unsubscribe();
    restore();
  };
}
