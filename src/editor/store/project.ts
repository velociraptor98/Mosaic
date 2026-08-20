import {
  INSTANCE_OWNED,
  canInherit,
  ensureLids,
  findPrefab,
  getPath,
  isExposed,
  newLid,
  prefabChain,
  resolveObject,
  resolvePrefab,
  setPath,
  toPrefabNode,
  variantsOf,
  walkNodes,
} from "../../shared/prefabs";
import {
  planPropagation,
  unexposeImpact,
  type PropagationPlan,
} from "../../shared/propagate";
import { flattenNode, same } from "../../shared/prefabs";
import {
  SCRIPT_LIST_PATH,
  fitsType,
  newScriptRef,
  scriptEnabledPath,
  scriptPropPath,
  scriptsOf,
} from "../../shared/scripts";
import { objectsById, wouldCycle, descendantIds } from "../../shared/transform";
import type { ScriptRegistry } from "../scripts/registry";
import type {
  AnimDef,
  AssetDef,
  CollisionRule,
  Layer,
  ObjectLayer,
  PrefabDef,
  PrefabNode,
  ProjectData,
  ResolvedPrefab,
  SceneData,
  SceneObject,
  ScriptRef,
  TileLayer,
} from "../../shared/types";
import {
  prefabToScene,
  sceneToPrefabNode,
  stageFor,
  type StageGeometry,
} from "./prefabDoc";
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
export type InspectorTab =
  | "object"
  | "tile"
  | "physics"
  | "scripts"
  | "prefab"
  | "anim"
  | "scene";

export interface ViewState {
  selection: string[];
  activeLayerId: string | null;
  camera: { x: number; y: number; zoom: number };
}

export interface Placement {
  kind: "asset" | "prefab";
  /** asset id, or prefab name */
  id: string;
  frame?: string;
}

/**
 * An open prefab document.
 *
 * The definition is held as a one-layer scene so every editing tool works on
 * it unchanged; `baseline` is what was stored when edit mode opened, and is
 * what the propagation panel diffs against on save.
 */
export interface PrefabDoc {
  name: string;
  scene: SceneData;
  /** The scene object standing in for the definition's root node. */
  rootId: string;
  /** The exposure contract being authored, separate from the tree. */
  exposed: string[];
  /** The stored definition when edit mode opened. */
  baseline: PrefabDef;
  /** Set when the prefab being edited is a variant of another. */
  base?: string;
  geometry: StageGeometry;
}

/**
 * "Review each" walks the affected scenes one at a time instead of writing
 * them all and hoping nobody minds.
 */
export interface ReviewQueue {
  prefab: string;
  scenes: string[];
  instanceIds: string[];
  index: number;
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
  /**
   * The read-only source drawer: which file it shows, and which class's
   * declarations are highlighted in it. Editing happens in the user's own
   * editor, one click away — never here.
   */
  sourceView: { src: string; className: string } | null;
  /**
   * Set when the attach picker is being used to re-point an existing row at a
   * class rather than to add a new one.
   */
  scriptRelink: { objectId: string; index: number } | null;
  /**
   * The plan a prefab save is waiting on. Saving computes what the change
   * costs and stops here; nothing is written until it is pushed.
   */
  prefabPlan: PropagationPlan | null;
  /** Set while walking the scenes a push touched, one at a time. */
  review: ReviewQueue | null;
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
  /**
   * The open prefab document, if there is one. While it is open it IS the
   * active document: `scene` returns it, edits land in it, and its undo stack
   * is separate from every scene's. Scene documents stay open and untouched —
   * their instances go on rendering from the last SAVED definition.
   */
  prefabDoc: PrefabDoc | null = null;
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
    sourceView: null,
    scriptRelink: null,
    prefabPlan: null,
    review: null,
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
    if (this.prefabDoc) return this.prefabDoc.scene;
    return this.project.scenes.find((s) => s.key === this.activeSceneKey) ?? null;
  }

  /** The scene under the prefab document — what "Back to scene" returns to. */
  get sceneBehind(): SceneData | null {
    return this.project.scenes.find((s) => s.key === this.activeSceneKey) ?? null;
  }

  /**
   * The key of the ACTIVE DOCUMENT: a scene, or the open prefab. Undo stacks,
   * views and the dirty marker are all keyed by this, which is what gives a
   * prefab its own undo stack.
   */
  get docKey(): string {
    return this.prefabDoc?.scene.key ?? this.activeSceneKey;
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

  stack(key = this.docKey): UndoStack {
    let s = this.stacks.get(key);
    if (!s) {
      s = new UndoStack();
      this.stacks.set(key, s);
    }
    return s;
  }

  isDirty(key: string): boolean {
    const doc = this.prefabDoc;
    if (doc && key === doc.scene.key) {
      // A definition is modified when it no longer matches what was stored —
      // not when the undo stack grew. Editing an asset or another prefab while
      // this document is open pushes onto the same stack, and should not make
      // the definition read as unsaved.
      const next = this.prefabDocDef();
      return !!next && !same(next, doc.baseline);
    }
    return this.stack(key).depth !== (this.savedDepth.get(key) ?? 0);
  }

  markSaved(key = this.docKey): void {
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
      ...(this.prefabDoc ? ["doc"] : []),
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
    // The prefab document is not part of the project until it is saved, so it
    // gets a slice of its own rather than riding on `scenes`.
    if (slice === "doc") {
      const doc = this.prefabDoc;
      return doc ? { scene: doc.scene, exposed: doc.exposed, rootId: doc.rootId } : null;
    }
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
    if (slice === "doc") {
      const doc = this.prefabDoc;
      const next = value as { scene: SceneData; exposed: string[]; rootId: string } | null;
      if (!doc || !next) return;
      doc.scene = next.scene;
      doc.exposed = next.exposed;
      doc.rootId = next.rootId;
      this.ensureView(doc.scene);
      return;
    }
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
      const made = createSceneFromTemplate(key, name || key, template, this.project.config);
      this.project.scenes.push(made.scene);
      // A template's starter prefabs are content, so a second scene made from
      // the same template reuses the ones the project already has.
      for (const prefab of made.prefabs) {
        if (!this.project.prefabs.some((p) => p.name === prefab.name)) {
          this.project.prefabs.push(prefab);
        }
      }
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
    // A prefab document sits above the scenes: switching scene leaves it, and
    // leaving it with unsaved edits has to be said out loud.
    if (this.prefabDoc && !this.closePrefab()) return;
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
    const id = partial.id ?? (this.prefabDoc ? newLid() : uid(partial.type));
    const names = scene.objects.map((o) => o.name);
    // On the isolated stage there is nowhere for a loose object to go: a part
    // dropped here is a part OF the prefab, so it lands under the root.
    const parentId =
      partial.parentId ??
      (this.prefabDoc && id !== this.prefabDoc.rootId ? this.prefabDoc.rootId : null);
    const obj: SceneObject = {
      id,
      name: uniqueName(partial.name ?? partial.type, names),
      type: partial.type,
      layerId: layer.id,
      parentId,
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
    // A definition has to have a root. Deleting the object the prefab IS would
    // leave a file that resolves to nothing.
    if (this.prefabDoc && ids.includes(this.prefabDoc.rootId)) {
      this.setStatus(
        `${this.prefabDoc.name} is this document's root — delete the prefab itself to remove it`,
      );
      return;
    }
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
    const prefab = resolvePrefab(this.project, obj.prefab);

    if (prefab && !INSTANCE_OWNED.has(root)) {
      if (!isExposed(prefab, path)) {
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
  // Workflow 5 — prefabs: promote, isolate, compose, expose, vary,
  // place, propagate.
  // -------------------------------------------------------------------

  /** A prefab with its inheritance applied, by name. */
  resolvePrefab(name: string | undefined): ResolvedPrefab | undefined {
    return resolvePrefab(this.project, name);
  }

  /**
   * Whether a selection can become a prefab, and what it would take with it.
   *
   * A prefab has one root. A selection spanning two parents has no single
   * root, so promote is refused with the reason rather than picking one and
   * hoping. References out of the subtree are reported too: they would not
   * resolve inside a definition that no longer sits in that scene.
   */
  promoteCheck(ids: string[]): {
    ok: boolean;
    reason?: string;
    root?: SceneObject;
    children: SceneObject[];
    /** Other selected siblings, which are relinked as instances of the new prefab. */
    siblings: SceneObject[];
    /** Script refs pointing at objects the prefab would not contain. */
    unresolved: { object: string; property: string; target: string }[];
  } {
    const scene = this.scene;
    const empty = { ok: false, children: [], siblings: [], unresolved: [] };
    if (!scene || !ids.length) return { ...empty, reason: "Select an object first" };

    const selected = scene.objects.filter((o) => ids.includes(o.id));
    if (!selected.length) return { ...empty, reason: "Select an object first" };

    // A prefab has one root, so the selection needs one place to have come
    // from. Objects under two different parents have no single root, and
    // inventing one would move things nobody asked to move.
    const tops = selected.filter((o) => !o.parentId || !ids.includes(o.parentId));
    const parents = new Set(tops.map((o) => o.parentId ?? ""));
    if (parents.size > 1) {
      return {
        ...empty,
        reason: `The selection spans ${parents.size} parents — select one root`,
      };
    }

    // Siblings of one parent are the ordinary case: the first becomes the
    // definition and the rest become instances of it.
    const root = tops[0];
    const siblings = tops.slice(1);
    const kids = new Set(descendantIds(root.id, scene));
    const children = scene.objects.filter((o) => kids.has(o.id));
    const inside = new Set([root.name, ...children.map((c) => c.name)]);

    const unresolved: { object: string; property: string; target: string }[] = [];
    for (const obj of [root, ...children]) {
      for (const script of this.scriptsFor(obj)) {
        const cls = this.scriptIndex?.resolve(script);
        const properties = cls && cls.status !== "missing" ? this.scriptIndex!.properties(cls.cls) : [];
        for (const property of properties) {
          if (property.type !== "ref") continue;
          const target = script.props[property.name];
          if (typeof target !== "string" || !target || inside.has(target)) continue;
          unresolved.push({ object: obj.name, property: `${script.class}.${property.name}`, target });
        }
      }
    }

    return { ok: true, root, children, siblings, unresolved };
  }

  /**
   * PROMOTE — the selection becomes a definition, and the object you selected
   * becomes its first instance in place. Its id survives, so anything
   * referencing it still resolves.
   */
  createPrefab(options: {
    name: string;
    objectId: string;
    exposed: string[];
    /** Take the subtree, or just the one object. */
    includeChildren?: boolean;
    /** Rewrite the selected object as an instance rather than leaving it plain. */
    keepAsInstance?: boolean;
    /** Other selected siblings, relinked as instances of the new definition. */
    siblingIds?: string[];
    /** Overwrite a prefab of the same name instead of refusing. */
    replace?: boolean;
  }): PrefabDef | null {
    const scene = this.scene;
    if (!scene) return null;
    const name = options.name.trim();
    if (!name) {
      this.setStatus("A prefab needs a name");
      return null;
    }

    const existing = this.project.prefabs.find((p) => p.name === name);
    if (existing && !options.replace) {
      this.setStatus(`Prefab "${name}" already exists — replace it or pick another name`);
      return null;
    }

    const root = scene.objects.find((o) => o.id === options.objectId);
    if (!root) return null;

    const kids =
      options.includeChildren === false
        ? new Set<string>()
        : new Set(descendantIds(root.id, scene));
    const byParent = new Map<string, SceneObject[]>();
    for (const obj of scene.objects) {
      if (!kids.has(obj.id) || !obj.parentId) continue;
      byParent.set(obj.parentId, [...(byParent.get(obj.parentId) ?? []), obj]);
    }
    const build = (obj: SceneObject): PrefabNode =>
      toPrefabNode(obj, (byParent.get(obj.id) ?? []).map(build));

    const node = build(root);
    node.x = 0;
    node.y = 0;
    const prefab: PrefabDef = { name, exposed: [...options.exposed], root: node };

    this.transact(existing ? `Replace prefab ${name}` : `Create prefab ${name}`, () => {
      if (existing) Object.assign(existing, { ...prefab, base: undefined, diff: undefined });
      else this.project.prefabs.push(prefab);

      if (options.keepAsInstance === false) return;

      // The scene node is rewritten in place: same id, same position, same
      // parent — a link to the definition rather than a copy of it. Siblings
      // that were selected alongside it are relinked the same way, so a value
      // one of them already differed on is recorded as ITS override rather
      // than being flattened to the definition's.
      const relink = [
        root,
        ...(options.siblingIds ?? [])
          .map((id) => scene.objects.find((o) => o.id === id))
          .filter((o): o is SceneObject => !!o && o !== root),
      ];
      const takenChildren = new Set(kids);

      for (const obj of relink) {
        const keep = {
          id: obj.id,
          name: obj.name,
          x: obj.x,
          y: obj.y,
          layerId: obj.layerId,
          parentId: obj.parentId,
        };
        const overrides: Record<string, unknown> = {};
        for (const path of options.exposed) {
          const mine = getPath(obj, path);
          const theirs = getPath(node, path);
          if (JSON.stringify(mine) !== JSON.stringify(theirs)) overrides[path] = mine;
        }
        const index = scene.objects.indexOf(obj);
        scene.objects[index] = {
          ...(structuredClone(node) as unknown as SceneObject),
          ...keep,
          prefab: name,
          overrides,
        };
        delete (scene.objects[index] as unknown as Record<string, unknown>).children;
        delete (scene.objects[index] as unknown as Record<string, unknown>).lid;
        // A sibling's own children come from the definition now too.
        if (obj !== root) for (const id of descendantIds(obj.id, scene)) takenChildren.add(id);
      }

      // Children now come from the definition; they are no longer scene nodes.
      scene.objects = scene.objects.filter((o) => !takenChildren.has(o.id));
      this.view.selection = relink.map((o) => o.id);
    });

    const relinked = 1 + (options.siblingIds?.length ?? 0);
    this.ui.inspectorTab = "prefab";
    this.setStatus(
      `Wrote ${prefabFilePath(name)} — ${relinked} instance(s) now resolve from it`,
    );
    return this.project.prefabs.find((p) => p.name === name) ?? null;
  }

  // ------------------------------------------------------- isolate + compose

  /**
   * ISOLATE — open the definition alone on an empty stage.
   *
   * Nothing you drag in here can land in a level, and every scene stays open
   * and unchanged: their instances keep rendering from the last SAVED
   * definition until Save prefab is pushed.
   */
  openPrefab(name: string): boolean {
    if (this.prefabDoc?.name === name) {
      this.setStatus(`${name}.prefab is already open`);
      return true;
    }
    if (this.prefabDoc && !this.closePrefab()) return false;

    const stored = findPrefab(this.project, name);
    const resolved = resolvePrefab(this.project, name);
    if (!stored || !resolved) {
      const chain = prefabChain(this.project, name);
      this.setStatus(
        chain.ok
          ? `Prefab "${name}" has no definition to open`
          : `Prefab "${name}" cannot be opened — ${chain.reason} at ${chain.at}`,
      );
      return false;
    }

    const { scene, rootId, geometry } = prefabToScene(this.project, resolved);
    this.prefabDoc = {
      name,
      scene,
      rootId,
      exposed: [...resolved.exposed],
      baseline: structuredClone(stored),
      base: stored.base,
      geometry,
    };
    this.stacks.delete(scene.key);
    this.savedDepth.set(scene.key, 0);
    this.views.delete(scene.key);
    this.ensureView(scene);
    this.view.selection = [rootId];
    this.ui.inspectorTab = "prefab";
    this.ui.tool = "select";
    this.ui.placement = null;
    this.setStatus(`Editing ${prefabFilePath(name)} — scene documents are unaffected until save`);
    return true;
  }

  /**
   * BACK TO SCENE. Unsaved definition edits are never dropped silently: the
   * caller has to say so.
   */
  closePrefab(discard = false): boolean {
    const doc = this.prefabDoc;
    if (!doc) return true;
    const dirtyOnLeave = this.isDirty(doc.scene.key);
    if (!discard && dirtyOnLeave) {
      this.setStatus(
        `${doc.name}.prefab has unsaved changes — save the prefab, or discard them to leave`,
      );
      return false;
    }
    this.stacks.delete(doc.scene.key);
    this.views.delete(doc.scene.key);
    this.savedDepth.delete(doc.scene.key);
    this.prefabDoc = null;
    this.ui.prefabPlan = null;
    this.setStatus(
      discard && dirtyOnLeave
        ? `Left ${doc.name}.prefab — the definition on disk is unchanged`
        : `Closed ${doc.name}.prefab`,
    );
    return true;
  }

  /** The definition the open document would be stored as. */
  prefabDocDef(): PrefabDef | null {
    const doc = this.prefabDoc;
    if (!doc) return null;
    const root = ensureLids(sceneToPrefabNode(doc.scene, doc.rootId));

    if (!doc.base) return { name: doc.name, exposed: [...doc.exposed], root };

    // A VARIANT stores its base and only what differs — never a second copy
    // of the object. An unrelated change on the base still flows through.
    const base = resolvePrefab(this.project, doc.base);
    const diff: Record<string, unknown> = {};
    if (base) {
      for (const change of diffNodePaths(base.root, root)) diff[change] = getPath(root, change);
    }
    return { name: doc.name, exposed: [...doc.exposed], base: doc.base, diff };
  }

  /** The open document resolved the way an instance would see it. */
  prefabDocResolved(): ResolvedPrefab | null {
    const doc = this.prefabDoc;
    const def = this.prefabDocDef();
    if (!doc || !def) return null;
    const chain = prefabChain(this.project, doc.name);
    return {
      name: doc.name,
      exposed: [...doc.exposed],
      root: ensureLids(sceneToPrefabNode(doc.scene, doc.rootId)),
      base: doc.base,
      chain: chain.ok ? chain.chain.map((p) => p.name) : [doc.name],
    };
  }

  /** The stage box drawn under the object: bounds, origin, body. */
  prefabStage(): StageGeometry | null {
    const doc = this.prefabDoc;
    if (!doc) return null;
    const root = sceneToPrefabNode(doc.scene, doc.rootId);
    const geometry = stageFor(this.project, root);
    return { ...geometry, anchorX: doc.geometry.anchorX, anchorY: doc.geometry.anchorY };
  }

  // ---------------------------------------------------------------- expose

  /**
   * EXPOSE — the contract with the levels. Checking a field publishes it to
   * instances; an unchecked field never appears in a level inspector at all.
   */
  toggleExposed(path: string): void {
    const doc = this.prefabDoc;
    if (!doc) return;
    const on = doc.exposed.includes(path);
    this.transact(on ? `Unexpose ${path}` : `Expose ${path}`, () => {
      doc.exposed = on ? doc.exposed.filter((p) => p !== path) : [...doc.exposed, path];
    });
  }

  setExposed(paths: string[]): void {
    const doc = this.prefabDoc;
    if (!doc) return;
    this.transact("Change exposed fields", () => {
      doc.exposed = [...paths];
    });
  }

  /** What unexposing a field would cost: the overrides it drops, and where. */
  unexposeImpact(path: string): { count: number; scenes: string[]; instances: string[] } {
    const doc = this.prefabDoc;
    if (!doc) return { count: 0, scenes: [], instances: [] };
    return unexposeImpact(this.project, doc.name, path);
  }

  // ------------------------------------------------------------- propagate

  /**
   * SAVE PREFAB, step one: work out what the change costs. Nothing is written
   * — the plan is shown, and the author decides.
   */
  planPrefabSave(readOnly?: (sceneKey: string) => string | null): PropagationPlan | null {
    const doc = this.prefabDoc;
    const next = this.prefabDocDef();
    if (!doc || !next) return null;
    const nextPrefabs = this.project.prefabs.map((p) => (p.name === doc.name ? next : p));
    if (!nextPrefabs.some((p) => p.name === doc.name)) nextPrefabs.push(next);
    const plan = planPropagation(this.project, doc.name, nextPrefabs, { readOnly });
    this.ui.prefabPlan = plan;
    this.emit();
    return plan;
  }

  cancelPrefabPlan(): void {
    this.ui.prefabPlan = null;
    this.emit();
  }

  /**
   * SAVE PREFAB, step two: write the definition, and drop the overrides the
   * plan said would be dropped. Scenes the plan marked skipped are left alone,
   * overrides and all.
   */
  pushPrefabSave(): void {
    const doc = this.prefabDoc;
    const next = this.prefabDocDef();
    const plan = this.ui.prefabPlan;
    if (!doc || !next) return;
    const skipped = new Set(plan?.scenes.filter((s) => s.skipped).map((s) => s.key) ?? []);

    this.transact(`Save prefab ${doc.name}`, () => {
      const index = this.project.prefabs.findIndex((p) => p.name === doc.name);
      if (index >= 0) this.project.prefabs[index] = next;
      else this.project.prefabs.push(next);

      // An override on a field the definition no longer publishes cannot be
      // kept: the level inspector would have no row to show it in.
      const publishing = new Set(next.exposed);
      const family = new Set<string>([doc.name, ...variantsOf(this.project, doc.name).map((v) => v.name)]);
      for (const scene of this.project.scenes) {
        if (skipped.has(scene.key)) continue;
        for (const obj of scene.objects) {
          if (!obj.prefab || !family.has(obj.prefab) || !obj.overrides) continue;
          const exposedHere = new Set(resolvePrefab(this.project, obj.prefab)?.exposed ?? publishing);
          for (const path of Object.keys(obj.overrides)) {
            if (!exposedHere.has(path)) delete obj.overrides[path];
          }
        }
      }
    });

    doc.baseline = structuredClone(next);
    this.markSaved(doc.scene.key);
    this.ui.prefabPlan = null;
    const moved = plan?.totals.moved ?? 0;
    const scenes = plan?.totals.scenes ?? 0;
    this.setStatus(
      `Saved ${prefabFilePath(doc.name)} — ${moved} value(s) moved across ${scenes} scene(s)`,
    );
  }

  /** Walk the scenes a push touched, one at a time. */
  startReview(plan: PropagationPlan): void {
    const scenes = [...new Set(plan.rows.flatMap((r) => r.scenes))].filter((key) =>
      this.project.scenes.some((s) => s.key === key),
    );
    if (!scenes.length) {
      this.setStatus("Nothing to review — no scene holds an instance of this prefab");
      return;
    }
    this.ui.review = {
      prefab: plan.prefab,
      scenes,
      instanceIds: [...new Set(plan.rows.flatMap((r) => r.instanceIds))],
      index: 0,
    };
    this.closePrefab(true);
    this.showReviewStep(0);
  }

  showReviewStep(index: number): void {
    const review = this.ui.review;
    if (!review) return;
    if (index >= review.scenes.length) {
      this.ui.review = null;
      this.setStatus(`Reviewed every scene ${review.prefab} touches`);
      this.emit();
      return;
    }
    review.index = index;
    this.activateScene(review.scenes[index]);
    const scene = this.scene;
    if (scene) {
      const wanted = new Set(review.instanceIds);
      this.view.selection = scene.objects.filter((o) => wanted.has(o.id)).map((o) => o.id);
    }
    this.emit();
  }

  endReview(): void {
    this.ui.review = null;
    this.emit();
  }

  // ---------------------------------------------------------------- variants

  /**
   * VARIANTS — inherit everything, state only the differences. A variant is a
   * file with a base and a diff, not a copy of the object.
   */
  createVariant(baseName: string, name: string): PrefabDef | null {
    const clean = name.trim();
    if (!clean) {
      this.setStatus("A variant needs a name");
      return null;
    }
    if (this.project.prefabs.some((p) => p.name === clean)) {
      this.setStatus(`Prefab "${clean}" already exists`);
      return null;
    }
    if (!findPrefab(this.project, baseName)) {
      this.setStatus(`No prefab named "${baseName}" to inherit from`);
      return null;
    }
    if (!canInherit(this.project, baseName, clean)) {
      this.setStatus(
        `${baseName} is already a variant of a variant — two levels deep is the limit`,
      );
      return null;
    }

    const variant: PrefabDef = { name: clean, base: baseName, diff: {}, exposed: [] };
    this.transact(`Create variant ${clean}`, () => {
      this.project.prefabs.push(variant);
    });
    this.setStatus(`Wrote ${prefabFilePath(clean)} — inherits ${baseName}, 0 fields differ`);
    return variant;
  }

  /** Variants that resolve from this prefab, at any depth. */
  variantsOf(name: string): PrefabDef[] {
    return variantsOf(this.project, name);
  }

  /** Drop one claim a variant makes, so the base's value flows through again. */
  clearVariantDiff(name: string, path: string): void {
    this.transact(`Revert ${path} to base`, () => {
      const variant = this.project.prefabs.find((p) => p.name === name);
      if (variant?.diff) delete variant.diff[path];
    });
  }

  // --------------------------------------------------------------- instances

  /** Push one instance's overridden values up into the definition. */
  applyInstanceToPrefab(objId: string): void {
    const obj = this.scene?.objects.find((o) => o.id === objId);
    const stored = findPrefab(this.project, obj?.prefab);
    if (!obj || !stored) return;

    this.transact(`Apply to prefab ${stored.name}`, () => {
      if (stored.base) {
        // On a variant the values become part of ITS diff, not the base's:
        // one instance should not rewrite what every sibling inherits.
        stored.diff = { ...(stored.diff ?? {}) };
        for (const [path, value] of Object.entries(obj.overrides ?? {})) {
          stored.diff[path] = structuredClone(value);
        }
      } else if (stored.root) {
        for (const [path, value] of Object.entries(obj.overrides ?? {})) {
          setPath(stored.root as unknown as Record<string, unknown>, path, structuredClone(value));
        }
      }
      obj.overrides = {};
    });
    this.setStatus(
      `Applied ${obj.name}'s overrides to ${stored.base ? "variant" : "prefab"} ${stored.name}`,
    );
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
      const scene = this.scene;
      const obj = scene?.objects.find((o) => o.id === objId);
      if (scene && obj) this.unpackInstanceIn(scene, obj);
    });
  }

  deletePrefab(name: string): void {
    if (this.prefabDoc?.name === name && !this.closePrefab(true)) return;
    const dependents = this.project.prefabs.filter((p) => p.base === name);
    this.transact(`Delete prefab ${name}`, () => {
      // A variant cannot outlive its base, so it is flattened into one first.
      for (const variant of dependents) {
        const resolved = resolvePrefab(this.project, variant.name);
        if (!resolved) continue;
        variant.root = resolved.root;
        variant.exposed = resolved.exposed;
        delete variant.base;
        delete variant.diff;
      }
      for (const scene of this.project.scenes) {
        for (const obj of scene.objects) {
          if (obj.prefab === name) this.unpackInstanceIn(scene, obj);
        }
      }
      this.project.prefabs = this.project.prefabs.filter((p) => p.name !== name);
    });
    this.setStatus(
      dependents.length
        ? `Deleted ${name} — ${dependents.length} variant(s) flattened into their own definitions`
        : `Deleted ${name} — instances unpacked into plain objects`,
    );
  }

  private unpackInstanceIn(_scene: SceneData, obj: SceneObject): void {
    const prefab = resolvePrefab(this.project, obj.prefab);
    if (!prefab) return;
    const node = prefab.root as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(node)) {
      if (key === "children" || key === "lid" || INSTANCE_OWNED.has(key)) continue;
      (obj as unknown as Record<string, unknown>)[key] = structuredClone(value);
    }
    for (const [path, value] of Object.entries(obj.overrides ?? {})) {
      setPath(obj as unknown as Record<string, unknown>, path, structuredClone(value));
    }
    delete obj.prefab;
    delete obj.overrides;
  }

  // -------------------------------------------------------------------
  // Script components — the behaviour attached to an object
  // -------------------------------------------------------------------

  /**
   * The project's script index, when one is running. It is derived state, not
   * project data: it never enters a transaction, and validation consults it
   * only to say whether a reference still resolves.
   */
  scriptIndex: ScriptRegistry | null = null;

  setScriptIndex(index: ScriptRegistry | null): void {
    this.scriptIndex = index;
  }

  /** The scripts an object actually has — a prefab's list, under its overrides. */
  scriptsFor(obj: SceneObject): ScriptRef[] {
    return scriptsOf(obj.prefab ? resolveObject(this.project, obj) : obj);
  }

  private objectById(id: string): SceneObject | undefined {
    return this.scene?.objects.find((o) => o.id === id);
  }

  /**
   * The array a write may mutate directly, or null when the object still
   * inherits its list from a prefab. A null answer is not a refusal: single
   * values are written as overrides instead (see setScriptProp).
   */
  private writableScripts(obj: SceneObject): ScriptRef[] | null {
    if (!obj.prefab || !findPrefab(this.project, obj.prefab)) {
      if (!obj.scripts) obj.scripts = [];
      return obj.scripts;
    }
    const owned = obj.overrides?.[SCRIPT_LIST_PATH];
    return Array.isArray(owned) ? (owned as ScriptRef[]) : null;
  }

  /**
   * Hands the instance the whole list, because it is about to change the list
   * itself rather than a value in it — attaching, removing or reordering a
   * script inherited from a prefab is an override of `scripts`.
   *
   * Per-value overrides are folded in first: once the array is owned they
   * would be applied twice, and their order against the array is not defined.
   */
  private ownScripts(obj: SceneObject): ScriptRef[] {
    const existing = this.writableScripts(obj);
    if (existing) return existing;
    const list = structuredClone(this.scriptsFor(obj));
    const overrides: Record<string, unknown> = { ...(obj.overrides ?? {}) };
    for (const path of Object.keys(overrides)) {
      if (path.startsWith("scripts.")) delete overrides[path];
    }
    overrides[SCRIPT_LIST_PATH] = list;
    obj.overrides = overrides;
    return list;
  }

  /**
   * Adds a script to every selected object, at the end of the run order. The
   * argument is a class from the index — a name and the file it was found in —
   * because an attach that cannot resolve is not one the editor should make.
   */
  attachScript(ids: string[], cls: { name: string; src: string }): void {
    if (!ids.length) return;
    this.transact(`Attach ${cls.name}`, () => {
      for (const id of ids) {
        const obj = this.objectById(id);
        if (!obj) continue;
        const list = this.writableScripts(obj) ?? this.ownScripts(obj);
        list.push(newScriptRef(cls.name, cls.src));
      }
    });
    this.setStatus(`Attached ${cls.name} to ${ids.length} object(s)`);
  }

  detachScript(id: string, index: number): void {
    const obj = this.objectById(id);
    if (!obj) return;
    const name = this.scriptsFor(obj)[index]?.class ?? "script";
    this.transact(`Detach ${name}`, () => {
      const list = this.writableScripts(obj) ?? this.ownScripts(obj);
      list.splice(index, 1);
    });
  }

  /** Run order IS execution order, so the list is the thing being edited. */
  moveScript(id: string, index: number, delta: number): void {
    const obj = this.objectById(id);
    if (!obj) return;
    const target = index + delta;
    if (target < 0 || target >= this.scriptsFor(obj).length) return;
    this.transact("Reorder scripts", () => {
      const list = this.writableScripts(obj) ?? this.ownScripts(obj);
      const [moved] = list.splice(index, 1);
      list.splice(target, 0, moved);
    });
  }

  /**
   * The checkbox is enabled state, not deletion: the values a disabled script
   * holds are kept, and the runtime still constructs it.
   */
  setScriptEnabled(id: string, index: number, enabled: boolean): void {
    const obj = this.objectById(id);
    if (!obj) return;
    this.transact(enabled ? "Enable script" : "Disable script", () => {
      const list = this.writableScripts(obj);
      if (list) {
        if (list[index]) list[index].enabled = enabled;
        return;
      }
      this.writeOverride(obj, scriptEnabledPath(index), enabled);
    });
  }

  /**
   * Writes one property value. On a prefab instance this records an override
   * against the prefab's value rather than editing the definition — which is
   * what keeps a scene full of instances predictable.
   */
  setScriptProp(id: string, index: number, name: string, value: unknown): void {
    const obj = this.objectById(id);
    if (!obj) return;
    this.transact(`Set ${name}`, () => {
      const list = this.writableScripts(obj);
      if (list) {
        if (list[index]) list[index].props[name] = value;
        return;
      }
      this.writeOverride(obj, scriptPropPath(index, name), value);
    });
  }

  /** Drops a value so the field falls back to the class's declared default. */
  clearScriptProp(id: string, index: number, name: string): void {
    const obj = this.objectById(id);
    if (!obj) return;
    this.transact(`Clear ${name}`, () => {
      const list = this.writableScripts(obj);
      if (list) {
        if (list[index]) delete list[index].props[name];
        return;
      }
      // An inherited script's value can only be un-set back to the prefab's.
      this.revertOverrideIn(obj, scriptPropPath(index, name));
    });
  }

  /** Points a reference at a class again after the file moved or was renamed. */
  relinkScript(id: string, index: number, cls: { name: string; src: string }): void {
    const obj = this.objectById(id);
    if (!obj) return;
    this.transact(`Relink ${cls.name}`, () => {
      const list = this.writableScripts(obj) ?? this.ownScripts(obj);
      const script = list[index];
      if (!script) return;
      script.class = cls.name;
      script.src = cls.src;
    });
  }

  private writeOverride(obj: SceneObject, path: string, value: unknown): void {
    obj.overrides = { ...(obj.overrides ?? {}), [path]: structuredClone(value) };
  }

  private revertOverrideIn(obj: SceneObject, path: string): void {
    if (!obj.overrides) return;
    const next = { ...obj.overrides };
    delete next[path];
    obj.overrides = next;
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
      // References live in three places: on plain objects, in an instance's
      // overrides, and in a definition. Clearing only the first leaves an
      // instance pointing at an animation that no longer exists.
      for (const scene of this.project.scenes) {
        for (const obj of scene.objects) {
          if (obj.playOnSpawn === key) delete obj.playOnSpawn;
          if (obj.overrides?.playOnSpawn === key) delete obj.overrides.playOnSpawn;
        }
      }
      for (const prefab of this.project.prefabs) {
        if (prefab.root) {
          for (const node of walkNodes(prefab.root)) {
            if (node.playOnSpawn === key) delete node.playOnSpawn;
          }
        }
        if (prefab.diff?.playOnSpawn === key) delete prefab.diff.playOnSpawn;
      }
    });
    if (this.ui.animKey === key) this.ui.animKey = this.project.anims[0]?.key ?? null;
  }

  /**
   * Script references are validated against the index, never against the file
   * system: a class that cannot be resolved is an error the user can act on
   * (relink, or fix the class), and a value the class no longer declares is a
   * warning rather than something the editor quietly deletes.
   */
  private validateScripts(
    scene: SceneData,
    obj: SceneObject,
  ): { level: "error" | "warn"; message: string }[] {
    const index = this.scriptIndex;
    if (!index) return [];
    const issues: { level: "error" | "warn"; message: string }[] = [];
    const where = `${scene.key}/${obj.name}`;

    this.scriptsFor(obj).forEach((ref) => {
      const resolution = index.resolve(ref);
      if (resolution.status === "missing") {
        issues.push({
          level: "error",
          message: `${where}: script "${ref.class}" (${ref.src}) does not resolve — relink it or restore the class`,
        });
        return;
      }
      if (resolution.status === "moved") {
        issues.push({
          level: "warn",
          message: `${where}: "${ref.class}" now lives in ${resolution.cls.src} — relink to keep the reference exact`,
        });
      }
      const declared = index.properties(resolution.cls);
      for (const [name, value] of Object.entries(ref.props ?? {})) {
        const property = declared.find((p) => p.name === name);
        if (!property) {
          issues.push({
            level: "warn",
            message: `${where}: "${ref.class}.${name}" is set in this scene but is no longer declared`,
          });
          continue;
        }
        if (!fitsType(property.type, value)) {
          issues.push({
            level: "warn",
            message: `${where}: "${ref.class}.${name}" holds a ${typeof value} but is declared ${property.type}`,
          });
        }
      }
    });
    return issues;
  }

  /** Missing anim keys are a validation error, not a silent no-op. */
  validate(): { level: "error" | "warn"; message: string }[] {
    const issues: { level: "error" | "warn"; message: string }[] = [];
    const animKeys = new Set(this.project.anims.map((a) => a.key));
    const textureKeys = new Set(this.project.assets.map((a) => a.key));
    for (const scene of this.project.scenes) {
      for (const raw of scene.objects) {
        // Resolved, not raw: an instance keeps its own values in `overrides`,
        // so validating the raw node would never see what the game will draw.
        const obj = resolveObject(this.project, raw);
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
        if (obj.prefab && !resolvePrefab(this.project, obj.prefab)) {
          issues.push({
            level: "error",
            message: `${scene.key}/${obj.name}: prefab "${obj.prefab}" is missing`,
          });
        }
        issues.push(...this.validateScripts(scene, obj));
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

  /**
   * Groups are a taxonomy the project owns, not one the editor supplies. The
   * five a new project starts with are a starting point — renaming and
   * removing them has to work, or they are hardcoded in practice whatever the
   * data model says.
   */
  renameGroup(from: string, to: string): void {
    const clean = to.trim();
    if (!clean || from === clean) return;
    if (this.project.groups.includes(clean)) {
      this.setStatus(`There is already a group called "${clean}"`);
      return;
    }
    this.transact(`Rename group ${from}`, () => {
      this.project.groups = this.project.groups.map((g) => (g === from ? clean : g));
      const matrix = this.project.collision;
      matrix[clean] = matrix[from] ?? {};
      delete matrix[from];
      for (const row of Object.values(matrix)) {
        if (from in row) {
          row[clean] = row[from];
          delete row[from];
        }
      }
      // Every object naming the old group follows it, in the same transaction.
      for (const scene of this.project.scenes) {
        for (const obj of scene.objects) if (obj.group === from) obj.group = clean;
      }
      for (const prefab of this.project.prefabs) {
        if (prefab.root) for (const node of walkNodes(prefab.root)) {
          if (node.group === from) node.group = clean;
        }
      }
    });
  }

  removeGroup(name: string): void {
    if (!this.project.groups.includes(name)) return;
    const users = this.project.scenes.reduce(
      (n, scene) => n + scene.objects.filter((o) => o.group === name).length,
      0,
    );
    this.transact(`Remove group ${name}`, () => {
      this.project.groups = this.project.groups.filter((g) => g !== name);
      delete this.project.collision[name];
      for (const row of Object.values(this.project.collision)) delete row[name];
      for (const scene of this.project.scenes) {
        for (const obj of scene.objects) if (obj.group === name) delete obj.group;
      }
      for (const prefab of this.project.prefabs) {
        if (prefab.root) for (const node of walkNodes(prefab.root)) {
          if (node.group === name) delete node.group;
        }
      }
    });
    this.setStatus(
      users
        ? `Removed group "${name}" — ${users} object(s) are now ungrouped`
        : `Removed group "${name}"`,
    );
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
    this.prefabDoc = null;
    this.ui.prefabPlan = null;
    this.ui.review = null;
    this.project = project;
    // Folders written before local ids existed have none; give them theirs
    // once, on the way in, so overrides can address parts from here on.
    for (const prefab of project.prefabs) if (prefab.root) ensureLids(prefab.root);
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

/**
 * Where a prefab's definition lives on disk. Prefabs sit beside the generated
 * classes the exporter writes for them, so the definition and the code it
 * becomes are in one folder.
 */
export function prefabFilePath(name: string): string {
  return `src/prefabs/${name}.prefab.json`;
}

/**
 * The paths on which two trees disagree — what a variant has to state for
 * itself. Only leaves are compared, so an unrelated change on the base still
 * flows through a variant that never mentioned it.
 */
function diffNodePaths(base: PrefabNode, mine: PrefabNode): string[] {
  const before = flattenNode(base);
  const after = flattenNode(mine);
  const paths = new Set<string>();
  for (const [path, value] of after) {
    if (!before.has(path) || !same(before.get(path), value)) paths.add(path);
  }
  for (const path of before.keys()) if (!after.has(path)) paths.add(path);

  // Structure is claimed whole: a variant that changed its children states the
  // list, because a per-leaf diff cannot express "one fewer child".
  if (JSON.stringify(childShape(base)) !== JSON.stringify(childShape(mine))) paths.add("children");
  return [...paths];
}

function childShape(node: PrefabNode): unknown {
  return (node.children ?? []).map((c) => [c.lid, childShape(c)]);
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
