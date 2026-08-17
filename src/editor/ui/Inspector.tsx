import { useEffect, useState } from "react";
import { TILE_DEFS } from "../../shared/definitions";
import { findPrefab, getPath, isOverridden, resolveObject } from "../../shared/prefabs";
import type { InspectorTab } from "../store/project";
import { defaultBody } from "../store/templates";
import type { AssetDef, SceneObject, TileLayer } from "../../shared/types";
import { CheckField, JsonField, NumberField, SelectField, TextField } from "./fields";
import { useEditor, useStoreVersion } from "./context";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "object", label: "Object" },
  { id: "tile", label: "Tiles" },
  { id: "physics", label: "Physics" },
  { id: "prefab", label: "Prefab" },
  { id: "anim", label: "Anim" },
  { id: "scene", label: "Scene" },
];

export function Inspector() {
  const { store } = useEditor();
  useStoreVersion(store);

  return (
    <aside className="panel inspector">
      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={store.ui.inspectorTab === tab.id ? "active" : ""}
            onClick={() => store.setUi({ inspectorTab: tab.id })}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {store.ui.inspectorTab === "object" && <ObjectTab />}
        {store.ui.inspectorTab === "tile" && <TileTab />}
        {store.ui.inspectorTab === "physics" && <PhysicsTab />}
        {store.ui.inspectorTab === "prefab" && <PrefabTab />}
        {store.ui.inspectorTab === "anim" && <AnimTab />}
        {store.ui.inspectorTab === "scene" && <SceneTab />}
      </div>
    </aside>
  );
}

/** The properties a multi-selection shares — the shared-schema intersection. */
function sharedValue<T>(objects: SceneObject[], path: string): T | undefined {
  if (!objects.length) return undefined;
  const first = JSON.stringify(getPath(objects[0], path));
  for (const obj of objects.slice(1)) {
    if (JSON.stringify(getPath(obj, path)) !== first) return undefined;
  }
  return getPath(objects[0], path) as T;
}

function ObjectTab() {
  const { store, playtest } = useEditor();
  const selection = store.selection;
  const [, forceTick] = useState(0);

  // While the game runs the inspector binds to the LIVE instance, so tuning
  // happens against the running game rather than the saved scene.
  useEffect(() => {
    if (!playtest.playing) return;
    const t = window.setInterval(() => forceTick((n) => n + 1), 120);
    return () => window.clearInterval(t);
  }, [playtest.playing]);

  if (!selection.length) {
    return (
      <div className="empty">
        Select an object on the canvas, in the Outliner, or marquee a set of them.
      </div>
    );
  }

  const multi = selection.length > 1;
  const obj = selection[0];
  const prefab = findPrefab(store.project, obj.prefab);
  const resolved = resolveObject(store.project, obj);
  const runtime = playtest.playing ? playtest.readRuntime(obj.id) : null;

  const commit = (path: string, value: unknown, label?: string) => {
    if (playtest.playing) {
      playtest.setRuntimeProp(obj.id, path, value);
      store.setStatus(`Runtime edit (volatile): ${obj.name}.${path}`);
      return;
    }
    if (multi) store.setObjectsProp(selection.map((o) => o.id), path, value, label);
    else store.setObjectProp(obj.id, path, value, label);
  };

  const marked = (path: string) => !!prefab && isOverridden(obj, path);
  const revert = (path: string) => store.revertOverride(obj.id, path);

  const num = (path: string, label: string, step = 1) => {
    const value = playtest.playing && runtime && path in runtime
      ? Number(runtime[path])
      : (sharedValue<number>(selection, path) ?? 0);
    return (
      <NumberField
        key={path}
        label={label}
        value={value}
        step={step}
        marked={marked(path)}
        onRevert={() => revert(path)}
        onCommit={(v) => commit(path, v, `Set ${label}`)}
      />
    );
  };

  return (
    <div className="stack">
      {multi ? (
        <div className="section-title">
          {selection.length} objects selected — showing shared properties
        </div>
      ) : (
        <>
          <div className="kv">
            <span>Name</span>
            <TextField label="" value={obj.name} onCommit={(v) => commit("name", v, "Rename")} />
          </div>
          <div className="kv">
            <span>Type</span>
            <code>{resolved.type}</code>
          </div>
          <div className="kv">
            <span>ID</span>
            <code className="muted">{obj.id}</code>
          </div>
        </>
      )}

      {playtest.playing && (
        <div className="banner volatile">
          Bound to the running instance. Edits apply immediately and are marked
          <strong> volatile</strong> — stopping offers to promote them.
        </div>
      )}

      <div className="section-title">Transform</div>
      <div className="grid2">
        {num("x", "X")}
        {num("y", "Y")}
        {num("rotation", "Rotation°")}
        {num("scaleX", "Scale X", 0.05)}
        {num("scaleY", "Scale Y", 0.05)}
        {num("originX", "Origin X", 0.05)}
        {num("originY", "Origin Y", 0.05)}
      </div>
      <CheckField
        label="Visible"
        value={sharedValue<boolean>(selection, "visible") ?? true}
        onCommit={(v) => commit("visible", v, "Toggle visibility")}
      />

      {runtime && (
        <>
          <div className="section-title">Runtime</div>
          <div className="readout">
            <span>vx {String(runtime.velocityX)}</span>
            <span>vy {String(runtime.velocityY)}</span>
            <span>onFloor {String(runtime.onFloor)}</span>
          </div>
        </>
      )}

      {!multi && (
        <>
          <div className="section-title">Appearance</div>
          <TextureFields obj={obj} resolved={resolved} onCommit={commit} marked={marked} />
        </>
      )}

      <div className="section-title">Group</div>
      <SelectField
        label="Collision group"
        value={sharedValue<string>(selection, "group") ?? ""}
        marked={marked("group")}
        onRevert={() => revert("group")}
        options={[
          { value: "", label: "(none)" },
          ...store.project.groups.map((g) => ({ value: g, label: g })),
        ]}
        onCommit={(v) => commit("group", v || undefined, "Set group")}
      />

      {!multi && (
        <>
          <div className="section-title">Data</div>
          <JsonField label="Per-instance properties" value={resolved.data} onCommit={(v) => commit("data", v, "Edit data")} />
        </>
      )}

      <div className="row">
        <button className="ghost" onClick={() => store.duplicateObjects(selection.map((o) => o.id))}>
          Duplicate
        </button>
        <button className="danger" onClick={() => store.deleteObjects(selection.map((o) => o.id))}>
          Delete
        </button>
      </div>
    </div>
  );
}

function TextureFields({
  obj,
  resolved,
  onCommit,
  marked,
}: {
  obj: SceneObject;
  resolved: SceneObject;
  onCommit: (path: string, value: unknown, label?: string) => void;
  marked: (path: string) => boolean;
}) {
  const { store } = useEditor();
  const textures = store.project.assets.filter((a) => a.kind !== "audio");
  const current = textures.find((a) => a.key === resolved.texture);
  const frames = current?.frames ?? [];
  void obj;

  return (
    <>
      <SelectField
        label="Texture"
        value={resolved.texture ?? ""}
        marked={marked("texture")}
        options={[
          { value: "", label: "(none)" },
          ...textures.map((a) => ({ value: a.key, label: a.key })),
        ]}
        onCommit={(v) => onCommit("texture", v || undefined, "Set texture")}
      />
      {frames.length > 0 && (
        <SelectField
          label="Frame"
          value={resolved.frame ?? ""}
          marked={marked("frame")}
          options={[
            { value: "", label: "(base)" },
            ...frames.map((f) => ({ value: f.name, label: f.name })),
          ]}
          onCommit={(v) => onCommit("frame", v || undefined, "Set frame")}
        />
      )}
    </>
  );
}

/**
 * The tileset palette lives where the inspector was. Each tile carries its
 * collision flag, so terrain is authored once rather than twice.
 */
function TileTab() {
  const { store } = useEditor();
  const layer = store.activeLayer;

  if (!layer || layer.kind !== "tile") {
    return (
      <div className="empty">
        Select a tile layer in the LAYERS panel — tiles are painted onto a layer, and the layer
        binds the tileset.
      </div>
    );
  }

  const tile = layer as TileLayer;
  const tileset = store.project.assets.find((a) => a.id === tile.tilesetId);
  const brush = store.ui.brush;
  const tilesets = store.project.assets.filter((a) => a.kind === "tileset");

  return (
    <div className="stack">
      <SelectField
        label="Tileset"
        value={tile.tilesetId}
        options={tilesets.map((t) => ({ value: t.id, label: t.key }))}
        onCommit={(v) => store.updateLayer(tile.id, { tilesetId: v })}
      />
      <div className="grid2">
        <NumberField label="Tile W" value={tile.tileWidth} onCommit={(v) => store.updateLayer(tile.id, { tileWidth: v })} />
        <NumberField label="Tile H" value={tile.tileHeight} onCommit={(v) => store.updateLayer(tile.id, { tileHeight: v })} />
      </div>

      <div className="section-title">Brush</div>
      <div className="tile-palette">
        {tileset && <TileSwatches tileset={tileset} activeId={brush?.tileId ?? -1} />}
        <button
          className={`tile-swatch erase ${store.ui.tool === "erase" ? "active" : ""}`}
          onClick={() => store.setUi({ tool: "erase" })}
          title="Eraser is putTile(-1)"
        >
          ⌫
        </button>
      </div>
      <div className="hint">
        Click a tile to arm the brush. Collision flags come from the tileset definition, not the
        layer — click the flag chip to toggle.
      </div>
      {tileset && (
        <>
          <div className="section-title">Collision flags</div>
          <div className="chips">
            {TILE_DEFS.map((def) => {
              const on = (tileset.tileCollides ?? []).includes(def.index);
              return (
                <button
                  key={def.index}
                  className={`chip toggle ${on ? "on" : ""}`}
                  onClick={() => store.toggleTileCollision(tileset.id, def.index)}
                >
                  {def.index} {def.name}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function TileSwatches({ tileset, activeId }: { tileset: AssetDef; activeId: number }) {
  const { store } = useEditor();
  const tileW = tileset.frameWidth ?? 32;
  const tileH = tileset.frameHeight ?? 32;
  const perRow = Math.max(1, Math.floor((tileset.width - (tileset.margin ?? 0)) / (tileW + (tileset.spacing ?? 0))));
  const rows = Math.max(1, Math.floor((tileset.height - (tileset.margin ?? 0)) / (tileH + (tileset.spacing ?? 0))));
  const count = perRow * rows;

  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        const x = (tileset.margin ?? 0) + col * (tileW + (tileset.spacing ?? 0));
        const y = (tileset.margin ?? 0) + row * (tileH + (tileset.spacing ?? 0));
        return (
          <button
            key={i}
            className={`tile-swatch ${activeId === i ? "active" : ""}`}
            title={`tile ${i}${(tileset.tileCollides ?? []).includes(i) ? " · collides" : ""}`}
            onClick={() => store.setBrush(tileset.id, i)}
            style={{
              backgroundImage: `url(${tileset.url})`,
              backgroundPosition: `-${x}px -${y}px`,
              width: tileW,
              height: tileH,
            }}
          >
            {(tileset.tileCollides ?? []).includes(i) && <span className="collide-dot" />}
          </button>
        );
      })}
    </>
  );
}

/** Bodies are a section of the object, not a separate editor. */
function PhysicsTab() {
  const { store, openDialog } = useEditor();
  const selection = store.selection;
  if (!selection.length) return <div className="empty">Select an object to give it a body.</div>;

  const obj = selection[0];
  const resolved = resolveObject(store.project, obj);
  const body = resolved.body;

  const set = (path: string, value: unknown) =>
    store.setObjectsProp(selection.map((o) => o.id), path, value, "Edit body");

  return (
    <div className="stack">
      <div className="section-title">Arcade body</div>
      <CheckField
        label="Body enabled"
        value={!!body}
        onCommit={(on) => set("body", on ? defaultBody(resolved.type) : undefined)}
      />
      {!body && (
        <div className="hint">
          Defaults derive from the frame's trimmed bounds. Box or circle covers the common cases;
          arbitrary polygons are a Matter-only concern.
        </div>
      )}
      {body && (
        <>
          <SelectField
            label="Shape"
            value={body.shape}
            options={[
              { value: "box", label: "Box" },
              { value: "circle", label: "Circle" },
            ]}
            onCommit={(v) => set("body.shape", v)}
          />
          {body.shape === "box" ? (
            <div className="grid2">
              <NumberField label="Width" value={body.width} onCommit={(v) => set("body.width", v)} />
              <NumberField label="Height" value={body.height} onCommit={(v) => set("body.height", v)} />
            </div>
          ) : (
            <NumberField label="Radius" value={body.radius} onCommit={(v) => set("body.radius", v)} />
          )}
          <div className="grid2">
            <NumberField label="Offset X" value={body.offsetX} onCommit={(v) => set("body.offsetX", v)} />
            <NumberField label="Offset Y" value={body.offsetY} onCommit={(v) => set("body.offsetY", v)} />
          </div>
          <CheckField label="Immovable" value={body.immovable} onCommit={(v) => set("body.immovable", v)} />
          <CheckField label="Allow gravity" value={body.allowGravity} onCommit={(v) => set("body.allowGravity", v)} />
          <NumberField label="Bounce" value={body.bounce} step={0.05} onCommit={(v) => set("body.bounce", v)} />
          <button
            className={`ghost ${store.ui.showBodies ? "on" : ""}`}
            onClick={() => store.setUi({ showBodies: !store.ui.showBodies })}
          >
            {store.ui.showBodies ? "Hide" : "Show"} body overlay + handles
          </button>
        </>
      )}

      <div className="section-title">Collision matrix</div>
      <div className="hint">
        Pair rules are authored once per project instead of being scattered through create().
      </div>
      <button className="ghost" onClick={() => openDialog("collision")}>
        Edit collision matrix…
      </button>
    </div>
  );
}

function PrefabTab() {
  const { store, openDialog } = useEditor();
  const selection = store.selection;
  if (!selection.length) {
    return (
      <div className="empty">
        Select the repeated objects, then create a prefab from them.
        <button className="ghost" onClick={() => openDialog("prefab")}>
          Create prefab…
        </button>
      </div>
    );
  }

  const obj = selection[0];
  const prefab = findPrefab(store.project, obj.prefab);

  if (!prefab) {
    return (
      <div className="stack">
        <div className="empty">
          {selection.length} plain object(s) selected. Turning them into a prefab replaces each
          with {"{prefab, transform, overrides}"}.
        </div>
        <button className="primary" onClick={() => openDialog("prefab")}>
          Create prefab from selection…
        </button>
      </div>
    );
  }

  const overrides = Object.entries(obj.overrides ?? {});
  const instances = store.project.scenes.flatMap((s) =>
    s.objects.filter((o) => o.prefab === prefab.name).map((o) => ({ scene: s.key, obj: o })),
  );

  return (
    <div className="stack">
      <div className="section-title">Prefab instance</div>
      <div className="kv">
        <span>Definition</span>
        <code>prefabs/{prefab.name}.prefab.json</code>
      </div>
      <div className="kv">
        <span>Instances</span>
        <code>{instances.length} across {new Set(instances.map((i) => i.scene)).size} scene(s)</code>
      </div>

      <div className="section-title">Exposed properties</div>
      <div className="chips">
        {prefab.exposed.length === 0 && <span className="empty">Nothing is overridable.</span>}
        {prefab.exposed.map((path) => (
          <span key={path} className={`chip ${isOverridden(obj, path) ? "on" : ""}`}>
            {path}
          </span>
        ))}
      </div>

      <div className="section-title">Overrides on {obj.name}</div>
      {overrides.length === 0 && (
        <div className="hint">
          Every field is linked to the definition. Editing an exposed field here records an
          override; untouched fields keep updating with the prefab.
        </div>
      )}
      {overrides.map(([path, value]) => (
        <div key={path} className="override-row">
          <code>{path}</code>
          <span>{JSON.stringify(value)}</span>
          <span className="muted">was {JSON.stringify(getPath(prefab.root, path))}</span>
          <button className="mini" title="Revert to definition" onClick={() => store.revertOverride(obj.id, path)}>
            ⟲
          </button>
        </div>
      ))}

      <div className="row">
        <button className="ghost" onClick={() => store.applyInstanceToPrefab(obj.id)}>
          Apply to prefab
        </button>
        <button className="ghost" onClick={() => store.unpackInstance(obj.id)}>
          Unpack instance
        </button>
      </div>
      <div className="hint">
        Applying pushes this instance's overrides into the definition; every other instance picks
        them up except where it overrides the same field.
      </div>
    </div>
  );
}

function AnimTab() {
  const { store } = useEditor();
  const selection = store.selection;
  const anims = store.project.anims;

  if (!selection.length) {
    return (
      <div className="empty">
        Select an object to name the animation it plays on spawn. Build animations in the bottom
        dock.
      </div>
    );
  }
  const obj = selection[0];
  const resolved = resolveObject(store.project, obj);
  const missing = resolved.playOnSpawn && !anims.some((a) => a.key === resolved.playOnSpawn);

  return (
    <div className="stack">
      <div className="section-title">Animations</div>
      <SelectField
        label="Play on spawn"
        value={resolved.playOnSpawn ?? ""}
        options={[
          { value: "", label: "(none)" },
          ...anims.map((a) => ({ value: a.key, label: `${a.key} · ${a.frames.length}f @ ${a.fps}fps` })),
        ]}
        onCommit={(v) =>
          store.setObjectsProp(
            selection.map((o) => o.id),
            "playOnSpawn",
            v || undefined,
            "Set animation",
          )
        }
      />
      {missing && (
        <div className="banner error">
          Animation "{resolved.playOnSpawn}" does not exist — this is a validation error, not a
          silent no-op.
        </div>
      )}
      <button className="ghost" onClick={() => store.setUi({ dockTab: "anim" })}>
        Open the animation timeline
      </button>
    </div>
  );
}

function SceneTab() {
  const { store } = useEditor();
  const scene = store.scene;
  if (!scene) return <div className="empty">No scene.</div>;

  const set = (patch: Partial<typeof scene.settings>) =>
    store.transact("Scene settings", () => Object.assign(scene.settings, patch));

  const issues = store.validate();

  return (
    <div className="stack">
      <TextField label="Name" value={scene.name} onCommit={(v) => store.renameScene(scene.key, v)} />
      <div className="kv">
        <span>Key</span>
        <code>{scene.key}</code>
      </div>
      <div className="grid2">
        <NumberField label="Width" value={scene.settings.width} onCommit={(v) => set({ width: v })} />
        <NumberField label="Height" value={scene.settings.height} onCommit={(v) => set({ height: v })} />
        <NumberField label="Grid" value={scene.settings.gridSize} onCommit={(v) => set({ gridSize: v })} />
        <NumberField label="Gravity Y" value={scene.settings.gravityY} onCommit={(v) => set({ gravityY: v })} />
      </div>
      <TextField
        label="Background"
        value={scene.settings.backgroundColor}
        onCommit={(v) => set({ backgroundColor: v })}
      />

      <div className="section-title">Validation</div>
      {issues.length === 0 ? (
        <div className="hint">No problems found.</div>
      ) : (
        issues.map((issue, i) => (
          <div key={i} className={`banner ${issue.level}`}>
            {issue.message}
          </div>
        ))
      )}
    </div>
  );
}
