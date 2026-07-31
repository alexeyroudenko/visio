import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { presetPreviewWriter } from "./vite.presetPreviews";

export default defineConfig({
  base: "./",
  plugins: [react(), presetPreviewWriter()],
});
