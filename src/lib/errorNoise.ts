/**
 * Browser exception strings that are not actionable app signal.
 * Shared by PostHog Error Tracking and Sentry so both stay quiet on the same noise.
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
