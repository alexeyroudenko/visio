/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project API key. Unset (the default) disables analytics entirely. */
  readonly VITE_POSTHOG_KEY?: string;
  /** Ingestion host; defaults to EU cloud. */
  readonly VITE_POSTHOG_HOST?: string;
  /** "1" to also send from `npm run dev`. Off by default so dev noise stays out. */
  readonly VITE_POSTHOG_DEV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "virtual:image-library" {
  /** File names found in `public/imgs`, provided by the imageLibrary plugin. */
  export const IMAGE_LIBRARY_FILES: string[];
}
