/** Stable-ish fingerprint of node params for “did the user tweak anything?” checks. */
export function paramsKey(params: Record<string, unknown>): string {
  return JSON.stringify(params);
}
