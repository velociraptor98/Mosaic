import { useState } from "react";
import { childrenOf } from "../../shared/transform";
import type { LeftTab } from "../store/project";
import type { SceneObject, TileLayer } from "../../shared/types";
import { platform } from "../platform";
import { prefabUsage } from "../../shared/propagate";
import { MANIFEST_PATH, prefabPath, scenePath } from "../project/serialize";
import { sourceFiles } from "../scripts/parse";
import { useEditor, useScripts, useStoreVersion, useWorkspace } from "./context";
import type { GameScene } from "../project/adopt";
import { ImportPhaserDialog } from "./dialogs/ImportPhaserDialog";

const TABS: { id: LeftTab; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "outliner", label: "Outliner" },
  { id: "layers", label: "Layers" },
];

export function LeftDock() {
  const { store } = useEditor();
  useStoreVersion(store);

  return (
    <aside className="panel left-dock">
      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={store.ui.leftTab === tab.id ? "active" : ""}
            onClick={() => store.setUi({ leftTab: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {store.ui.leftTab === "project" && <ProjectTree />}
        {store.ui.leftTab === "outliner" && <Outliner />}
        {store.ui.leftTab === "layers" && <Layers />}
      </div>
    </aside>
  );
}

/**
 * The editor opens a folder, not a file: every scene, prefab and asset the
 * manifest declares is listed here, with a modified marker per scene.
 */
/** Porcelain codes, shortened to a badge the tree has room for. */
function GitBadge({ code }: { code: string | undefined }) {
  if (!code) return null;
  const label = code === "??" ? "new" : code.replace(/\s+/g, "");
  const kind = code === "??" ? "untracked" : code.includes("M") ? "modified" : "staged";
  return (
    <span className={`git-badge ${kind}`} title={`git status: ${code}`}>
      {label}
    </span>
  );
}

function ProjectTree() {
  const { store, workspace, openDialog } = useEditor();
  useWorkspace(workspace);
  useScripts(workspace.scripts);
  const git = workspace.git;
  const codeFiles = sourceFiles(workspace.scripts.index);
  const unlaid = workspace.isOpen ? workspace.unlaidScenes : [];
  const [importing, setImporting] = useState<GameScene | null>(null);

  return (
    <div className="tree">
      <div className="tree-heading">
        <span title={workspace.location?.root}>{store.project.name}</span>
        <span>
          {workspace.isOpen && (
            <button className="mini" title="Reveal in file manager" onClick={() => workspace.reveal()}>
              ↗
            </button>
          )}
          <button className="mini" onClick={() => openDialog("newscene")}>
            + scene
          </button>
        </span>
      </div>


      {workspace.issues.length > 0 && (
        <div className="banner warn">
          {workspace.issues.length} issue(s) reading this folder: {workspace.issues[0]}
        </div>
      )}

      {/*
        The offer belongs here, not only in the command palette. This is the
        moment the editor knows the folder holds a Phaser project it could not
        read — the banner above is saying exactly that — and an action nobody
        can find is one that may as well not exist.
      */}
      {platform.canImportPhaser && workspace.deferredWrite && (
        <button className="block" onClick={() => openDialog("importphaser")}>
          Import a scene from this Phaser project…
        </button>
      )}

      <div className="tree-group">
        {store.project.config.paths.scenes === "." ? "scenes" : store.project.config.paths.scenes}
      </div>
      {store.project.scenes.map((scene) => (
        <div key={scene.key} className="tree-row-wrap">
          <button
            className={`tree-row ${store.activeSceneKey === scene.key ? "active" : ""}`}
            onClick={() => store.activateScene(scene.key)}
            title={`${scene.objects.length} objects · ${scene.layers.length} layers`}
          >
            <span className="glyph">◇</span>
            {scene.key}.scene.json
            {store.isDirty(scene.key) && <span className="dot" title="unsaved" />}
            <GitBadge code={git[scenePath(scene.key, store.project.config.paths)]} />
          </button>
          {store.project.scenes.length > 1 && (
            <button
              className="mini danger"
              onClick={() => store.deleteScene(scene.key)}
              title="Delete scene file"
            >
              ×
            </button>
          )}
        </div>
      ))}

      {/* The game's own scenes that have no layout: the same choice the
          adopt screen offered, still on offer after the first one. */}
      {workspace.isOpen && unlaid.length > 0 && (
        <>
          <div className="tree-group">In your code, no layout yet</div>
          {unlaid.map((scene) => (
            <div key={`${scene.src}::${scene.name}`} className="tree-row-wrap">
              <span className="tree-row static" title={`${scene.src}:${scene.line}`}>
                <span className="glyph">◌</span>
                {scene.name}
                <span className="meta">{scene.src.split("/").pop()}</span>
              </span>
              <button
                className="mini"
                title="Write an empty layout beside this class"
                onClick={() => void workspace.layOut(scene)}
              >
                + layout
              </button>
              {platform.canImportPhaser && (
                <button
                  className="mini"
                  title="Run the game once and start the layout from what create() builds"
                  onClick={() => setImporting(scene)}
                >
                  import
                </button>
              )}
            </div>
          ))}
        </>
      )}
      {importing && <ImportPhaserDialog target={importing} onClose={() => setImporting(null)} />}

      {platform.canGit && (
        <div className="tree-group">
          manifest <GitBadge code={git[MANIFEST_PATH]} />
        </div>
      )}

      <div className="tree-group">{store.project.config.paths.prefabs}</div>
      {store.project.prefabs.length === 0 && <div className="empty">No prefabs yet.</div>}
      {/* Bases first, each with the variants that resolve from it indented
          underneath: the file list is also the inheritance. */}
      {store.project.prefabs
        .filter((p) => !p.base)
        .flatMap((base) => [base, ...store.variantsOf(base.name)])
        .map((prefab) => {
          const count = prefabUsage(store.project, prefab.name).reduce((n, u) => n + u.count, 0);
          const open = store.prefabDoc?.name === prefab.name;
          return (
            <div key={prefab.name} className="tree-row-wrap">
              <button
                className={`tree-row ${open ? "active" : ""}`}
                style={prefab.base ? { paddingLeft: 22 } : undefined}
                onClick={() =>
                  store.setUi({ tool: "place", placement: { kind: "prefab", id: prefab.name } })
                }
                title={
                  prefab.base
                    ? `Variant of ${prefab.base} · ${Object.keys(prefab.diff ?? {}).length} field(s) differ`
                    : `Exposed: ${prefab.exposed.join(", ") || "nothing"}`
                }
              >
                <span className="glyph">{prefab.base ? "◈" : "◆"}</span>
                {prefab.name}.prefab.json
                <GitBadge code={git[prefabPath(prefab.name, store.project.config.paths)]} />
                <span className="meta">
                  {prefab.base ? `→ ${prefab.base}` : `${prefab.exposed.length} exposed`}
                  {count > 0 ? ` · ${count}×` : ""}
                </span>
              </button>
              <button
                className="mini"
                title="Open the definition on an isolated stage"
                onClick={() => store.openPrefab(prefab.name)}
              >
                ◆
              </button>
              <button className="mini danger" onClick={() => store.deletePrefab(prefab.name)}>
                ×
              </button>
            </div>
          );
        })}

      {/* The editor indexes these, so the folder view has to show them: a
          class the project has is as much a part of it as a scene is. */}
      {platform.canOpenProjects && (
        <>
          <div className="tree-group">code</div>
          {workspace.scripts.loading && <div className="empty">Indexing src/…</div>}
          {!workspace.scripts.loading && codeFiles.length === 0 && (
            <div className="empty">No source files.</div>
          )}
          {codeFiles.map((file) => {
            const first = file.classes[0];
            return (
              <div key={file.src} className="tree-row-wrap">
                <button
                  className="tree-row"
                  title={file.classes
                    .map((c) => `${c.name} · ${c.properties.length} editable`)
                    .join("\n")}
                  onClick={() =>
                    first && store.setUi({ sourceView: { src: file.src, className: first.name } })
                  }
                >
                  <span className="glyph">ƒ</span>
                  {file.src.replace(/^src\//, "")}
                  <GitBadge code={git[file.src]} />
                  <span className="meta">{file.classes.map((c) => c.name).join(", ")}</span>
                </button>
                <button
                  className="mini"
                  title="Open in your editor"
                  onClick={() => void workspace.scripts.openExternal(file.src, first?.line)}
                >
                  ↗
                </button>
              </div>
            );
          })}
        </>
      )}

      <div className="tree-group">assets</div>
      {store.project.assets.map((asset) => (
        <button
          key={asset.id}
          className="tree-row"
          onClick={() => store.setUi({ dockTab: "assets", placement: { kind: "asset", id: asset.id } })}
        >
          <span className="glyph">▤</span>
          {asset.path.replace(/^assets\//, "")}
          <GitBadge code={git[asset.path]} />
          <span className="meta">{asset.kind}</span>
        </button>
      ))}

      <div className="tree-group">animations</div>
      {store.project.anims.length === 0 && <div className="empty">No animations yet.</div>}
      {store.project.anims.map((anim) => (
        <button
          key={anim.key}
          className="tree-row"
          onClick={() => store.setUi({ dockTab: "anim", animKey: anim.key })}
        >
          <span className="glyph">▷</span>
          {anim.key}
          <span className="meta">{anim.frames.length}f</span>
        </button>
      ))}
    </div>
  );
}

/** Drag rows to reparent. Containers carry their own transform. */
function Outliner() {
  const { store } = useEditor();
  const scene = store.scene;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  if (!scene) return <div className="empty">No scene.</div>;

  const selection = new Set(store.view.selection);

  const renderRow = (obj: SceneObject, depth: number) => {
    const kids = childrenOf(scene, obj.id);
    return (
      <div key={obj.id}>
        <div
          className={`outliner-row ${selection.has(obj.id) ? "active" : ""} ${dropId === obj.id ? "drop" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={() => setDragId(obj.id)}
          onDragOver={(e) => {
            e.preventDefault();
            setDropId(obj.id);
          }}
          onDragLeave={() => setDropId((d) => (d === obj.id ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== obj.id) store.reparent([dragId], obj.id);
            setDragId(null);
            setDropId(null);
          }}
          onClick={(e) =>
            e.shiftKey ? store.toggleSelection(obj.id) : store.setSelection([obj.id])
          }
          onDoubleClick={() => {
            store.setSelection([obj.id]);
            store.frameSelection();
          }}
          title="Double-click to bring it into view (F)"
        >
          <span className="glyph">{glyphFor(obj, store, doc?.rootId)}</span>
          <span className="name">{obj.name}</span>
          {obj.prefab && <span className="meta">{obj.prefab}</span>}
          <button
            className="mini"
            title={obj.visible ? "Hide" : "Show"}
            onClick={(e) => {
              e.stopPropagation();
              store.setObjectProp(obj.id, "visible", !obj.visible, "Toggle visibility");
            }}
          >
            {obj.visible ? "◉" : "○"}
          </button>
        </div>
        {kids.map((kid) => renderRow(kid, depth + 1))}
      </div>
    );
  };

  const doc = store.prefabDoc;

  return (
    <div className="tree">
      <div
        className="tree-heading"
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          // On the isolated stage there is no "outside the prefab" to drop
          // onto: everything on it is part of the definition.
          if (dragId && !doc) store.reparent([dragId], null);
          setDragId(null);
        }}
      >
        <span>{doc ? "PREFAB CONTENTS" : scene.name}</span>
        <button className="mini" onClick={() => store.groupSelection()} title="Group selection (Ctrl/⌘G)">
          group
        </button>
      </div>
      {scene.layers
        .slice()
        .reverse()
        .map((layer) => (
          <div key={layer.id}>
            <div className="tree-group">
              {layer.name} · {layer.kind}
            </div>
            {layer.kind === "tile" ? (
              <div className="outliner-row static" style={{ paddingLeft: 22 }}>
                <span className="glyph">▦</span>
                {(layer as TileLayer).layer} · from Tiled
              </div>
            ) : (
              scene.objects
                .filter((o) => o.layerId === layer.id && !o.parentId)
                .map((obj) => renderRow(obj, 1))
            )}
          </div>
        ))}
    </div>
  );
}

/** ◆ the definition's root · ⬡ a nested instance · ◈ an instance of a variant. */
function glyphFor(
  obj: SceneObject,
  store: { resolvePrefab: (name: string | undefined) => { base?: string } | undefined },
  rootId?: string,
): string {
  if (rootId && obj.id === rootId) return "◆";
  if (obj.prefab) return store.resolvePrefab(obj.prefab)?.base ? "◈" : "⬡";
  return obj.type === "container" ? "▣" : "◻";
}

/**
 * Object layers and tile layers share one list, because draw order must be
 * one ordering and not two.
 */
function Layers() {
  const { store } = useEditor();
  const scene = store.scene;
  if (!scene) return <div className="empty">No scene.</div>;

  return (
    <div className="tree">
      <div className="tree-heading">
        <span>Layers (top first)</span>
        <span>
          <button
            className="mini"
            onClick={() => store.setUi({ inspectorTab: "tile" })}
            title="Place a Tiled map in this scene"
          >
            + map
          </button>
          <button className="mini" onClick={() => store.addLayer()}>
            + object
          </button>
        </span>
      </div>

      {scene.layers
        .slice()
        .reverse()
        .map((layer) => {
          const depth = scene.layers.indexOf(layer);
          return (
            <div
              key={layer.id}
              className={`layer-row ${store.view.activeLayerId === layer.id ? "active" : ""}`}
              onClick={() => store.setActiveLayer(layer.id)}
            >
              <button
                className="mini"
                title={layer.visible ? "Hide layer" : "Show layer"}
                onClick={(e) => {
                  e.stopPropagation();
                  store.updateLayer(layer.id, { visible: !layer.visible });
                }}
              >
                {layer.visible ? "◉" : "○"}
              </button>
              <button
                className="mini"
                title={layer.locked ? "Unlock layer" : "Lock layer (ignores pointer events)"}
                onClick={(e) => {
                  e.stopPropagation();
                  store.updateLayer(layer.id, { locked: !layer.locked });
                }}
              >
                {layer.locked ? "🔒" : "🔓"}
              </button>
              <span className="glyph">{layer.kind === "tile" ? "▦" : "◻"}</span>
              <span className="name">{layer.name}</span>
              <span className="meta">depth {depth}</span>
              <button
                className="mini"
                onClick={(e) => {
                  e.stopPropagation();
                  store.moveLayer(layer.id, 1);
                }}
                title="Move up"
              >
                ↑
              </button>
              <button
                className="mini"
                onClick={(e) => {
                  e.stopPropagation();
                  store.moveLayer(layer.id, -1);
                }}
                title="Move down"
              >
                ↓
              </button>
              <button
                className="mini danger"
                onClick={(e) => {
                  e.stopPropagation();
                  store.removeLayer(layer.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
    </div>
  );
}
