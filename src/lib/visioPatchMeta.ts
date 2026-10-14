/**
 * Embed / extract Visio patch JSON in MP4 descriptive metadata.
 *
 * Written with Mediabunny `metadataFormat: 'mdta'` under a custom key so the
 * payload can be longer than a four-char QuickTime atom name. Companion
 * `.json` sidecars stay useful for editors that strip moov metadata and for
 * WebM exports (which do not go through this path).
 */

import {
  BlobSource,
  Input,
  MP4,
  type MetadataTags,
} from "mediabunny";
import type { SerializedPatch } from "../store/persistence";
import { parsePatch, type ParsedPatch } from "../store/persistence";

/** mdta key — same style as `com.apple.quicktime.*`. */
export const VISIO_PATCH_META_KEY = "com.visio.patch";

/** Short human-visible note in the normalized `comment` tag. */
export const VISIO_PATCH_COMMENT = "Visio patch (com.visio.patch)";

/** Compact JSON string suitable for embedding in moov metadata. */
export function patchJsonForMetadata(patch: SerializedPatch): string {
  return JSON.stringify(patch);
}

/** Tags to pass to `Output.setMetadataTags` before `output.start()`. */
export function metadataTagsForPatch(patchJson: string): MetadataTags {
  return {
    comment: VISIO_PATCH_COMMENT,
    raw: {
      [VISIO_PATCH_META_KEY]: patchJson,
    },
  };
}

/**
 * Pull the embedded JSON string out of tags returned by
 * `Input.getMetadataTags()`. Accepts string or UTF-8 bytes.
 */
export function patchJsonFromMetadataTags(tags: MetadataTags): string | null {
  const raw = tags.raw?.[VISIO_PATCH_META_KEY];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw instanceof Uint8Array && raw.byteLength > 0) {
    try {
      return new TextDecoder().decode(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** True when the file name/MIME looks like an ISO-BMFF video we can probe. */
export function looksLikeMp4Container(file: { name: string; type: string }): boolean {
  if (/\.(mp4|m4v|mov)$/i.test(file.name)) return true;
  const type = file.type.toLowerCase();
  return (
    type.includes("mp4") ||
    type.includes("quicktime") ||
    type === "video/x-m4v"
  );
}

/**
 * Read an embedded Visio patch from an MP4/MOV blob. Returns null when the
 * container has no `com.visio.patch` tag (or cannot be opened as MP4).
 */
export async function readEmbeddedPatchJson(blob: Blob): Promise<string | null> {
  const input = new Input({
    formats: [MP4],
    source: new BlobSource(blob),
  });
  try {
    if (!(await input.canRead())) return null;
    const tags = await input.getMetadataTags();
    return patchJsonFromMetadataTags(tags);
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

/** Parse an embedded patch from a video file, or null if none / invalid. */
export async function readEmbeddedPatch(blob: Blob): Promise<ParsedPatch | null> {
  const json = await readEmbeddedPatchJson(blob);
  if (!json) return null;
  try {
    return parsePatch(JSON.parse(json));
  } catch {
    return null;
  }
}
