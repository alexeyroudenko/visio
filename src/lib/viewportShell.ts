import { isStandalone } from "./displayMode";

/**
 * iOS home-screen web apps: layout viewport (and 100dvh) can extend past the
 * visible webview; `overflow: hidden` on the root then clips the shutter bar.
 * Pin shell height to visualViewport instead.
 */
export function initViewportShell(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  if (isStandalone()) {
    document.documentElement.classList.add("standalone");
  }

  const root = document.documentElement;

  const sync = () => {
    const h = window.visualViewport?.height ?? window.innerHeight;
    if (h > 0) root.style.setProperty("--app-height", `${Math.round(h)}px`);
  };

  sync();
  window.visualViewport?.addEventListener("resize", sync);
  window.visualViewport?.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
}
