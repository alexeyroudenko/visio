import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { imageLibrary } from "./vite.imageLibrary";
import { presetPreviewWriter } from "./vite.presetPreviews";
import { presetSave } from "./vite.presetSave";
import { shipConfig } from "./vite.shipConfig";

export default defineConfig({
  base: "./",
  plugins: [react(), presetPreviewWriter(), presetSave(), shipConfig(), imageLibrary()],
});
