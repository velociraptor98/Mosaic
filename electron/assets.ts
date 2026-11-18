import { net, protocol } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Assets are served to the renderer over a custom `mosaic://` scheme rather
 * than being inlined as data: URLs.
 *
 * That is the whole reason the desktop build has no storage ceiling: a 4MB
 * spritesheet stays a file on disk and is streamed on demand, where the
 * browser build has to carry its bytes inside the project JSON.
 *
 * URL shape: mosaic://asset/<base64url(projectRoot)>/<project-relative path>
 */

export const ASSET_SCHEME = "mosaic";

/**
 * The scheme a scene recording is served over. It is handled per recording,
 * on that recording's own session, and serves exactly two folders: the
 * harness, and the folder the game's own server would serve. See
 * recordScene.ts.
 */
export const RECORD_SCHEME = "mosaic-record";

/**
 * Must run before app.whenReady() for the schemes to behave like https.
 * Electron allows this call once, so every scheme is registered here.
 */
export function registerAssetScheme(): void {
  const privileges = {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  };
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges },
    { scheme: RECORD_SCHEME, privileges },
  ]);
}

export function encodeRoot(root: string): string {
  return Buffer.from(root, "utf8").toString("base64url");
}

export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad url", { status: 400 });
    }
    if (url.hostname !== "asset") return new Response("not found", { status: 404 });

    const segments = url.pathname.replace(/^\//, "").split("/");
    const encodedRoot = segments.shift();
    if (!encodedRoot || !segments.length) return new Response("not found", { status: 404 });

    let root: string;
    try {
      root = Buffer.from(encodedRoot, "base64url").toString("utf8");
    } catch {
      return new Response("bad root", { status: 400 });
    }

    const rel = decodeURIComponent(segments.join("/"));
    const abs = path.resolve(root, rel);
    const bounded = path.resolve(root);
    // Same containment rule as the IPC layer: never serve outside the project.
    if (abs !== bounded && !abs.startsWith(bounded + path.sep)) {
      return new Response("forbidden", { status: 403 });
    }

    return net.fetch(pathToFileURL(abs).toString());
  });
}
