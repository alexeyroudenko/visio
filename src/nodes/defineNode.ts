import type { NodeDefinition } from "../engine/types";

/**
 * Node state is private to each node module, but the registry stores them all
 * together — this narrows the variance to a single deliberate cast.
 */
export function defineNode<S>(definition: NodeDefinition<S>): NodeDefinition<never> {
  return definition as unknown as NodeDefinition<never>;
}

export function paramNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function paramBool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

export function paramString(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === "string" ? value : fallback;
}
