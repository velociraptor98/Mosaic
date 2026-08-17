import { useState } from "react";
import { childrenOf } from "../../shared/transform";
import type { LeftTab } from "../store/project";
import type { SceneObject, TileLayer } from "../../shared/types";
import { platform } from "../platform";
import { MANIFEST_PATH, scenePath } from "../project/serialize";
import { useEditor, useStoreVersion, useWorkspace } from "./context";

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
  const git = workspace.git;

  return (
    <div className="tree">
      <div className="tree-heading">
        <span>{store.project.name}</span>
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

      {workspace.isOpen && (
        <div className="project-root" title={workspace.location!.root}>
          {workspace.location!.root}
        </div>
      )}

      {workspace.issues.length > 0 && (
        <div className="banner warn">
          {workspace.issues.length} issue(s) reading this folder: {workspace.issues[0]}
        </div>
      )}

      <div className="tree-group">src/scenes</div>
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
            <GitBadge code={git[scenePath(scene.key)]} />
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

      {platform.canGit && (
        <div className="tree-group">
          manifest <GitBadge code={git[MANIFEST_PATH]} />
        </div>
      )}

      <div className="tree-group">prefabs</div>
      {store.project.prefabs.length === 0 && <div className="empty">No prefabs yet.</div>}
      {store.project.prefabs.map((prefab) => (
        <div key={prefab.name} className="tree-row-wrap">
          <button
            className="tree-row"
            onClick={() =>
              store.setUi({ tool: "place", placement: { kind: "prefab", id: prefab.name } })
            }
            title={`Exposed: ${prefab.exposed.join(", ") || "nothing"}`}
          >
            <span className="glyph">⬡</span>
            {prefab.name}.prefab.json
          </button>
          <button className="mini danger" onClick={() => store.deletePrefab(prefab.name)}>
            ×
          </button>
        </div>
      ))}

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
        >
          <span className="glyph">{obj.type === "container" ? "▣" : obj.prefab ? "⬡" : "◻"}</span>
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

  return (
    <div className="tree">
      <div
        className="tree-heading"
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (dragId) store.reparent([dragId], null);
          setDragId(null);
        }}
      >
        <span>{scene.name}</span>
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
                {(layer as TileLayer).cols}×{(layer as TileLayer).rows} tiles
              </div>
            ) : (
              scene.objects
                .filter((o) => o.layerId === layer.id && !o.parentId)
                .map((obj) => renderRow(obj, 1))
            )}
          </div>
        ))}
      <div className="hint">Drag a row onto another to reparent — world position is preserved, cycles are rejected.</div>
    </div>
  );
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
          <button className="mini" onClick={() => store.addLayer("tile")}>
            + tile
          </button>
          <button className="mini" onClick={() => store.addLayer("object")}>
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
      <div className="hint">
        Layer order is render order, and becomes the Phaser depth on export. Visibility and lock
        are scene data, not editor preferences.
      </div>
    </div>
  );
}
