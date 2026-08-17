import { useState } from "react";
import { imageSize, inferAssetKind, readFileAsDataUrl } from "../../assets/slice";
import { uid } from "../../store/ids";
import type { AssetDef, AssetKind } from "../../../shared/types";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

interface Row {
  file: File;
  kind: AssetKind;
  key: string;
  url: string;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  margin: number;
  spacing: number;
}

/**
 * Type is inferred per file and shown for correction BEFORE anything is
 * copied. Files are copied into assets/, never referenced from outside the
 * project.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const [rows, setRows] = useState<Row[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = async (files: FileList | File[]) => {
    const next: Row[] = [];
    for (const file of Array.from(files)) {
      const url = await readFileAsDataUrl(file);
      const { width, height } = await imageSize(url);
      next.push({
        file,
        url,
        width,
        height,
        kind: inferAssetKind(file),
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
      path: `assets/${row.file.name}`,
      url: row.url,
      width: row.width,
      height: row.height,
      ...(row.kind === "spritesheet" || row.kind === "tileset"
        ? {
            frameWidth: row.frameWidth,
            frameHeight: row.frameHeight,
            margin: row.margin,
            spacing: row.spacing,
            tileCollides: row.kind === "tileset" ? [] : undefined,
          }
        : {}),
    }));
    store.importAssets(assets);
    onClose();
  };

  return (
    <Dialog
      title="Import assets"
      subtitle="Type is inferred per file and shown for correction before the copy."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!rows.length} onClick={commit}>
            Import {rows.length || ""} file{rows.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
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
          accept="image/*,audio/*"
          onChange={(e) => e.target.files && void addFiles(e.target.files)}
        />
        Drop images or audio here, or click to choose.
      </label>

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
              assets/{row.file.name} · {row.width}×{row.height} · {Math.round(row.file.size / 1024)}kb
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
            {(["image", "spritesheet", "tileset", "atlas", "audio"] as AssetKind[]).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {(row.kind === "spritesheet" || row.kind === "tileset") && (
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
