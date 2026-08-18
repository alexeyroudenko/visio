import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { appVersion } from "./vite.appVersion";
import { imageLibrary } from "./vite.imageLibrary";
import { presetPreviewWriter } from "./vite.presetPreviews";
import { presetSave } from "./vite.presetSave";
import { shipConfig } from "./vite.shipConfig";

export default defineConfig({
  base: "./",
  plugins: [react(), appVersion(), presetPreviewWriter(), presetSave(), shipConfig(), imageLibrary()],
});
