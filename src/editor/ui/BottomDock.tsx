import { useRef, useState } from "react";
import { prefabUsage } from "../../shared/propagate";
import { imageSize, readFileAsDataUrl } from "../assets/slice";
import type { AnimDef, AssetDef } from "../../shared/types";
import { AnimPreview } from "./AnimPreview";
import { NewPrefabDialog } from "./dialogs/NewPrefabDialog";
import { NumberField, TextField } from "./fields";
import { useEditor, useScripts, useStoreVersion } from "./context";
import { sourceFiles } from "../scripts/parse";
import { platform } from "../platform";

export function BottomDock() {
  const { store } = useEditor();
  useStoreVersion(store);

  return (
    <section className="panel dock">
      <div className="tabs">
        <button
          className={store.ui.dockTab === "assets" ? "active" : ""}
          onClick={() => store.setUi({ dockTab: "assets" })}
        >
          Assets
        </button>
        <button
          className={store.ui.dockTab === "anim" ? "active" : ""}
          onClick={() => store.setUi({ dockTab: "anim" })}
        >
          Animation
        </button>
        <button
          className={store.ui.dockTab === "scripts" ? "active" : ""}
          onClick={() => store.setUi({ dockTab: "scripts" })}
        >
          Scripts
        </button>
        <div className="tabs-spacer" />
      </div>
      <div className="panel-body">
        {store.ui.dockTab === "assets" && <AssetBrowser />}
        {store.ui.dockTab === "anim" && <AnimEditor />}
        {store.ui.dockTab === "scripts" && <ScriptBrowser />}
      </div>
    </section>
  );
}

/** Selecting an asset arms the place tool; the dock shows type and size. */
function AssetBrowser() {
  const { store, openDialog } = useEditor();
  const [filter, setFilter] = useState<"all" | AssetDef["kind"]>("all");
  const [prefabFrom, setPrefabFrom] = useState<AssetDef | null>(null);
  const assets = store.project.assets.filter((a) => filter === "all" || a.kind === filter);
  const placement = store.ui.placement;

  return (
    <div className="asset-browser">
      <div className="asset-toolbar">
        {(["all", "image", "spritesheet", "atlas", "audio", "tilemap"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
        <div className="toolbar-spacer" />
        <button className="ghost" onClick={() => openDialog("import")}>
          Import files…
        </button>
        <button className="ghost" onClick={() => openDialog("atlas")}>
          Create atlas…
        </button>
        <button className="ghost" onClick={() => openDialog("export")}>
          Code…
        </button>
      </div>

      <div className="asset-grid">
        {/* Instances come from here onto the canvas. The count is how you know
            what a change to the definition is about to touch. */}
        {store.project.prefabs.map((prefab) => {
          const count = prefabUsage(store.project, prefab.name).reduce((n, u) => n + u.count, 0);
          return (
            <div key={prefab.name} className="asset-tile-wrap">
              <button
                className={`asset-tile prefab ${placement?.kind === "prefab" && placement.id === prefab.name ? "active" : ""}`}
                onClick={() =>
                  store.setUi({ tool: "place", placement: { kind: "prefab", id: prefab.name } })
                }
                title={
                  prefab.base
                    ? `Variant of ${prefab.base} — inherits everything it does not state`
                    : `Drag onto the canvas to place an instance · ${prefab.exposed.length} field(s) editable per instance`
                }
              >
                <span className="swatch prefab-swatch">{prefab.base ? "◈" : "◆"}</span>
                <span className="asset-name">{prefab.name}</span>
                <span className="asset-meta">
                  {prefab.base
                    ? `variant · ${Object.keys(prefab.diff ?? {}).length} differ`
                    : `${prefab.exposed.length} exposed`}
                  {count > 0 ? ` · ${count}×` : ""}
                </span>
              </button>
              <button
                className="mini edit-def"
                title="Edit the definition on an isolated stage"
                onClick={() => store.openPrefab(prefab.name)}
              >
                ◆
              </button>
            </div>
          );
        })}

        {assets.map((asset) => (
          <div key={asset.id} className="asset-tile-wrap">
            <button
              className={`asset-tile ${placement?.kind === "asset" && placement.id === asset.id ? "active" : ""}`}
              onClick={() => {
                // A map is not placed like a sprite: it goes in as layers.
                if (asset.kind === "tilemap") {
                  store.addTilemap(asset.key);
                  store.setUi({ inspectorTab: "tile" });
                  return;
                }
                store.setUi({ tool: "place", placement: { kind: "asset", id: asset.id } });
              }}
              title={asset.kind === "tilemap" ? `${asset.path} — click to add to this scene` : asset.path}
            >
              {asset.url && asset.kind !== "tilemap" ? (
                <span className="thumb" style={{ backgroundImage: `url(${asset.url})` }} />
              ) : (
                <span className="swatch">▤</span>
              )}
              <span className="asset-name">{asset.key}</span>
              <span className="asset-meta">
                {asset.kind} · {asset.width}×{asset.height}
                {asset.frames ? ` · ${asset.frames.length} frames` : ""}
              </span>
            </button>
            <ReplaceArtButton assetId={asset.id} />
            {asset.kind !== "audio" && asset.kind !== "tilemap" && (
              <button
                className="mini new-prefab"
                title="New prefab from this art — for what your code makes with new"
                onClick={() => setPrefabFrom(asset)}
              >
                ◆+
              </button>
            )}
          </div>
        ))}
        {prefabFrom && <NewPrefabDialog asset={prefabFrom} onClose={() => setPrefabFrom(null)} />}
      </div>
    </div>
  );
}

/**
 * Re-importing art under the same key swaps the texture in place — the editor
 * canvas picks it up without a restart.
 */
function ReplaceArtButton({ assetId }: { assetId: string }) {
  const { store } = useEditor();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className="mini replace"
        title="Replace the art behind this key (hot reload)"
        onClick={() => ref.current?.click()}
      >
        ⟳
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const url = await readFileAsDataUrl(file);
          const { width, height } = await imageSize(url);
          store.updateAsset(assetId, { url, width, height, generated: false }, "Replace art");
        }}
      />
    </>
  );
}

/**
 * Frames are chosen from the atlas in order; drag to reorder, click to toggle.
 * Per-frame duration overrides the global fps when a pose needs to hold.
 */
function AnimEditor() {
  const { store } = useEditor();
  const anims = store.project.anims;
  const current = anims.find((a) => a.key === store.ui.animKey) ?? anims[0] ?? null;
  const [sourceKey, setSourceKey] = useState<string>("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const sources = store.project.assets.filter(
    (a) => a.kind === "spritesheet" || a.kind === "atlas",
  );
  const source = sources.find((a) => a.key === sourceKey) ?? sources[0];

  const createAnim = () => {
    const key = `anim_${anims.length + 1}`;
    store.upsertAnim({ key, frames: [], fps: 12, repeat: -1 }, "Create animation");
  };

  const update = (patch: Partial<AnimDef>) => {
    if (!current) return;
    store.upsertAnim({ ...current, ...patch });
  };

  const sourceFrames = (): string[] => {
    if (!source) return [];
    if (source.kind === "atlas") return (source.frames ?? []).map((f) => f.name);
    const fw = source.frameWidth ?? 32;
    const fh = source.frameHeight ?? 32;
    const cols = Math.max(1, Math.floor(source.width / fw));
    const rows = Math.max(1, Math.floor(source.height / fh));
    return Array.from({ length: cols * rows }, (_, i) => String(i));
  };

  const frameStyle = (asset: AssetDef, frame: string): React.CSSProperties => {
    if (asset.kind === "atlas") {
      const f = (asset.frames ?? []).find((x) => x.name === frame);
      if (!f) return {};
      return {
        backgroundImage: `url(${asset.url})`,
        backgroundPosition: `-${f.x}px -${f.y}px`,
        width: f.w,
        height: f.h,
      };
    }
    const fw = asset.frameWidth ?? 32;
    const fh = asset.frameHeight ?? 32;
    const cols = Math.max(1, Math.floor(asset.width / fw));
    const i = Number(frame);
    return {
      backgroundImage: `url(${asset.url})`,
      backgroundPosition: `-${(i % cols) * fw}px -${Math.floor(i / cols) * fh}px`,
      width: fw,
      height: fh,
    };
  };

  return (
    <div className="anim-editor">
      <div className="anim-list">
        <div className="tree-heading">
          <span>Animations</span>
          <button className="mini" onClick={createAnim}>
            + new
          </button>
        </div>
        {anims.length === 0 && <div className="empty">No animations yet.</div>}
        {anims.map((anim) => (
          <button
            key={anim.key}
            className={`tree-row ${current?.key === anim.key ? "active" : ""}`}
            onClick={() => store.setUi({ animKey: anim.key })}
          >
            <span className="glyph">▷</span>
            {anim.key}
            <span className="meta">{anim.frames.length}f</span>
          </button>
        ))}
      </div>

      {!current ? (
        <div className="empty">Create an animation to start.</div>
      ) : (
        <>
          <div className="anim-settings">
            <TextField
              label="Key"
              value={current.key}
              onCommit={(v) => {
                if (!v.trim() || anims.some((a) => a.key === v)) return;
                store.transact("Rename animation", () => {
                  const old = current.key;
                  const target = store.project.anims.find((a) => a.key === old);
                  if (target) target.key = v;
                  for (const scene of store.project.scenes) {
                    for (const obj of scene.objects) {
                      if (obj.playOnSpawn === old) obj.playOnSpawn = v;
                    }
                  }
                });
                store.setUi({ animKey: v });
              }}
            />
            <NumberField label="FPS" value={current.fps} onCommit={(v) => update({ fps: Math.max(1, v) })} />
            <label className="field check">
              <input
                type="checkbox"
                checked={current.repeat === -1}
                onChange={(e) => update({ repeat: e.target.checked ? -1 : 0 })}
              />
              <span className="field-label">Loop forever</span>
            </label>
            {current.repeat !== -1 && (
              <NumberField
                label="Repeat"
                value={current.repeat}
                onCommit={(v) => update({ repeat: Math.max(0, Math.round(v)) })}
              />
            )}
            <label className="field check">
              <input
                type="checkbox"
                checked={!!current.yoyo}
                onChange={(e) => update({ yoyo: e.target.checked || undefined })}
              />
              <span className="field-label">Yoyo</span>
            </label>
            <button className="danger" onClick={() => store.deleteAnim(current.key)}>
              Delete
            </button>
            <AnimPreview anim={current} assets={store.project.assets} />
          </div>

          <div className="anim-timeline">
            <div className="strip-header">
              <span>Timeline — {current.frames.length} frames</span>
              {source && (
                <>
                  <button
                    className="mini"
                    title={`Append all ${sourceFrames().length} frames of ${source.key}, in order`}
                    onClick={() =>
                      update({
                        frames: [
                          ...current.frames,
                          ...sourceFrames().map((frame) => ({ textureKey: source.key, frame })),
                        ],
                      })
                    }
                  >
                    + all {sourceFrames().length}
                  </button>
                  {current.frames.length > 0 && (
                    <button
                      className="mini danger"
                      title="Remove every frame from this animation"
                      onClick={() => update({ frames: [] })}
                    >
                      clear
                    </button>
                  )}
                </>
              )}
              <select value={source?.key ?? ""} onChange={(e) => setSourceKey(e.target.value)}>
                {sources.length === 0 && <option value="">import a spritesheet or slice an atlas</option>}
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.key}
                  </option>
                ))}
              </select>
            </div>

            <div className="strip">
              {current.frames.map((f, i) => (
                <div
                  key={`${f.frame}-${i}`}
                  className="strip-frame"
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex === null || dragIndex === i) return;
                    const frames = [...current.frames];
                    const [moved] = frames.splice(dragIndex, 1);
                    frames.splice(i, 0, moved);
                    update({ frames });
                    setDragIndex(null);
                  }}
                >
                  {source && <span className="frame-img" style={frameStyle(source, f.frame)} />}
                  <span className="frame-name">{f.frame}</span>
                  <input
                    className="frame-duration"
                    type="number"
                    placeholder={String(Math.round(1000 / current.fps))}
                    value={f.duration ?? ""}
                    title="Per-frame duration in ms — overrides the global fps"
                    onChange={(e) => {
                      const frames = [...current.frames];
                      const ms = Number(e.target.value);
                      frames[i] = { ...f, duration: e.target.value === "" ? undefined : ms };
                      update({ frames });
                    }}
                  />
                  <button
                    className="mini danger"
                    onClick={() => update({ frames: current.frames.filter((_, x) => x !== i) })}
                  >
                    ×
                  </button>
                </div>
              ))}
              {current.frames.length === 0 && (
                <div className="empty">Click frames below to add them, in order.</div>
              )}
            </div>

            <div className="strip-header">
              <span>Source frames</span>
            </div>
            <div className="strip source">
              {source &&
                sourceFrames().map((frame) => (
                  <button
                    key={frame}
                    className="strip-frame source"
                    title={`add ${frame}`}
                    onClick={() =>
                      update({
                        frames: [...current.frames, { textureKey: source.key, frame }],
                      })
                    }
                  >
                    <span className="frame-img" style={frameStyle(source, frame)} />
                    <span className="frame-name">{frame}</span>
                  </button>
                ))}
              {!source && (
                <div className="empty">No spritesheet or atlas yet.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}


/**
 * Every source file in the project, and what the editor can do with each.
 *
 * What a person wants to know here is "what code is in this project, and what
 * does the editor understand about it", so every file is listed with its
 * classes, and a class backing a prefab says so.
 */
function ScriptBrowser() {
  const { store, workspace } = useEditor();
  useScripts(workspace.scripts);
  useStoreVersion(store);

  const files = sourceFiles(workspace.scripts.index);
  const boundByClass = new Map(
    store.project.prefabs.filter((p) => p.source).map((p) => [p.name, p]),
  );
  const root = workspace.location?.root ?? "";

  if (!files.length) {
    return (
      <div className="empty">
        No source files in <code>{store.project.config.paths.src}/</code>.
      </div>
    );
  }

  return (
    <div className="script-browser">
      {files.map((file) => (
        <div key={file.src} className="script-file">
          <div className="script-file-head">
            <button
              className="link"
              onClick={() => void platform.openInEditor(root, file.src)}
              title="Open in your own editor"
            >
              {file.src}
            </button>
            <span className="note">
              {file.classes.length} class{file.classes.length === 1 ? "" : "es"}
            </span>
          </div>
          {file.classes.map((cls) => {
            const bound = boundByClass.get(cls.name);
            return (
              <div key={cls.name} className="script-class">
                <button
                  className="link"
                  onClick={() => void platform.openInEditor(root, cls.src, cls.line)}
                >
                  {cls.name}
                </button>
                <span className="note">{cls.base ? `extends ${cls.base}` : "no base class"}</span>
                {bound && (
                  <span className="chip on" title={`Instances construct ${cls.name} from ${cls.src}`}>
                    bound to prefab
                  </span>
                )}
                {!bound && cls.ctorParams && (
                  <span className="note">
                    ({cls.ctorParams.join(", ")})
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
