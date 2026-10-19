import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { appVersion } from "./vite.appVersion";
import { imageLibrary } from "./vite.imageLibrary";
import { localFile } from "./vite.localFile";
import { openMedia } from "./vite.openMedia";
import { presetPreviewWriter } from "./vite.presetPreviews";
import { presetSave } from "./vite.presetSave";
import { shipConfig } from "./vite.shipConfig";

/** Upload only when CI (or local) provides org + project + auth token. */
const sentryAuth = process.env.SENTRY_AUTH_TOKEN?.trim() || "";
const sentryOrg = process.env.SENTRY_ORG?.trim() || "";
const sentryProject = process.env.SENTRY_PROJECT?.trim() || "";
const uploadSourceMaps = Boolean(sentryAuth && sentryOrg && sentryProject);

export default defineConfig({
  base: "./",
  build: {
    // Hidden maps only when the plugin can upload then delete them — otherwise
    // the static host would serve `.map` files next to the bundle.
    sourcemap: uploadSourceMaps ? "hidden" : false,
  },
  plugins: [
    react(),
    appVersion(),
    presetPreviewWriter(),
    presetSave(),
    shipConfig(),
    imageLibrary(),
    localFile(),
    openMedia(),
    ...(uploadSourceMaps
      ? [
          sentryVitePlugin({
            org: sentryOrg,
            project: sentryProject,
            authToken: sentryAuth,
            sourcemaps: {
              filesToDeleteAfterUpload: ["./dist/**/*.map"],
            },
          }),
        ]
      : []),
  ],
});
