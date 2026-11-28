import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initAnalytics } from "./lib/analytics";
import { initPwa } from "./lib/pwa";
import { initViewportShell } from "./lib/viewportShell";
import "./styles/global.css";

initAnalytics();
initPwa();
initViewportShell();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
