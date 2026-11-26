/**
 * Error monitoring — Sentry browser SDK.
 *
 * Runs alongside PostHog (product events + Error Tracking + session replay).
 * This module owns crash/exception reporting with breadcrumbs; it does **not**
 * enable Sentry Session Replay (PostHog already samples replays) so we avoid
 * a second recording surface and double privacy exposure.
 *
 * Same gates as analytics: no DSN → no-op; DNT / `?analytics=off` skip init;
 * prod-only unless `VITE_SENTRY_DEV=1`.
 */
import * as Sentry from "@sentry/react";
import { APP_VERSION } from "./appVersion";
import { scrub } from "./analytics";
import { isNoiseException, NOISE_EXCEPTIONS } from "./errorNoise";

const DSN = import.meta.env.VITE_SENTRY_DSN?.trim() || "";
const OPT_OUT_KEY = "visio.analytics.optOut";

function doNotTrack(): boolean {
  if (typeof navigator === "undefined") return true;
  const flags = [
    navigator.doNotTrack,
    (window as { doNotTrack?: string }).doNotTrack,
    (navigator as { msDoNotTrack?: string }).msDoNotTrack,
  ];
  return flags.some((flag) => flag === "1" || flag === "yes");
}

function optedOut(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function enabled(): boolean {
  if (!DSN) return false;
  if (typeof window === "undefined") return false;
  if (optedOut()) return false;
  if (!import.meta.env.PROD && import.meta.env.VITE_SENTRY_DEV !== "1") return false;
  return !doNotTrack();
}

function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const values = event.exception?.values;
  if (values) {
    for (const item of values) {
      if (typeof item.value === "string") item.value = scrub(item.value);
    }
  }
  if (typeof event.message === "string") event.message = scrub(event.message);
  if (event.request?.url) event.request.url = scrub(event.request.url);
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (typeof crumb.message === "string") crumb.message = scrub(crumb.message);
      if (crumb.data) {
        for (const [key, value] of Object.entries(crumb.data)) {
          if (typeof value === "string") crumb.data[key] = scrub(value);
        }
      }
    }
  }
  return event;
}

let started = false;

/** Call once at boot, before React mounts, so early failures are caught. */
export function initSentry(): void {
  if (started || !enabled()) return;
  started = true;

  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.PROD ? "production" : "development",
    release: `visio@${APP_VERSION}`,
    // Errors + default breadcrumbs only — no Performance / Session Replay.
    tracesSampleRate: 0,
    ignoreErrors: [...NOISE_EXCEPTIONS],
    beforeSend(event) {
      const messages = (event.exception?.values ?? [])
        .map((v) => v.value)
        .filter((v): v is string => typeof v === "string");
      if (typeof event.message === "string") messages.push(event.message);
      if (messages.some(isNoiseException)) return null;
      return scrubEvent(event);
    },
    beforeBreadcrumb(breadcrumb) {
      if (typeof breadcrumb.message === "string") {
        breadcrumb.message = scrub(breadcrumb.message);
        if (isNoiseException(breadcrumb.message)) return null;
      }
      if (breadcrumb.data) {
        for (const [key, value] of Object.entries(breadcrumb.data)) {
          if (typeof value === "string") breadcrumb.data[key] = scrub(value);
        }
      }
      // Console breadcrumbs can carry shader dumps; keep level+category only when huge.
      if (breadcrumb.category === "console" && typeof breadcrumb.message === "string") {
        breadcrumb.message = scrub(breadcrumb.message).slice(0, 180);
      }
      return breadcrumb;
    },
  });
}

export { Sentry };
