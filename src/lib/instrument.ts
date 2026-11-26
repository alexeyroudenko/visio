/**
 * Side-effect entry: imported first from `main.tsx` so Sentry is ready before
 * React / analytics / PWA boot. Keep this file free of other app imports.
 */
import { initSentry } from "./sentry";

initSentry();
