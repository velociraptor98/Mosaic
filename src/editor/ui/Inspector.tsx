import { useEffect, useState } from "react";
import { TILE_DEFS } from "../../shared/definitions";
import {
  getPath,
  isExposed,
  isOverridden,
  resolveObject,
  resolvePrefab,
} from "../../shared/prefabs";
import type { InspectorTab } from "../store/project";
import { bodyForSize, objectSize } from "../../shared/size";
import { DEFAULT_CAMERA, type AssetDef, type SceneObject, type TileLayer } from "../../shared/types";
import { CheckField, JsonField, NumberField, SelectField, TextField } from "./fields";
import { PrefabPanel } from "./PrefabPanel";
import { ScriptsTab } from "./ScriptsTab";
import { useEditor, useStoreVersion } from "./context";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "object", label: "Object" },
  { id: "tile", label: "Tiles" },
  { id: "physics", label: "Physics" },
  { id: "scripts", label: "Scripts" },
  { id: "prefab", label: "Prefab" },
  { id: "anim", label: "Anim" },
  { id: "scene", label: "Scene" },
];

export function Inspector() {
  const { store } = useEditor();
  useStoreVersion(store);
  // The count rides on the tab for the same reason it rides on the outliner
  // row: an object having behaviour should be visible without opening it.
  const selected = store.selection[0];
  const scriptCount = selected ? store.scriptsFor(selected).length : 0;

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
            {tab.id === "scripts" && scriptCount > 0 && <span className="tab-count">{scriptCount}</span>}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {store.ui.inspectorTab === "object" && <ObjectTab />}
        {store.ui.inspectorTab === "tile" && <TileTab />}
        {store.ui.inspectorTab === "physics" && <PhysicsTab />}
        {store.ui.inspectorTab === "scripts" && <ScriptsTab />}
        {store.ui.inspectorTab === "prefab" && <PrefabPanel />}
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
  const prefab = resolvePrefab(store.project, obj.prefab);
  const resolved = resolveObject(store.project, obj);
  const runtime = playtest.playing ? playtest.readRuntime(obj.id) : null;
  const owners = selection
    .map((o) => resolvePrefab(store.project, o.prefab))
    .filter((p): p is NonNullable<typeof p> => !!p);

  /**
   * Why a field cannot be edited here, when it cannot.
   *
   * Only exposed fields are editable in a level — that is the contract the
   * prefab wrote. A multi-selection of mixed prefabs offers only what ALL of
   * them expose, because a field one of them owns is not editable for the set.
   */
  const lockedBy = (path: string): string | undefined => {
    if (playtest.playing || !owners.length) return undefined;
    const blocking = owners.filter((p) => !isExposed(p, path));
    if (!blocking.length) return undefined;
    const names = [...new Set(blocking.map((p) => p.name))].join(", ");
    return `Owned by ${names} — expose it in prefab edit mode to change it per instance.`;
  };

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
        locked={lockedBy(path)}
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
        marked={marked("visible")}
        locked={lockedBy("visible")}
        onRevert={() => revert("visible")}
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

      {!multi && resolved.text && (
        <>
          <div className="section-title">Text</div>
          <TextFields obj={obj} def={resolved.text} onCommit={commit} locked={lockedBy} />
        </>
      )}

      {!multi && !resolved.text && (
        <>
          <div className="section-title">Appearance</div>
          <TextureFields
            obj={obj}
            resolved={resolved}
            onCommit={commit}
            marked={marked}
            locked={lockedBy}
          />
        </>
      )}

      <div className="section-title">Group</div>
      <SelectField
        label="Collision group"
        value={sharedValue<string>(selection, "group") ?? ""}
        marked={marked("group")}
        locked={lockedBy("group")}
        onRevert={() => revert("group")}
        options={[
          { value: "", label: "(none)" },
          ...store.project.groups.map((g) => ({ value: g, label: g })),
        ]}
        onCommit={(v) => commit("group", v || undefined, "Set group")}
      />

      {!multi && <SoundFields obj={obj} resolved={resolved} onCommit={commit} locked={lockedBy} />}

      {!multi && (
        <>
          <div className="section-title">Data</div>
          <JsonField
            label="Per-instance properties"
            value={resolved.data}
            locked={lockedBy("data")}
            onCommit={(v) => commit("data", v, "Edit data")}
          />
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

/**
 * Everything the editor can say about a piece of text. `fixed` is the one that
 * makes a HUD a HUD: pinned to the camera, so it stays put while the level
 * scrolls under it.
 */
function TextFields({
  obj,
  def,
  onCommit,
  locked,
}: {
  obj: SceneObject;
  def: NonNullable<SceneObject["text"]>;
  onCommit: (path: string, value: unknown, label?: string) => void;
  locked: (path: string) => string | undefined;
}) {
  void obj;
  return (
    <>
      <div className="field json">
        <span className="field-label">Content</span>
        <textarea
          rows={3}
          value={def.content}
          disabled={!!locked("text.content")}
          onChange={(e) => onCommit("text.content", e.target.value, "Edit text")}
        />
      </div>
      <div className="grid2">
        <TextField
          label="Font"
          value={def.fontFamily}
          locked={locked("text.fontFamily")}
          onCommit={(v) => onCommit("text.fontFamily", v, "Set font")}
        />
        <NumberField
          label="Size"
          value={def.fontSize}
          locked={locked("text.fontSize")}
          onCommit={(v) => onCommit("text.fontSize", v, "Set font size")}
        />
      </div>
      <div className="grid2">
        <TextField
          label="Colour"
          value={def.color}
          locked={locked("text.color")}
          onCommit={(v) => onCommit("text.color", v, "Set colour")}
        />
        <SelectField
          label="Align"
          value={def.align}
          locked={locked("text.align")}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Centre" },
            { value: "right", label: "Right" },
          ]}
          onCommit={(v) => onCommit("text.align", v, "Set alignment")}
        />
      </div>
      <NumberField
        label="Wrap width (0 = none)"
        value={def.wrapWidth}
        locked={locked("text.wrapWidth")}
        onCommit={(v) => onCommit("text.wrapWidth", v, "Set wrap width")}
      />
      <CheckField
        label="Pin to camera (HUD)"
        value={!!def.fixed}
        locked={locked("text.fixed")}
        onCommit={(v) => onCommit("text.fixed", v || undefined, "Pin to camera")}
      />
      <div className="hint">
        Pinned text ignores the camera, so a score or a timer stays where you put it however far
        the level scrolls.
      </div>
    </>
  );
}

/**
 * The two audio cues that are content rather than behaviour. Anything
 * conditional — a sound only when the player is falling — is a script.
 */
function SoundFields({
  obj,
  resolved,
  onCommit,
  locked,
}: {
  obj: SceneObject;
  resolved: SceneObject;
  onCommit: (path: string, value: unknown, label?: string) => void;
  locked: (path: string) => string | undefined;
}) {
  const { store } = useEditor();
  const clips = store.project.assets.filter((a) => a.kind === "audio");
  void obj;

  if (!clips.length) {
    return (
      <>
        <div className="section-title">Sound</div>
        <div className="hint">
          No audio in this project yet. Import a clip and it can be played on spawn, or when this
          object overlaps something the collision matrix pairs it with.
        </div>
      </>
    );
  }

  const options = [
    { value: "", label: "(none)" },
    ...clips.map((a) => ({ value: a.key, label: a.key })),
  ];
  return (
    <>
      <div className="section-title">Sound</div>
      <SelectField
        label="On spawn"
        value={resolved.sounds?.spawn ?? ""}
        locked={locked("sounds.spawn")}
        options={options}
        onCommit={(v) => onCommit("sounds.spawn", v || undefined, "Set spawn sound")}
      />
      <SelectField
        label="On overlap"
        value={resolved.sounds?.overlap ?? ""}
        locked={locked("sounds.overlap")}
        options={options}
        onCommit={(v) => onCommit("sounds.overlap", v || undefined, "Set overlap sound")}
      />
      <div className="hint">
        The overlap cue fires for any pair the collision matrix marks as overlapping. Anything
        conditional belongs in a script.
      </div>
    </>
  );
}

function TextureFields({
  obj,
  resolved,
  onCommit,
  marked,
  locked,
}: {
  obj: SceneObject;
  resolved: SceneObject;
  onCommit: (path: string, value: unknown, label?: string) => void;
  marked: (path: string) => boolean;
  locked: (path: string) => string | undefined;
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
        locked={locked("texture")}
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
          locked={locked("frame")}
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
        onCommit={(on) =>
          set("body", on ? bodyForSize(objectSize(store.project, resolved)) : undefined)
        }
      />
      {!body && (
        <div className="hint">
          Defaults come from the object's own art — the atlas frame, the spritesheet cell, or the
          whole image. Box or circle covers the common cases; arbitrary polygons are a Matter-only
          concern.
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

/**
 * The camera, as scene data.
 *
 * A level that scrolls is the normal case, and it used to be unauthorable —
 * the exporter set a background colour and world bounds and nothing else, so
 * following the player meant hand-written code in every scene.
 */
function CameraFields() {
  const { store } = useEditor();
  const scene = store.scene!;
  const cam = scene.settings.camera ?? DEFAULT_CAMERA;
  const named = scene.objects.map((o) => o.name);

  const set = (patch: Partial<typeof cam>) =>
    store.transact("Camera settings", () => {
      scene.settings.camera = { ...cam, ...patch };
    });

  return (
    <>
      <div className="section-title">Camera</div>
      <SelectField
        label="Follow"
        value={cam.follow}
        options={[
          { value: "", label: "(fixed camera)" },
          ...named.map((n) => ({ value: n, label: n })),
        ]}
        onCommit={(v) => set({ follow: v })}
      />
      {cam.follow && !named.includes(cam.follow) && (
        <div className="banner error">
          Nothing in this scene is called "{cam.follow}" — the camera will not follow anything.
        </div>
      )}
      {cam.follow && (
        <>
          <div className="grid2">
            <NumberField label="Lerp X" value={cam.lerpX} step={0.05} onCommit={(v) => set({ lerpX: v })} />
            <NumberField label="Lerp Y" value={cam.lerpY} step={0.05} onCommit={(v) => set({ lerpY: v })} />
          </div>
          <div className="grid2">
            <NumberField label="Deadzone W" value={cam.deadzoneWidth} onCommit={(v) => set({ deadzoneWidth: v })} />
            <NumberField label="Deadzone H" value={cam.deadzoneHeight} onCommit={(v) => set({ deadzoneHeight: v })} />
          </div>
          <div className="hint">
            Lerp 1 is rigid; lower values trail behind. A deadzone is a box in the middle the
            target can move inside before the camera bothers to follow.
          </div>
        </>
      )}
      <NumberField label="Zoom" value={cam.zoom} step={0.1} onCommit={(v) => set({ zoom: v })} />
      <CheckField
        label="Clamp to scene bounds"
        value={cam.clampToBounds}
        onCommit={(v) => set({ clampToBounds: v })}
      />
    </>
  );
}

/** Looping background music, which is content and not a line of create(). */
function MusicFields() {
  const { store } = useEditor();
  const scene = store.scene!;
  const clips = store.project.assets.filter((a) => a.kind === "audio");
  const music = scene.settings.music;

  const set = (patch: Partial<NonNullable<typeof music>> | null) =>
    store.transact("Scene music", () => {
      if (patch === null) delete scene.settings.music;
      else scene.settings.music = { key: "", volume: 1, loop: true, ...music, ...patch };
    });

  return (
    <>
      <div className="section-title">Music</div>
      {clips.length === 0 ? (
        <div className="hint">
          No audio in this project yet. Imported clips can be played here as looping background
          music for the scene.
        </div>
      ) : (
        <>
          <SelectField
            label="Track"
            value={music?.key ?? ""}
            options={[
              { value: "", label: "(none)" },
              ...clips.map((a) => ({ value: a.key, label: a.key })),
            ]}
            onCommit={(v) => (v ? set({ key: v }) : set(null))}
          />
          {music?.key && (
            <div className="grid2">
              <NumberField
                label="Volume"
                value={music.volume}
                step={0.05}
                onCommit={(v) => set({ volume: Math.max(0, Math.min(1, v)) })}
              />
              <CheckField label="Loop" value={music.loop} onCommit={(v) => set({ loop: v })} />
            </div>
          )}
        </>
      )}
    </>
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

      <CameraFields />
      <MusicFields />

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
