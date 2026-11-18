import { useState } from "react";
import { ATLAS_DOC_EXT, parsePhaserAtlas } from "../../assets/atlasJson";
import { imageSize, inferAssetKind, readFileAsDataUrl } from "../../assets/slice";
import { platform } from "../../platform";
import { uid } from "../../store/ids";
import {
  MAP_EXT,
  describeTiledMap,
  parseTiledMap,
  tiledFromDataUrl,
  tiledToDataUrl,
} from "../../../shared/tiled";
import type { AssetDef, AssetFrame, AssetKind } from "../../../shared/types";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

interface Row {
  file: File;
  kind: AssetKind;
  key: string;
  url: string;
  /** Set on desktop: the project-relative path the bytes were copied to. */
  rel?: string;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
  /** An atlas's frames, read from the packer's document. */
  frames?: AssetFrame[];
}

/**
 * Type is inferred per file and shown for correction BEFORE anything is
 * copied. Files are copied into assets/, never referenced from outside the
 * project.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { store, workspace } = useEditor();
  const [rows, setRows] = useState<Row[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = workspace.location?.root ?? null;
  const desktop = platform.canOpenProjects && !!root;

  /**
   * On desktop the bytes already live in the project: the file is copied into
   * assets/ and referenced by path. Only the metadata below still needs
   * confirming, so the row carries the copied path rather than a data: URL.
   */
  const addCopied = async (copied: AssetDef[]) => {
    const next: Row[] = [];
    for (const asset of copied) {
      const { width, height } = await imageSize(asset.url);
      next.push({
        file: new File([], asset.path.split("/").pop() ?? asset.key),
        url: asset.url,
        rel: asset.path,
        width,
        height,
        kind: asset.kind,
        key: asset.key,
        frames: asset.frames,
        frameWidth: 32,
        frameHeight: 32,
        margin: 0,
        spacing: 0,
      });
    }
    setRows((r) => [...r, ...next]);
  };

  const chooseNative = async () => {
    if (!root) return;
    setBusy(true);
    try {
      await addCopied(await platform.importAssets(root));
      // A Tiled map picked alongside the art is already in assets/ — it is a
      // file, with nothing to confirm about it — so it is read where it lies.
      await workspace.rescanTilemaps();
    } finally {
      setBusy(false);
    }
  };

  const dropNative = async (files: FileList) => {
    if (!root) return;
    const paths = Array.from(files)
      .map((f) => platform.pathForFile(f))
      .filter(Boolean);
    if (!paths.length) return;
    setBusy(true);
    try {
      await addCopied(await platform.copyAssets(root, paths));
      await workspace.rescanTilemaps();
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const next: Row[] = [];
    const list = Array.from(files);
    // An atlas document picked beside its sheet: frames by the sheet's stem.
    const atlasFrames = new Map<string, AssetFrame[]>();
    for (const file of list) {
      if (!ATLAS_DOC_EXT.test(file.name)) continue;
      const frames = parsePhaserAtlas(await file.text());
      if (frames?.length) atlasFrames.set(file.name.replace(/\.\w+$/, ""), frames);
    }
    for (const file of list) {
      if (/\.xml$/i.test(file.name)) continue;
      // The browser build has no folder, so a map travels inside the project.
      if (MAP_EXT.test(file.name)) {
        const map = parseTiledMap(await file.text());
        if (!map) continue; // an atlas document, or not JSON at all
        next.push({
          file,
          url: tiledToDataUrl(map),
          width: map.width * map.tilewidth,
          height: map.height * map.tileheight,
          kind: "tilemap",
          key: file.name.replace(/\.\w+$/, "").replace(/[^\w]+/g, "_"),
          frameWidth: 0,
          frameHeight: 0,
          margin: 0,
          spacing: 0,
        });
        continue;
      }
      const url = await readFileAsDataUrl(file);
      const { width, height } = await imageSize(url);
      const frames = atlasFrames.get(file.name.replace(/\.\w+$/, ""));
      next.push({
        file,
        url,
        width,
        height,
        frames,
        kind: frames ? "atlas" : inferAssetKind(file),
        key: file.name.replace(/\.\w+$/, "").replace(/[^\w]+/g, "_"),
        frameWidth: 32,
        frameHeight: 32,
        margin: 0,
        spacing: 0,
      });
    }
    setRows((r) => [...r, ...next]);
  };

  const commit = () => {
    const assets: AssetDef[] = rows.map((row) => ({
      id: uid("asset"),
      key: row.key,
      kind: row.kind,
      path: row.rel ?? `assets/${row.file.name}`,
      url: row.url,
      width: row.width,
      height: row.height,
      ...(row.kind === "atlas" && row.frames ? { frames: row.frames } : {}),
      ...(row.kind === "spritesheet"
        ? {
            frameWidth: row.frameWidth,
            frameHeight: row.frameHeight,
            margin: row.margin,
            spacing: row.spacing,
          }
        : {}),
    }));
    // A map is described against every image the project will have once this
    // import lands — the art it draws with is often in the same drop.
    const known = [...store.project.assets, ...assets];
    for (const asset of assets) {
      if (asset.kind !== "tilemap") continue;
      const map = tiledFromDataUrl(asset.url);
      if (map) asset.tilemap = describeTiledMap(map, asset.path, known);
    }
    store.importAssets(assets);
    store.hydrateTilemaps();
    // On desktop the maps are files, and may have been waiting for this art.
    void workspace.rescanTilemaps();
    onClose();
  };

  return (
    <Dialog
      title="Import assets"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!rows.length || busy} onClick={commit}>
            Import {rows.length || ""} file{rows.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      {desktop ? (
        <div
          className={`dropzone ${dragOver ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void dropNative(e.dataTransfer.files);
          }}
        >
          <p>Drop images or audio here</p>
          <button className="ghost" disabled={busy} onClick={() => void chooseNative()}>
            {busy ? "Copying…" : "Choose files…"}
          </button>
        </div>
      ) : (
        <label
          className={`dropzone ${dragOver ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void addFiles(e.dataTransfer.files);
          }}
        >
          <input
            type="file"
            multiple
            accept="image/*,audio/*,.json,.tmj,.xml"
            onChange={(e) => e.target.files && void addFiles(e.target.files)}
          />
          Drop images or audio here, or click to choose.
        </label>
      )}

      {rows.map((row, i) => (
        <div key={i} className="import-row">
          {row.url.startsWith("data:image") && (
            <span className="thumb" style={{ backgroundImage: `url(${row.url})` }} />
          )}
          <div className="import-main">
            <input
              value={row.key}
              onChange={(e) =>
                setRows((r) => r.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
              }
            />
            <span className="meta">
              {row.rel ?? `assets/${row.file.name}`} · {row.width}×{row.height}
              {row.file.size ? ` · ${Math.round(row.file.size / 1024)}kb` : ""}
              {row.kind === "atlas" && row.frames ? ` · ${row.frames.length} frames` : ""}
            </span>
          </div>
          <select
            value={row.kind}
            onChange={(e) =>
              setRows((r) =>
                r.map((x, j) => (j === i ? { ...x, kind: e.target.value as AssetKind } : x)),
              )
            }
          >
            {(row.kind === "tilemap"
              ? (["tilemap"] as AssetKind[])
              : (["image", "spritesheet", "atlas", "audio"] as AssetKind[])
            ).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {row.kind === "spritesheet" && (
            <span className="frame-config">
              <input
                type="number"
                value={row.frameWidth}
                title="frame width"
                onChange={(e) =>
                  setRows((r) =>
                    r.map((x, j) => (j === i ? { ...x, frameWidth: Number(e.target.value) } : x)),
                  )
                }
              />
              ×
              <input
                type="number"
                value={row.frameHeight}
                title="frame height"
                onChange={(e) =>
                  setRows((r) =>
                    r.map((x, j) => (j === i ? { ...x, frameHeight: Number(e.target.value) } : x)),
                  )
                }
              />
            </span>
          )}
          <button
            className="mini danger"
            onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
    </Dialog>
  );
}
