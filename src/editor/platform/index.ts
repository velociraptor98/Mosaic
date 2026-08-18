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

/**
 * Marks the document so CSS can reserve space for the macOS traffic lights,
 * which float over our own title bar.
 */
if (typeof document !== "undefined") {
  const root = document.documentElement;
  if (isDesktop) root.classList.add("is-desktop");
  if (isDesktop && platform.os === "darwin") root.classList.add("is-mac");
}

export type * from "./types";
