import { browserPlatform } from "./browser";
import { createElectronPlatform, electronApi } from "./electron";
import type { Platform } from "./types";

/**
 * Resolved once, at module load: the app either has the desktop bridge on
 * `window.mosaic` or it does not.
 */
const api = typeof window === "undefined" ? null : electronApi();

export const platform: Platform = api ? createElectronPlatform(api) : browserPlatform;

export const isDesktop = platform.kind === "electron";

export type * from "./types";
