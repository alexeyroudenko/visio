---
name: ios-web-app
description: >-
  Build and harden visio as an iOS Safari / home-screen web app (PWA). Use when
  changing install flow, service worker, manifest, apple-touch meta, safe-area
  layout, visualViewport shell height, camera/getUserMedia, MediaPipe on iOS,
  touch targets, standalone mode, or when the user mentions iPhone, iPad,
  Safari, WebKit, Add to Home Screen, or mobile web UX.
---

# visio — iOS web app

visio is a **React 19 + Vite 6** browser app with a **custom PWA** (not `vite-plugin-pwa`, not Capacitor). Target iOS via Safari / Chrome-on-iOS (both WebKit) and home-screen standalone.

## Canonical files

| Concern | Path |
|---------|------|
| Apple meta + viewport | `index.html` |
| Web app manifest | `public/manifest.json` (`.json` on purpose — nginx MIME) |
| Service worker | `public/sw.js` |
| Install / SW register | `src/lib/pwa.ts` (`initPwa`, `useInstallState`, `promptInstall`) |
| Standalone detect | `src/lib/displayMode.ts` (`navigator.standalone` + `display-mode`) |
| Shell height on iOS | `src/lib/viewportShell.ts` → CSS `--app-height` |
| Safe-area / touch CSS | `src/styles/global.css` |
| Install copy in UI | `src/ui/SettingsModal.tsx` |
| Camera | `src/nodes/source/media.ts` (`getUserMedia`) |

Extend these; do not add a second PWA stack.

## Hard rules for iOS

1. **No `beforeinstallprompt` on WebKit.** Detect with `install.ios` from `useInstallState()`. UI must explain Share → **Add to Home Screen**. Never show a dead Install button on iOS.
2. **Apple meta is required** — Safari largely ignores the manifest for home-screen chrome:
   - `apple-mobile-web-app-capable` / `mobile-web-app-capable`
   - `apple-mobile-web-app-title`
   - `apple-mobile-web-app-status-bar-style` (visio: `black-translucent`)
   - `apple-touch-icon`
3. **Viewport**: keep `viewport-fit=cover` so `env(safe-area-inset-*)` works with the translucent status bar.
4. **Shell height**: use `--app-height` from `initViewportShell()` (visualViewport). Prefer `height: var(--app-height, 100dvh)` over raw `100vh`. Do not rely on `100vh` alone in standalone.
5. **Safe areas**: pad chrome (shutter, welcome, inspectors, modals) with `env(safe-area-inset-*)`. In standalone, `html.standalone` already boosts bottom inset for home indicator — follow that pattern for new fixed bars.
6. **Touch**: interactive controls use `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent`. Canvas / gesture surfaces that must not scroll use `touch-action: none`. Prefer ≥44×44px hit targets on mobile.
7. **Inputs**: avoid iOS zoom — keep form `font-size` ≥ 16px on focusable fields, or accept zoom and keep layout resilient.
8. **SW in DEV**: `initPwa()` unregisters workers in `import.meta.env.DEV`. Never register SW during Vite dev.
9. **Cache versioning**: bump `SHELL_CACHE` / `ASSET_CACHE` names in `sw.js` when shell caching semantics change. Hashed `/assets/*` stay cache-first; navigations stay network-first; Range/media paths stay uncached.
10. **HTTPS**: production needs HTTPS for SW + camera. Local exception is `localhost` only.

## Install UX pattern

```tsx
const install = useInstallState();

// Chrome/Edge: programmatic prompt
{install.canPrompt ? (
  <button type="button" onClick={() => void promptInstall()}>Install visio</button>
) : null}

// Copy:
// installed  → offline shell note (models/media still need network first time)
// canPrompt  → desktop/home-screen install
// ios        → Share → “Add to Home Screen” (Chrome and Safari both WebKit)
// else       → address-bar install / unsupported browsers
```

Keep analytics events: `pwa_installable`, `pwa_installed`, `pwa_install_choice`.

## Camera / MediaPipe / audio on iOS

- Request camera only from a **user gesture** path when possible; surface clear permission errors.
- Prefer `facingMode: { ideal }` (already used) — hard constraints often fail on iOS.
- Autoplay of video/audio is restricted; call `.play()` after stream attach and handle rejection.
- MediaPipe WASM/models: large downloads — do not put model binaries in the SW shell precache; keep runtime/network fetch. Note in UI that first open needs network.
- WebGL: expect Safari quirks (context loss, narrower extension set). Guard `getContext` failures; avoid assuming desktop GL limits.
- Audio worklets / low-latency paths: test under silent-switch / interrupted audio; resume `AudioContext` on gesture if suspended.

## Layout checklist (new UI)

- [ ] Works in Safari tab and home-screen standalone
- [ ] Not clipped by notch / Dynamic Island / home indicator (`safe-area` + `--app-height`)
- [ ] Fixed bars use `html.standalone` or equivalent inset padding
- [ ] No hover-only affordances for primary actions
- [ ] Overscroll / rubber-banding does not break the graph (`overscroll-behavior` where needed)
- [ ] Landscape and portrait both usable (`manifest` orientation is `any`)

## What not to do

- Do not switch to Capacitor / Cordova unless explicitly requested.
- Do not rename `manifest.json` to `.webmanifest` without fixing server MIME.
- Do not implement a custom iOS install prompt that claims one-tap install.
- Do not precache MediaPipe models or large media in `sw.js`.
- Do not remove `navigator.standalone` fallback in `isStandalone()`.

## Quick verify

1. Safari iPhone/iPad: Share → Add to Home Screen → open; status bar translucent over black UI.
2. Standalone: shutter/welcome above home indicator; no clipped bottom chrome.
3. Camera node: permission + preview after grant.
4. Airplane mode after first load: shell loads; models/media may fail gracefully.
5. Chrome Android/desktop: Install still works via `beforeinstallprompt`.
