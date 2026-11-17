import { useState } from "react";
import type { AssetDef } from "../../../shared/types";
import { prefabFilePath } from "../../store/project";
import { Dialog } from "./Dialog";
import { useEditor } from "../context";

/** The frames an object can show from an asset: an atlas's names, a sheet's indices. */
function framesOf(asset: AssetDef): string[] {
  if (asset.kind === "atlas") return (asset.frames ?? []).map((f) => f.name);
  if (asset.kind === "spritesheet") {
    const fw = asset.frameWidth ?? 32;
    const fh = asset.frameHeight ?? 32;
    const count = Math.max(1, Math.floor(asset.width / fw)) * Math.max(1, Math.floor(asset.height / fh));
    return Array.from({ length: count }, (_, i) => String(i));
  }
  return [];
}

/** "bulletYellow_outline.png" → "BulletYellow_outline". */
function suggestName(asset: AssetDef, frame: string): string {
  const base = (frame && !/^\d+$/.test(frame) ? frame : asset.key).replace(/\.\w+$/, "");
  const clean = base.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "Prefab";
  return /^\d/.test(clean) ? `P${clean}` : clean[0].toUpperCase() + clean.slice(1);
}

/**
 * A prefab from art alone — for what the game's code makes with `new` and
 * nobody places: a bullet, an explosion, an enemy a spawner lets out.
 */
export function NewPrefabDialog({ asset, onClose }: { asset: AssetDef; onClose: () => void }) {
  const { store } = useEditor();
  const frames = framesOf(asset);
  const [frame, setFrame] = useState(frames[0] ?? "");
  const [name, setName] = useState(() => suggestName(asset, frames[0] ?? ""));
  const [touched, setTouched] = useState(false);
  const [body, setBody] = useState(true);

  const clean = name.trim();
  const collision = store.project.prefabs.some((p) => p.name === clean);
  const create = () => {
    if (store.createPrefabFromAsset({ name: clean, assetId: asset.id, frame, body })) onClose();
  };

  return (
    <Dialog
      title="New prefab from art"
      subtitle="Nothing is placed. The definition opens on its own stage, and your code makes one with new."
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!clean || collision} onClick={create}>
            Create {clean || "prefab"}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span>Name — also its class name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
            onKeyDown={(e) => e.key === "Enter" && clean && !collision && create()}
          />
        </label>
        {collision && <p className="muted">A prefab called {clean} already exists.</p>}
        {frames.length > 0 && (
          <label className="field">
            <span>Frame of {asset.key}</span>
            <select
              value={frame}
              onChange={(e) => {
                setFrame(e.target.value);
                if (!touched) setName(suggestName(asset, e.target.value));
              }}
            >
              {frames.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field check">
          <input type="checkbox" checked={body} onChange={(e) => setBody(e.target.checked)} />
          <span>Give it an arcade body the size of the art</span>
        </label>
        <div className="kv">
          <span>Writes</span>
          <code>{prefabFilePath(clean || "Prefab", store.project.config.paths)}</code>
        </div>
      </div>
    </Dialog>
  );
}
