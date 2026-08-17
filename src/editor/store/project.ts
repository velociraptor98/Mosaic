import {
  INSTANCE_OWNED,
  findPrefab,
  getPath,
  setPath,
  toPrefabNode,
} from "../../shared/prefabs";
import { objectsById, wouldCycle, descendantIds } from "../../shared/transform";
import type {
  AnimDef,
  AssetDef,
  CollisionRule,
  Layer,
  ObjectLayer,
  PrefabDef,
  ProjectData,
  SceneData,
  SceneObject,
  TileLayer,
} from "../../shared/types";
import { uid, uniqueKey, uniqueName } from "./ids";
import {
  createSceneFromTemplate,
  createStarterProject,
  makeTileLayer,
  type TemplateId,
} from "./templates";
import { UndoStack, type SliceChange } from "./undo";

export type Tool = "select" | "place" | "brush" | "rect" | "erase";
export type LeftTab = "project" | "outliner" | "layers";
export type DockTab = "assets" | "anim";
export type InspectorTab = "object" | "tile" | "physics" | "prefab" | "anim" | "scene";

export interface ViewState {
  selection: string[];
  activeLayerId: string | null;
  camera: { x: number; y: number; zoom: number };
}

export interface Placement {
  kind: "object" | "asset" | "prefab";
  /** object type, asset id, or prefab name */
  id: string;
  frame?: string;
}

export interface UiState {
  tool: Tool;
  placement: Placement | null;
  brush: { tilesetId: string; tileId: number } | null;
  snap: boolean;
  showGrid: boolean;
  showBodies: boolean;
  leftTab: LeftTab;
  dockTab: DockTab;
  inspectorTab: InspectorTab;
  animKey: string | null;
  status: string;
  watchExport: boolean;
}

const STORAGE_KEY = "mosaic:project:v1";
/** Pre-rename key, read once so an existing project survives the rename. */
const LEGACY_STORAGE_KEYS = ["phaser-scene-editor:project:v2"];

/**
 * The editor's single source of truth outside the Phaser canvas.
 *
 * Every mutation runs inside `transact()`, which snapshots the slices it
 * touched and pushes one undo entry onto the ACTIVE SCENE's stack. Slices are
 * per-scene (plus prefabs / assets / anims / collision), so undoing an edit in
 * one scene never rewinds a later edit in another.
 */
export class ProjectStore {
  project: ProjectData;
  activeSceneKey: string;
  views = new Map<string, ViewState>();
  ui: UiState = {
    tool: "select",
    placement: null,
    brush: null,
    snap: true,
    showGrid: true,
    showBodies: false,
    leftTab: "project",
    dockTab: "assets",
    inspectorTab: "object",
    animKey: null,
    status: "Ready",
    watchExport: false,
  };

  private stacks = new Map<string, UndoStack>();
  private savedDepth = new Map<string, number>();
  private listeners = new Set<() => void>();
  private strokeBefore: Map<string, Snapshot> | null = null;
  private strokeLabel = "";
  private txDepth = 0;
  private persistTimer: number | null = null;
  /**
   * Where persistence goes. The browser build leaves this null and falls back
   * to localStorage; the desktop build points it at the project folder, which
   * is why a desktop project has no storage ceiling.
   */
  private persister: ((project: ProjectData) => void) | null = null;
  version = 0;
  storageWarning: string | null = null;

  constructor(project?: ProjectData) {
    this.project = project ?? loadPersisted() ?? createStarterProject();
    this.activeSceneKey = this.project.scenes[0]?.key ?? "";
    for (const scene of this.project.scenes) this.ensureView(scene);
  }

  // -------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  /** Notify listeners after an in-place mutation made inside an open stroke. */
  touch(): void {
    this.emit();
  }

  setStatus(status: string): void {
    this.ui.status = status;
    this.emit();
  }

  setUi(patch: Partial<UiState>): void {
    Object.assign(this.ui, patch);
    this.emit();
  }

  // -------------------------------------------------------------------
  // Scene / view accessors
  // -------------------------------------------------------------------

  get scene(): SceneData | null {
    return this.project.scenes.find((s) => s.key === this.activeSceneKey) ?? null;
  }

  get view(): ViewState {
    const scene = this.scene;
    if (!scene) return { selection: [], activeLayerId: null, camera: { x: 0, y: 0, zoom: 1 } };
    return this.ensureView(scene);
  }

  get selection(): SceneObject[] {
    const scene = this.scene;
    if (!scene) return [];
    const ids = new Set(this.view.selection);
    return scene.objects.filter((o) => ids.has(o.id));
  }

  get activeLayer(): Layer | null {
    const scene = this.scene;
    if (!scene) return null;
    return scene.layers.find((l) => l.id === this.view.activeLayerId) ?? scene.layers[0] ?? null;
  }

  stack(key = this.activeSceneKey): UndoStack {
    let s = this.stacks.get(key);
    if (!s) {
      s = new UndoStack();
      this.stacks.set(key, s);
    }
    return s;
  }

  isDirty(key: string): boolean {
    return this.stack(key).depth !== (this.savedDepth.get(key) ?? 0);
  }

  markSaved(key = this.activeSceneKey): void {
    this.savedDepth.set(key, this.stack(key).depth);
    this.emit();
  }

  private ensureView(scene: SceneData): ViewState {
    let view = this.views.get(scene.key);
    if (!view) {
      // Start on an object layer when there is one: the select/place tools are
      // the default, and they need somewhere to put things.
      const initial =
        scene.layers.find((l) => l.kind === "object") ?? scene.layers[0];
      view = {
        selection: [],
        activeLayerId: initial?.id ?? null,
        camera: { x: 0, y: 0, zoom: 1 },
      };
      this.views.set(scene.key, view);
    }
    if (!scene.layers.some((l) => l.id === view!.activeLayerId)) {
      view.activeLayerId = scene.layers[0]?.id ?? null;
    }
    return view;
  }

  // -------------------------------------------------------------------
  // Transactions + undo
  // -------------------------------------------------------------------

  /** One undoable unit of work. Nested calls fold into the outer one. */
  transact(label: string, fn: () => void): void {
    if (this.txDepth > 0 || this.strokeBefore) {
      fn();
      if (this.txDepth === 0) {
        this.emit();
        this.schedulePersist();
      }
      return;
    }
    const before = this.captureAll();
    this.txDepth += 1;
    try {
      fn();
    } finally {
      this.txDepth -= 1;
    }
    const changes = this.diff(before);
    if (changes.length) this.stack().push({ label, changes });
    this.emit();
    this.schedulePersist();
  }

  /**
   * Opens a transaction that spans many mutations — a paint stroke, or a
   * drag — so the whole gesture costs exactly one undo instead of fifty.
   */
  beginStroke(label: string): void {
    if (this.strokeBefore) return;
    this.strokeLabel = label;
    this.strokeBefore = this.captureAll();
  }

  endStroke(): void {
    if (!this.strokeBefore) return;
    const before = this.strokeBefore;
    this.strokeBefore = null;
    const changes = this.diff(before);
    if (changes.length) this.stack().push({ label: this.strokeLabel, changes });
    this.emit();
    this.schedulePersist();
  }

  cancelStroke(): void {
    if (!this.strokeBefore) return;
    const before = this.strokeBefore;
    this.strokeBefore = null;
    for (const [slice, snap] of before) this.writeSlice(slice, snap.clone);
    this.emit();
  }

  undo(): void {
    const entry = this.stack().undo();
    if (!entry) {
      this.setStatus("Nothing to undo");
      return;
    }
    for (const change of entry.changes) this.writeSlice(change.slice, clone(change.before));
    this.ui.status = `Undo: ${entry.label}`;
    this.emit();
    this.schedulePersist();
  }

  redo(): void {
    const entry = this.stack().redo();
    if (!entry) {
      this.setStatus("Nothing to redo");
      return;
    }
    for (const change of entry.changes) this.writeSlice(change.slice, clone(change.after));
    this.ui.status = `Redo: ${entry.label}`;
    this.emit();
    this.schedulePersist();
  }

  private sliceKeys(): string[] {
    return [
      "meta",
      "prefabs",
      "assets",
      "anims",
      "groups",
      "collision",
      ...this.project.scenes.map((s) => `scene:${s.key}`),
    ];
  }

  private readSlice(slice: string): unknown {
    if (slice.startsWith("scene:")) {
      const key = slice.slice(6);
      return this.project.scenes.find((s) => s.key === key) ?? null;
    }
    switch (slice) {
      case "meta":
        return { name: this.project.name, order: this.project.scenes.map((s) => s.key) };
      case "prefabs":
        return this.project.prefabs;
      case "assets":
        return this.project.assets;
      case "anims":
        return this.project.anims;
      case "groups":
        return this.project.groups;
      case "collision":
        return this.project.collision;
      default:
        return null;
    }
  }

  private writeSlice(slice: string, value: unknown): void {
    if (slice.startsWith("scene:")) {
      const key = slice.slice(6);
      const idx = this.project.scenes.findIndex((s) => s.key === key);
      if (value === null) {
        if (idx >= 0) this.project.scenes.splice(idx, 1);
      } else if (idx >= 0) {
        this.project.scenes[idx] = value as SceneData;
      } else {
        this.project.scenes.push(value as SceneData);
      }
      const scene = this.scene;
      if (scene) this.ensureView(scene);
      else this.activeSceneKey = this.project.scenes[0]?.key ?? "";
      return;
    }
    switch (slice) {
      case "meta": {
        const meta = value as { name: string; order: string[] };
        this.project.name = meta.name;
        this.project.scenes.sort(
          (a, b) => meta.order.indexOf(a.key) - meta.order.indexOf(b.key),
        );
        break;
      }
      case "prefabs":
        this.project.prefabs = value as PrefabDef[];
        break;
      case "assets":
        this.project.assets = value as AssetDef[];
        break;
      case "anims":
        this.project.anims = value as AnimDef[];
        break;
      case "groups":
        this.project.groups = value as string[];
        break;
      case "collision":
        this.project.collision = value as ProjectData["collision"];
        break;
    }
  }

  private captureAll(): Map<string, Snapshot> {
    const out = new Map<string, Snapshot>();
    for (const slice of this.sliceKeys()) {
      const live = this.readSlice(slice);
      out.set(slice, { fp: fingerprint(live), clone: clone(live) });
    }
    return out;
  }

  private diff(before: Map<string, Snapshot>): SliceChange[] {
    const changes: SliceChange[] = [];
    const slices = new Set([...before.keys(), ...this.sliceKeys()]);
    for (const slice of slices) {
      const prev = before.get(slice);
      const live = this.readSlice(slice);
      const fp = fingerprint(live);
      if (prev && prev.fp === fp) continue;
      changes.push({ slice, before: prev ? prev.clone : null, after: clone(live) });
    }
    return changes;
  }

  // -------------------------------------------------------------------
  // Workflow 1 — project & scenes
  // -------------------------------------------------------------------

  createScene(name: string, template: TemplateId): string | null {
    const key = uniqueKey(name, this.project.scenes.map((s) => s.key));
    if (this.project.scenes.some((s) => s.key === key)) {
      this.setStatus(`Scene key "${key}" already exists`);
      return null;
    }
    this.transact(`Create scene ${key}`, () => {
      this.project.scenes.push(createSceneFromTemplate(key, name || key, template));
    });
    this.activateScene(key);
    this.setStatus(`Created src/scenes/${key}.scene.json`);
    return key;
  }

  deleteScene(key: string): void {
    if (this.project.scenes.length <= 1) {
      this.setStatus("A project needs at least one scene");
      return;
    }
    this.transact(`Delete scene ${key}`, () => {
      this.project.scenes = this.project.scenes.filter((s) => s.key !== key);
    });
    this.views.delete(key);
    this.stacks.delete(key);
    if (this.activeSceneKey === key) this.activateScene(this.project.scenes[0].key);
    else this.emit();
  }

  renameScene(key: string, name: string): void {
    this.transact("Rename scene", () => {
      const scene = this.project.scenes.find((s) => s.key === key);
      if (scene) scene.name = name;
    });
  }

  /** Switching keeps each scene's selection, camera and undo stack alive. */
  activateScene(key: string): void {
    if (!this.project.scenes.some((s) => s.key === key)) return;
    this.activeSceneKey = key;
    const scene = this.scene;
    if (scene) this.ensureView(scene);
    this.ui.status = `Scene ${key}`;
    this.emit();
    this.schedulePersist();
  }

  // -------------------------------------------------------------------
  // Selection / view
  // -------------------------------------------------------------------

  setSelection(ids: string[]): void {
    const view = this.view;
    view.selection = [...new Set(ids)];
    if (view.selection.length === 1) {
      const obj = this.selection[0];
      if (obj?.prefab) this.ui.inspectorTab = "prefab";
      else if (this.ui.inspectorTab === "prefab") this.ui.inspectorTab = "object";
    }
    this.emit();
  }

  toggleSelection(id: string): void {
    const view = this.view;
    view.selection = view.selection.includes(id)
      ? view.selection.filter((s) => s !== id)
      : [...view.selection, id];
    this.emit();
  }

  setCamera(camera: Partial<ViewState["camera"]>): void {
    Object.assign(this.view.camera, camera);
    this.emit();
  }

  setActiveLayer(id: string): void {
    this.view.activeLayerId = id;
    const layer = this.scene?.layers.find((l) => l.id === id);
    if (layer?.kind === "tile") {
      this.ui.inspectorTab = "tile";
      if (!this.ui.brush) this.ui.brush = { tilesetId: layer.tilesetId, tileId: 0 };
    }
    this.emit();
  }

  // -------------------------------------------------------------------
  // Workflow 3 — layers
  // -------------------------------------------------------------------

  addLayer(kind: "tile" | "object", opts?: { name?: string; tilesetId?: string }): void {
    const scene = this.scene;
    if (!scene) return;
    const names = scene.layers.map((l) => l.name);
    this.transact(`Add ${kind} layer`, () => {
      if (kind === "tile") {
        const layer = makeTileLayer(uniqueName(opts?.name ?? "Tiles", names));
        layer.cols = Math.ceil(scene.settings.width / layer.tileWidth);
        layer.rows = Math.ceil(scene.settings.height / layer.tileHeight);
        layer.data = Array.from({ length: layer.rows }, () =>
          Array<number>(layer.cols).fill(-1),
        );
        if (opts?.tilesetId) layer.tilesetId = opts.tilesetId;
        scene.layers.push(layer);
        this.view.activeLayerId = layer.id;
      } else {
        const layer: ObjectLayer = {
          id: uid("layer"),
          name: uniqueName(opts?.name ?? "Objects", names),
          kind: "object",
          visible: true,
          locked: false,
        };
        scene.layers.push(layer);
        this.view.activeLayerId = layer.id;
      }
    });
  }

  removeLayer(id: string): void {
    const scene = this.scene;
    if (!scene || scene.layers.length <= 1) return;
    this.transact("Remove layer", () => {
      scene.layers = scene.layers.filter((l) => l.id !== id);
      scene.objects = scene.objects.filter((o) => o.layerId !== id);
    });
    this.ensureView(scene);
  }

  updateLayer(id: string, patch: Partial<Omit<TileLayer, "kind"> & Omit<ObjectLayer, "kind">>): void {
    const scene = this.scene;
    if (!scene) return;
    this.transact("Change layer", () => {
      const layer = scene.layers.find((l) => l.id === id);
      if (layer) Object.assign(layer, patch);
    });
  }

  moveLayer(id: string, delta: number): void {
    const scene = this.scene;
    if (!scene) return;
    this.transact("Reorder layers", () => {
      const from = scene.layers.findIndex((l) => l.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= scene.layers.length) return;
      const [layer] = scene.layers.splice(from, 1);
      scene.layers.splice(to, 0, layer);
    });
  }

  // -------------------------------------------------------------------
  // Workflow 3 — tiles
  // -------------------------------------------------------------------

  putTile(layerId: string, col: number, row: number, index: number): boolean {
    const scene = this.scene;
    const layer = scene?.layers.find((l) => l.id === layerId);
    if (!scene || !layer || layer.kind !== "tile") return false;
    if (layer.locked || !layer.visible) return false;
    if (col < 0 || row < 0 || col >= layer.cols || row >= layer.rows) return false;
    if (layer.data[row][col] === index) return false;
    this.transact("Paint tiles", () => {
      layer.data[row][col] = index;
    });
    return true;
  }

  rectFill(
    layerId: string,
    a: { col: number; row: number },
    b: { col: number; row: number },
    index: number,
  ): void {
    const scene = this.scene;
    const layer = scene?.layers.find((l) => l.id === layerId);
    if (!scene || !layer || layer.kind !== "tile" || layer.locked) return;
    const c0 = Math.max(0, Math.min(a.col, b.col));
    const c1 = Math.min(layer.cols - 1, Math.max(a.col, b.col));
    const r0 = Math.max(0, Math.min(a.row, b.row));
    const r1 = Math.min(layer.rows - 1, Math.max(a.row, b.row));
    this.transact(index < 0 ? "Erase tiles" : "Fill tiles", () => {
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) layer.data[r][c] = index;
      }
    });
  }

  setBrush(tilesetId: string, tileId: number): void {
    this.ui.brush = { tilesetId, tileId };
    if (this.ui.tool !== "rect" && this.ui.tool !== "erase") this.ui.tool = "brush";
    this.emit();
  }

  toggleTileCollision(assetId: string, tileId: number): void {
    this.transact("Tile collision flag", () => {
      const asset = this.project.assets.find((a) => a.id === assetId);
      if (!asset) return;
      const list = new Set(asset.tileCollides ?? []);
      if (list.has(tileId)) list.delete(tileId);
      else list.add(tileId);
      asset.tileCollides = [...list].sort((x, y) => x - y);
    });
  }

  // -------------------------------------------------------------------
  // Workflow 2 — objects
  // -------------------------------------------------------------------

  addObject(partial: Partial<SceneObject> & { type: string }): string | null {
    const scene = this.scene;
    if (!scene) return null;
    // Objects land on the active layer when it can hold them, and otherwise
    // on the topmost object layer — a tile layer being active is the normal
    // state while painting, and should not block placement.
    const requested = scene.layers.find(
      (l) => l.id === (partial.layerId ?? this.view.activeLayerId),
    );
    const layer =
      requested?.kind === "object"
        ? requested
        : [...scene.layers].reverse().find((l) => l.kind === "object");
    if (!layer) {
      this.setStatus("This scene has no object layer — add one in the LAYERS panel");
      return null;
    }
    if (layer !== requested) this.ui.status = `Placed on object layer "${layer.name}"`;
    const id = partial.id ?? uid(partial.type);
    const names = scene.objects.map((o) => o.name);
    const obj: SceneObject = {
      id,
      name: uniqueName(partial.name ?? partial.type, names),
      type: partial.type,
      layerId: layer.id,
      parentId: partial.parentId ?? null,
      x: partial.x ?? 0,
      y: partial.y ?? 0,
      rotation: partial.rotation ?? 0,
      scaleX: partial.scaleX ?? 1,
      scaleY: partial.scaleY ?? 1,
      originX: partial.originX ?? 0.5,
      originY: partial.originY ?? 0.5,
      visible: partial.visible ?? true,
      texture: partial.texture,
      frame: partial.frame,
      group: partial.group,
      body: partial.body,
      playOnSpawn: partial.playOnSpawn,
      prefab: partial.prefab,
      overrides: partial.overrides,
      data: partial.data ?? {},
    };
    this.transact(`Add ${obj.name}`, () => {
      scene.objects.push(obj);
      this.view.selection = [id];
    });
    return id;
  }

  deleteObjects(ids: string[]): void {
    const scene = this.scene;
    if (!scene || !ids.length) return;
    const doomed = new Set(ids);
    for (const id of ids) for (const d of descendantIds(id, scene)) doomed.add(d);
    this.transact(ids.length > 1 ? `Delete ${ids.length} objects` : "Delete object", () => {
      scene.objects = scene.objects.filter((o) => !doomed.has(o.id));
      this.view.selection = this.view.selection.filter((s) => !doomed.has(s));
    });
  }

  duplicateObjects(ids: string[]): void {
    const scene = this.scene;
    if (!scene || !ids.length) return;
    const created: string[] = [];
    this.transact("Duplicate", () => {
      for (const id of ids) {
        const src = scene.objects.find((o) => o.id === id);
        if (!src) continue;
        const copy = structuredClone(src);
        copy.id = uid(src.type);
        copy.name = uniqueName(src.name, scene.objects.map((o) => o.name));
        copy.x += 16;
        copy.y += 16;
        scene.objects.push(copy);
        created.push(copy.id);
      }
      this.view.selection = created;
    });
  }

  /**
   * The one write path for object properties. Prefab instances route
   * non-instance-owned paths into `overrides` instead of the object itself,
   * so the link to the definition survives the edit.
   */
  setObjectProp(id: string, path: string, value: unknown, label = "Change property"): void {
    const scene = this.scene;
    const obj = scene?.objects.find((o) => o.id === id);
    if (!obj) return;
    const root = path.split(".")[0];
    const prefab = findPrefab(this.project, obj.prefab);

    if (prefab && !INSTANCE_OWNED.has(root)) {
      if (!prefab.exposed.includes(path)) {
        this.setStatus(
          `"${path}" is owned by prefab ${prefab.name} — expose it on the prefab to override it`,
        );
        return;
      }
      this.transact(label, () => {
        obj.overrides = { ...(obj.overrides ?? {}), [path]: value };
      });
      return;
    }

    this.transact(label, () => setPath(obj as unknown as Record<string, unknown>, path, value));
  }

  setObjectsProp(ids: string[], path: string, value: unknown, label = "Change property"): void {
    this.transact(label, () => {
      for (const id of ids) this.setObjectProp(id, path, value, label);
    });
  }

  /** Live drag frames: mutate without opening/closing a transaction per frame. */
  previewTransform(id: string, x: number, y: number): void {
    const obj = this.scene?.objects.find((o) => o.id === id);
    if (!obj) return;
    obj.x = x;
    obj.y = y;
    this.emit();
  }

  reparent(ids: string[], parentId: string | null, index?: number): void {
    const scene = this.scene;
    if (!scene) return;
    const map = objectsById(scene);
    this.transact("Reparent", () => {
      for (const id of ids) {
        const obj = map.get(id);
        if (!obj) continue;
        if (parentId === id || wouldCycle(id, parentId, map)) {
          this.setStatus("Rejected: that would make an object its own ancestor");
          continue;
        }
        // Preserve world position: local = parentInverse x world.
        const world = worldOf(obj, map);
        obj.parentId = parentId;
        const local = localUnder(world, parentId, map);
        obj.x = local.x;
        obj.y = local.y;
        if (parentId) {
          const parent = map.get(parentId);
          if (parent) obj.layerId = parent.layerId;
        }
        if (typeof index === "number") {
          const from = scene.objects.indexOf(obj);
          if (from >= 0) {
            scene.objects.splice(from, 1);
            scene.objects.splice(Math.min(index, scene.objects.length), 0, obj);
          }
        }
      }
    });
  }

  groupSelection(): void {
    const scene = this.scene;
    const sel = this.selection;
    if (!scene || sel.length < 2) return;
    const cx = sel.reduce((a, o) => a + o.x, 0) / sel.length;
    const cy = sel.reduce((a, o) => a + o.y, 0) / sel.length;
    this.transact("Group", () => {
      const container: SceneObject = {
        id: uid("group"),
        name: uniqueName("Group", scene.objects.map((o) => o.name)),
        type: "container",
        layerId: sel[0].layerId,
        parentId: null,
        x: cx,
        y: cy,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        originX: 0.5,
        originY: 0.5,
        visible: true,
        data: {},
      };
      scene.objects.push(container);
      for (const obj of sel) {
        obj.parentId = container.id;
        obj.x -= cx;
        obj.y -= cy;
      }
      this.view.selection = [container.id];
    });
  }

  // -------------------------------------------------------------------
  // Workflow 4 — assets
  // -------------------------------------------------------------------

  importAssets(assets: AssetDef[]): void {
    if (!assets.length) return;
    this.transact(`Import ${assets.length} asset(s)`, () => {
      for (const asset of assets) {
        asset.key = uniqueKey(asset.key, this.project.assets.map((a) => a.key));
        this.project.assets.push(asset);
      }
    });
    this.setStatus(`Copied ${assets.length} file(s) into assets/`);
  }

  updateAsset(id: string, patch: Partial<AssetDef>, label = "Update asset"): void {
    this.transact(label, () => {
      const asset = this.project.assets.find((a) => a.id === id);
      if (asset) Object.assign(asset, patch);
    });
  }

  deleteAsset(id: string): void {
    this.transact("Delete asset", () => {
      this.project.assets = this.project.assets.filter((a) => a.id !== id);
    });
  }

  // -------------------------------------------------------------------
  // Workflow 5 — prefabs
  // -------------------------------------------------------------------

  createPrefab(name: string, exposed: string[], objectIds: string[]): PrefabDef | null {
    const scene = this.scene;
    if (!scene || !objectIds.length) return null;
    if (this.project.prefabs.some((p) => p.name === name)) {
      this.setStatus(`Prefab "${name}" already exists`);
      return null;
    }
    const objects = scene.objects.filter((o) => objectIds.includes(o.id));
    if (!objects.length) return null;
    const first = objects[0];
    const prefab: PrefabDef = { name, exposed, root: toPrefabNode(first) };

    this.transact(`Create prefab ${name}`, () => {
      this.project.prefabs.push(prefab);
      // Selected objects become instances: {prefab, transform, overrides}.
      for (const obj of objects) {
        const keep = { id: obj.id, name: obj.name, x: obj.x, y: obj.y, layerId: obj.layerId, parentId: obj.parentId };
        const overrides: Record<string, unknown> = {};
        for (const path of exposed) {
          const mine = getPath(obj, path);
          const theirs = getPath(prefab.root, path);
          if (JSON.stringify(mine) !== JSON.stringify(theirs)) overrides[path] = mine;
        }
        const idx = scene.objects.indexOf(obj);
        scene.objects[idx] = {
          ...structuredClone(prefab.root as unknown as SceneObject),
          ...keep,
          prefab: name,
          overrides,
        };
        delete (scene.objects[idx] as unknown as Record<string, unknown>).children;
      }
    });
    this.ui.inspectorTab = "prefab";
    this.setStatus(`Wrote prefabs/${name}.prefab.json — ${objects.length} instance(s) relinked`);
    return prefab;
  }

  /** Editing the definition propagates everywhere on save. */
  updatePrefab(name: string, patch: Partial<PrefabDef["root"]>, exposed?: string[]): void {
    this.transact(`Update prefab ${name}`, () => {
      const prefab = this.project.prefabs.find((p) => p.name === name);
      if (!prefab) return;
      Object.assign(prefab.root, patch);
      if (exposed) prefab.exposed = exposed;
    });
    const affected = this.project.scenes.filter((s) =>
      s.objects.some((o) => o.prefab === name),
    );
    this.setStatus(
      `Prefab ${name} updated — ${affected.length} scene(s) re-resolved (overrides preserved)`,
    );
  }

  /** Push one instance's overridden values up into the definition. */
  applyInstanceToPrefab(objId: string): void {
    const obj = this.scene?.objects.find((o) => o.id === objId);
    const prefab = findPrefab(this.project, obj?.prefab);
    if (!obj || !prefab) return;
    this.transact(`Apply to prefab ${prefab.name}`, () => {
      for (const [path, value] of Object.entries(obj.overrides ?? {})) {
        setPath(prefab.root as unknown as Record<string, unknown>, path, structuredClone(value));
      }
      obj.overrides = {};
    });
    this.setStatus(`Applied ${obj.name}'s overrides to prefab ${prefab.name}`);
  }

  revertOverride(objId: string, path: string): void {
    this.transact("Revert override", () => {
      const obj = this.scene?.objects.find((o) => o.id === objId);
      if (!obj?.overrides) return;
      // Override keys are literal dotted paths ("data.value"), not a nested
      // object, so the key is deleted whole rather than walked into.
      delete obj.overrides[path];
    });
  }

  /** Break the link: the instance becomes a plain object again. */
  unpackInstance(objId: string): void {
    this.transact("Unpack prefab instance", () => {
      const obj = this.scene?.objects.find((o) => o.id === objId);
      const prefab = findPrefab(this.project, obj?.prefab);
      if (!obj || !prefab) return;
      const node = prefab.root as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(node)) {
        if (key === "children" || INSTANCE_OWNED.has(key)) continue;
        (obj as unknown as Record<string, unknown>)[key] = structuredClone(value);
      }
      for (const [path, value] of Object.entries(obj.overrides ?? {})) {
        setPath(obj as unknown as Record<string, unknown>, path, structuredClone(value));
      }
      delete obj.prefab;
      delete obj.overrides;
    });
  }

  deletePrefab(name: string): void {
    this.transact(`Delete prefab ${name}`, () => {
      for (const scene of this.project.scenes) {
        for (const obj of scene.objects) {
          if (obj.prefab === name) this.unpackInstanceIn(scene, obj);
        }
      }
      this.project.prefabs = this.project.prefabs.filter((p) => p.name !== name);
    });
  }

  private unpackInstanceIn(_scene: SceneData, obj: SceneObject): void {
    const prefab = findPrefab(this.project, obj.prefab);
    if (!prefab) return;
    const node = prefab.root as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(node)) {
      if (key === "children" || INSTANCE_OWNED.has(key)) continue;
      (obj as unknown as Record<string, unknown>)[key] = structuredClone(value);
    }
    for (const [path, value] of Object.entries(obj.overrides ?? {})) {
      setPath(obj as unknown as Record<string, unknown>, path, structuredClone(value));
    }
    delete obj.prefab;
    delete obj.overrides;
  }

  // -------------------------------------------------------------------
  // Workflow 6 — animation
  // -------------------------------------------------------------------

  upsertAnim(def: AnimDef, label = "Edit animation"): void {
    this.transact(label, () => {
      const idx = this.project.anims.findIndex((a) => a.key === def.key);
      if (idx >= 0) this.project.anims[idx] = def;
      else this.project.anims.push(def);
    });
    this.ui.animKey = def.key;
  }

  deleteAnim(key: string): void {
    this.transact("Delete animation", () => {
      this.project.anims = this.project.anims.filter((a) => a.key !== key);
      for (const scene of this.project.scenes) {
        for (const obj of scene.objects) if (obj.playOnSpawn === key) delete obj.playOnSpawn;
      }
    });
    if (this.ui.animKey === key) this.ui.animKey = this.project.anims[0]?.key ?? null;
  }

  /** Missing anim keys are a validation error, not a silent no-op. */
  validate(): { level: "error" | "warn"; message: string }[] {
    const issues: { level: "error" | "warn"; message: string }[] = [];
    const animKeys = new Set(this.project.anims.map((a) => a.key));
    const textureKeys = new Set(this.project.assets.map((a) => a.key));
    for (const scene of this.project.scenes) {
      for (const obj of scene.objects) {
        if (obj.playOnSpawn && !animKeys.has(obj.playOnSpawn)) {
          issues.push({
            level: "error",
            message: `${scene.key}/${obj.name}: animation "${obj.playOnSpawn}" does not exist`,
          });
        }
        if (obj.texture && !textureKeys.has(obj.texture)) {
          issues.push({
            level: "error",
            message: `${scene.key}/${obj.name}: texture "${obj.texture}" is not in the manifest`,
          });
        }
        if (obj.prefab && !findPrefab(this.project, obj.prefab)) {
          issues.push({
            level: "error",
            message: `${scene.key}/${obj.name}: prefab "${obj.prefab}" is missing`,
          });
        }
      }
      for (const layer of scene.layers) {
        if (layer.kind !== "tile") continue;
        if (!this.project.assets.some((a) => a.id === layer.tilesetId)) {
          issues.push({
            level: "error",
            message: `${scene.key}/${layer.name}: tileset is missing`,
          });
        }
      }
    }
    for (const anim of this.project.anims) {
      if (!anim.frames.length) {
        issues.push({ level: "warn", message: `Animation "${anim.key}" has no frames` });
      }
    }
    return issues;
  }

  // -------------------------------------------------------------------
  // Workflow 7 — physics
  // -------------------------------------------------------------------

  setCollisionRule(a: string, b: string, rule: CollisionRule): void {
    this.transact("Collision matrix", () => {
      this.project.collision[a] = this.project.collision[a] ?? {};
      this.project.collision[b] = this.project.collision[b] ?? {};
      this.project.collision[a][b] = rule;
      this.project.collision[b][a] = rule;
    });
  }

  addGroup(name: string): void {
    const clean = name.trim();
    if (!clean || this.project.groups.includes(clean)) return;
    this.transact(`Add group ${clean}`, () => {
      this.project.groups.push(clean);
      this.project.collision[clean] = {};
      for (const g of this.project.groups) {
        this.project.collision[clean][g] = "ignore";
        this.project.collision[g] = this.project.collision[g] ?? {};
        this.project.collision[g][clean] = "ignore";
      }
    });
  }

  // -------------------------------------------------------------------
  // Project IO
  // -------------------------------------------------------------------

  loadProject(project: ProjectData): void {
    this.project = project;
    this.stacks.clear();
    this.views.clear();
    this.savedDepth.clear();
    this.activeSceneKey = project.scenes[0]?.key ?? "";
    for (const scene of project.scenes) this.ensureView(scene);
    this.setStatus(`Opened project "${project.name}"`);
    this.schedulePersist();
  }

  resetProject(): void {
    this.loadProject(createStarterProject());
  }

  /** Route persistence somewhere other than localStorage (desktop: to disk). */
  setPersister(persister: ((project: ProjectData) => void) | null): void {
    this.persister = persister;
    this.storageWarning = null;
  }

  private schedulePersist(): void {
    if (typeof window === "undefined") return; // headless (tests, SSR)
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      if (this.persister) {
        this.persister(this.project);
        return;
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.project));
        this.storageWarning = null;
      } catch {
        this.storageWarning =
          "Project too large for local storage — export the project JSON to keep it.";
      }
    }, 400);
  }
}

interface Snapshot {
  fp: string;
  clone: unknown;
}

/** Deep clone that reuses (immutable) data-URL strings rather than copying MBs. */
function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (structuredClone(value) as T);
}

/**
 * Cheap change detection. Asset payloads are compared by length + prefix so a
 * transaction never has to walk megabytes of base64.
 */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (key, val) =>
    key === "url" && typeof val === "string" && val.length > 128
      ? `#${val.length}:${val.slice(0, 48)}`
      : val,
  );
}

function worldOf(obj: SceneObject, map: Map<string, SceneObject>) {
  let x = obj.x;
  let y = obj.y;
  let cur = obj.parentId ? map.get(obj.parentId) : undefined;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    x += cur.x;
    y += cur.y;
    cur = cur.parentId ? map.get(cur.parentId) : undefined;
  }
  return { x, y };
}

function localUnder(
  world: { x: number; y: number },
  parentId: string | null,
  map: Map<string, SceneObject>,
) {
  if (!parentId) return world;
  const parent = map.get(parentId);
  if (!parent) return world;
  const pw = worldOf(parent, map);
  return { x: world.x - pw.x, y: world.y - pw.y };
}

function loadPersisted(): ProjectData | null {
  if (typeof window === "undefined") return null;
  for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as ProjectData;
      if (!parsed?.scenes?.length) continue;
      if (key !== STORAGE_KEY) {
        // Migrate forward, then drop the old key so this runs once.
        window.localStorage.setItem(STORAGE_KEY, raw);
        window.localStorage.removeItem(key);
      }
      return parsed;
    } catch {
      /* try the next key */
    }
  }
  return null;
}
