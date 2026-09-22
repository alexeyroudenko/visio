/**
 * "Open in Visio" from another local app (media-lib's grid, a script, a
 * shortcut). Two ways in, because the tab may or may not already exist:
 *
 * - a running tab listens on the dev server's SSE channel and takes the path
 *   without a reload, keeping the patch it is holding;
 * - a tab opened for the occasion carries the path in `?media=` and picks it
 *   up on boot.
 *
 * Both hand off a plain disk path — `fileParamFromPath` fetches the bytes
 * through `/__visio/local-file`, so this works in `npm run dev` and
 * `npm run preview` only.
 */

export const OPEN_MEDIA_EVENTS = "/__visio/open/events";

const PARAM = "media";

function readParam(search: string): string {
  if (!search) return "";
  try {
    return new URLSearchParams(search.replace(/^[?#]/, "")).get(PARAM) ?? "";
  } catch {
    return "";
  }
}

/**
 * The path a URL carries, from `?media=` or `#media=` — the hash is there for
 * hosts that swallow the query string.
 */
export function openMediaParam(search: string, hash: string): string {
  return readParam(search) || readParam(hash);
}

/** The path the tab was opened with. */
export function openMediaFromLocation(): string {
  if (typeof window === "undefined") return "";
  return openMediaParam(window.location.search, window.location.hash);
}

/**
 * Drops the parameter once it has been read, so a reload does not re-open the
 * same file over whatever the session has become since.
 */
export function clearOpenMediaLocation(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM);
  if (readParam(url.hash)) url.hash = "";
  window.history.replaceState(null, "", url.toString());
}

/**
 * Listens for paths pushed by the dev server. A production build has no such
 * endpoint: the request 404s, EventSource reports it and — since the failure is
 * an HTTP status rather than a dropped connection — gives up without retrying.
 */
export function subscribeOpenMedia(onPath: (fsPath: string) => void): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};

  const source = new EventSource(OPEN_MEDIA_EVENTS);
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as { path?: unknown };
      if (typeof payload.path === "string" && payload.path) onPath(payload.path);
    } catch {
      /* a frame we cannot read is not worth taking the channel down for */
    }
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) source.close();
  };
  return () => source.close();
}
