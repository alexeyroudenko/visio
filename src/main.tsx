import "./lib/instrument";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initAnalytics } from "./lib/analytics";
import { initPwa } from "./lib/pwa";
import { initViewportShell } from "./lib/viewportShell";
import { Sentry } from "./lib/sentry";
import "./styles/global.css";

initAnalytics();
initPwa();
initViewportShell();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p style={{ padding: 16 }}>Something went wrong.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
