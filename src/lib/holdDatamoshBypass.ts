import {
  isPointerHeld,
  subscribePointerHeld,
} from "./pointerHold";
import { useGraphStore } from "../store/graphStore";

/** Node types whose bypass checkbox is forced on while the content surface is held. */
const DATAMOSH_TYPES = new Set(["fx.datamosh4", "fx.datamosh"]);

/**
 * While the preview/output is held, turn on each Datamosh / Datamosh4 node's
 * bypass checkbox (same as the node header control), then restore the previous
 * values on release. Milder than engine-wide fx passthrough: other nodes keep
 * evaluating; only datamosh is skipped.
 *
 * Updates the graph store in one batch (no per-node bypass analytics spam).
 */
export function bindHoldDatamoshBypass(): () => void {
  /** Prior bypass per node id for the active hold; null when not holding. */
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
      if ((node.data.bypass === true) === was) return node;
      changed = true;
      return { ...node, data: { ...node.data, bypass: was } };
    });
    if (changed) useGraphStore.setState({ nodes: next });
  };

  const apply = () => {
    const { nodes } = useGraphStore.getState();
    saved = new Map();
    let changed = false;
    const next = nodes.map((node) => {
      if (!DATAMOSH_TYPES.has(node.data.defType)) return node;
      saved!.set(node.id, node.data.bypass === true);
      if (node.data.bypass === true) return node;
      changed = true;
      return { ...node, data: { ...node.data, bypass: true } };
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
