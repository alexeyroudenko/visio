import type { NodeDefinition } from "./types";

export interface GraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface SortResult {
  /** Evaluation order. Nodes inside an unbroken cycle are dropped. */
  order: string[];
  /** Ids that could not be ordered — reported to the UI as errors. */
  cyclic: string[];
}

/**
 * Kahn's algorithm. Edges landing on a `delayedInputs` port are skipped, which
 * is what lets a patch close a feedback loop without deadlocking the sort.
 */
export function topoSort(
  nodes: GraphNode[],
  edges: GraphEdge[],
  defs: Record<string, NodeDefinition<never>>,
): SortResult {
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node.id, 0);
    dependents.set(node.id, []);
  }

  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    const targetNode = nodes.find((n) => n.id === edge.target);
    if (!targetNode) continue;
    const def = defs[targetNode.type];
    if (def?.delayedInputs?.includes(edge.targetHandle)) continue;

    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    dependents.get(edge.source)!.push(edge.target);
  }

  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  const cyclic = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
  return { order, cyclic };
}

/** Incoming links per node, as targetHandle -> {source, sourceHandle}. */
export function buildInputMap(
  edges: GraphEdge[],
): Map<string, Map<string, { source: string; sourceHandle: string }>> {
  const map = new Map<string, Map<string, { source: string; sourceHandle: string }>>();
  for (const edge of edges) {
    let perNode = map.get(edge.target);
    if (!perNode) {
      perNode = new Map();
      map.set(edge.target, perNode);
    }
    perNode.set(edge.targetHandle, { source: edge.source, sourceHandle: edge.sourceHandle });
  }
  return map;
}
