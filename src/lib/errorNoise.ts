/**
 * Browser exception strings that are not actionable app signal.
 * Used by PostHog Error Tracking `before_send` so noise stays out of the inbox.
 */
export const NOISE_EXCEPTIONS = [
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
  "Script error.",
] as const;

export function isNoiseException(message: string | undefined | null): boolean {
  if (!message) return false;
  const trimmed = message.trim();
  return NOISE_EXCEPTIONS.some((noise) => trimmed === noise || trimmed.startsWith(noise));
}
