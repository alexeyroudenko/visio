import { useSyncExternalStore } from "react";
import { track } from "./analytics";
import { isStandalone } from "./displayMode";

/**
 * Install / offline plumbing for the PWA.
 *
 * Chrome fires `beforeinstallprompt` once, early, and only that event object
 * can open the install dialog later — so it is captured here at module scope
 * rather than inside a component that may not have mounted yet.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

export interface InstallState {
  /** Chrome offered a programmatic install — a button can open the dialog. */
  canPrompt: boolean;
  /** Already running from the home screen / Start menu. */
  installed: boolean;
  /** WebKit has no install API; the user has to go through Share. */
  ios: boolean;
}

let prompt: BeforeInstallPromptEvent | null = null;
let started = false;

const listeners = new Set<() => void>();
let state: InstallState = { canPrompt: false, installed: false, ios: false };

function emit(next: Partial<InstallState>): void {
  const merged = { ...state, ...next };
  if (
    merged.canPrompt === state.canPrompt &&
    merged.installed === state.installed &&
    merged.ios === state.ios
  ) {
    return;
  }
  state = merged;
  for (const listener of listeners) listener();
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ claims to be a Mac; touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function initPwa(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  emit({ installed: isStandalone(), ios: isIos() });

  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppress Chrome's own mini-infobar so the in-app button owns the moment.
    event.preventDefault();
    prompt = event;
    emit({ canPrompt: true });
    track("pwa_installable");
  });

  window.addEventListener("appinstalled", () => {
    prompt = null;
    emit({ canPrompt: false, installed: true });
    track("pwa_installed");
  });

  if (!("serviceWorker" in navigator)) return;

  if (import.meta.env.DEV) {
    // A worker left over from `vite preview` would serve stale chunks on the
    // same host and make dev edits look like they never happened.
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister();
    });
    return;
  }

  // Registration competes with the first render for bandwidth; wait it out.
  window.addEventListener("load", () => {
    // `base` is relative, so resolve against the page to stay path-agnostic.
    const url = new URL("sw.js", document.baseURI);
    void navigator.serviceWorker.register(url, { scope: "./" }).catch(() => undefined);
  });
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!prompt) return "unavailable";
  const pending = prompt;
  // The event is single-use: Chrome refuses a second prompt() on it.
  prompt = null;
  emit({ canPrompt: false });
  try {
    await pending.prompt();
    const { outcome } = await pending.userChoice;
    track("pwa_install_choice", { outcome });
    return outcome;
  } catch {
    return "unavailable";
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, () => state);
}
