import Phaser from "phaser";
import { resolveObject } from "../../shared/prefabs";
import { objectsById, worldTransform } from "../../shared/transform";
import type { Layer, SceneObject, TileLayer } from "../../shared/types";
import type { EditorBridge } from "../bridge";
import type { ProjectStore } from "../store/project";
import { edgeCandidates, snapPoint } from "./snapping";
import { syncTextures } from "./textures";

export interface EditorSceneInit {
  store: ProjectStore;
  bridge: EditorBridge;
}

interface TileLayerView {
  map: Phaser.Tilemaps.Tilemap;
  layer: Phaser.Tilemaps.TilemapLayer;
  shadow: number[][];
  signature: string;
}

type DragKind = "move" | "scale" | "body" | "marquee" | "pan" | "rect" | null;

const HANDLE_SIZE = 8;
const SNAP_THRESHOLD_PX = 6;

/**
 * Canvas gizmos, from the reference document's ramps. The palette is
 * deliberately monochrome, so the gizmos are told apart by VALUE and by line
 * style (bodies are dashed) rather than by inventing new hues.
 */
const INK = {
  grid: 0x1d1f20,
  bounds: 0x5980a6, // accent
  selection: 0x5980a6, // accent
  handle: 0x2c455d, // accent-800
  body: 0x1d2d3d, // accent-900, dashed
  guide: 0x94bce3, // accent-400
  marquee: 0x5980a6, // accent
  rect: 0x728fab, // accent-2
  container: 0x728fab, // accent-2
} as const;

/** Phaser's Graphics has no dash support; bodies want one. */
function dashedRect(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  dash: number,
): void {
  const run = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.floor(len / dash));
    const dx = (bx - ax) / steps;
    const dy = (by - ay) / steps;
    for (let i = 0; i < steps; i += 2) {
      g.lineBetween(ax + dx * i, ay + dy * i, ax + dx * (i + 1), ay + dy * (i + 1));
    }
  };
  run(x, y, x + w, y);
  run(x + w, y, x + w, y + h);
  run(x + w, y + h, x, y + h);
  run(x, y + h, x, y);
}

function dashedCircle(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  r: number,
  dash: number,
): void {
  const steps = Math.max(8, Math.floor((2 * Math.PI * r) / dash));
  for (let i = 0; i < steps; i += 2) {
    const a0 = (i / steps) * Math.PI * 2;
    const a1 = ((i + 1) / steps) * Math.PI * 2;
    g.lineBetween(
      cx + Math.cos(a0) * r,
      cy + Math.sin(a0) * r,
      cx + Math.cos(a1) * r,
      cy + Math.sin(a1) * r,
    );
  }
}

/**
 * The WYSIWYG canvas: a real Phaser scene rendering the real scene data, with
 * the editor's tools layered on top. It reads and writes the ProjectStore
 * directly — the store, not this scene, is the source of truth.
 */
export class EditorScene extends Phaser.Scene {
  private store!: ProjectStore;
  private bridge!: EditorBridge;

  private tileViews = new Map<string, TileLayerView>();
  private sprites = new Map<string, Phaser.GameObjects.Sprite>();
  private gridGfx!: Phaser.GameObjects.Graphics;
  private overlayGfx!: Phaser.GameObjects.Graphics;

  private needsSync = true;
  private texturesReady = false;
  private unsubscribe: (() => void) | null = null;

  private drag: DragKind = null;
  private dragStart = { x: 0, y: 0 };
  private dragOrigin = new Map<string, { x: number; y: number }>();
  private dragScaleOrigin = new Map<string, { scaleX: number; scaleY: number; w: number; h: number }>();
  private dragBodyOrigin: { width: number; height: number; offsetX: number; offsetY: number } | null = null;
  private handleIndex = -1;
  private marquee = { x: 0, y: 0, w: 0, h: 0 };
  private rectStart = { col: 0, row: 0 };
  private rectEnd = { col: 0, row: 0 };
  private guides: { x: number | null; y: number | null } = { x: null, y: null };
  /** Prefab resolution memo, rebuilt only when the store actually changes. */
  private resolvedCache = new Map<string, SceneObject>();
  private resolvedVersion = -1;
  private altDown = false;
  private spaceDown = false;
  private lastPaintCell = "";

  constructor() {
    super("EditorScene");
  }

  init(data: EditorSceneInit): void {
    this.store = data.store;
    this.bridge = data.bridge;
  }

  create(): void {
    // create() runs again every time the editor comes back from a play-test,
    // so the caches from the previous run must not survive into this one.
    this.tileViews.clear();
    this.sprites.clear();
    this.drag = null;
    this.guides = { x: null, y: null };
    this.needsSync = true;

    this.gridGfx = this.add.graphics().setDepth(50);
    this.overlayGfx = this.add.graphics().setDepth(10000);

    syncTextures(this, this.store.project, () => {
      this.texturesReady = true;
      this.needsSync = true;
    });

    this.unsubscribe = this.store.subscribe(() => {
      this.needsSync = true;
    });

    this.wireInput();
    this.applyCamera();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    });
  }

  /**
   * The overlay redraws every frame, so resolution is memoised per store
   * version rather than cloning prefab instances 60 times a second.
   */
  private resolved(obj: SceneObject): SceneObject {
    if (!obj.prefab) return obj;
    if (this.resolvedVersion !== this.store.version) {
      this.resolvedCache.clear();
      this.resolvedVersion = this.store.version;
    }
    let hit = this.resolvedCache.get(obj.id);
    if (!hit) {
      hit = resolveObject(this.store.project, obj);
      this.resolvedCache.set(obj.id, hit);
    }
    return hit;
  }

  update(): void {
    if (this.needsSync) {
      this.needsSync = false;
      this.syncAll();
    }
    this.drawOverlay();
  }

  // -------------------------------------------------------------------
  // Sync: store -> canvas
  // -------------------------------------------------------------------

  private syncAll(): void {
    const scene = this.store.scene;
    if (!scene) return;
    if (!this.texturesReady) syncTextures(this, this.store.project, () => (this.texturesReady = true));
    else syncTextures(this, this.store.project);

    this.cameras.main.setBackgroundColor(scene.settings.backgroundColor);
    this.applyCamera();
    this.syncTileLayers();
    this.syncSprites();
    this.drawGrid();
  }

  private applyCamera(): void {
    const { camera } = this.store.view;
    const cam = this.cameras.main;
    cam.setZoom(camera.zoom);
    cam.setScroll(camera.x, camera.y);
  }

  private syncTileLayers(): void {
    const scene = this.store.scene!;
    const seen = new Set<string>();

    scene.layers.forEach((layer, depth) => {
      if (layer.kind !== "tile") return;
      seen.add(layer.id);
      const tile = layer as TileLayer;
      const tileset = this.store.project.assets.find((a) => a.id === tile.tilesetId);
      if (!tileset || !this.textures.exists(tileset.key)) return;

      const signature = `${tile.tilesetId}:${tile.cols}x${tile.rows}:${tile.tileWidth}x${tile.tileHeight}`;
      let view = this.tileViews.get(tile.id);
      if (view && view.signature !== signature) {
        view.layer.destroy();
        view.map.destroy();
        this.tileViews.delete(tile.id);
        view = undefined;
      }

      if (!view) {
        const map = this.make.tilemap({
          data: tile.data.map((row) => [...row]),
          tileWidth: tile.tileWidth,
          tileHeight: tile.tileHeight,
        });
        const image = map.addTilesetImage(
          tileset.key,
          tileset.key,
          tileset.frameWidth ?? tile.tileWidth,
          tileset.frameHeight ?? tile.tileHeight,
          tileset.margin ?? 0,
          tileset.spacing ?? 0,
        );
        if (!image) return;
        const created = map.createLayer(0, image, 0, 0, false) as Phaser.Tilemaps.TilemapLayer | null;
        if (!created) return;
        view = {
          map,
          layer: created,
          shadow: tile.data.map((row) => [...row]),
          signature,
        };
        this.tileViews.set(tile.id, view);
      } else {
        // Only push the cells that actually changed — a paint stroke should
        // not rebuild the whole layer.
        for (let r = 0; r < tile.rows; r++) {
          for (let c = 0; c < tile.cols; c++) {
            const next = tile.data[r]?.[c] ?? -1;
            if (view.shadow[r]?.[c] === next) continue;
            view.map.putTileAt(next, c, r, false, view.layer);
            if (!view.shadow[r]) view.shadow[r] = [];
            view.shadow[r][c] = next;
          }
        }
      }

      view.layer.setDepth(depth * 100);
      view.layer.setVisible(layer.visible);
      view.layer.setAlpha(this.layerAlpha(layer));
    });

    for (const [id, view] of [...this.tileViews]) {
      if (seen.has(id)) continue;
      view.layer.destroy();
      view.map.destroy();
      this.tileViews.delete(id);
    }
  }

  private layerAlpha(layer: Layer): number {
    const active = this.store.view.activeLayerId;
    if (!active || layer.id === active) return 1;
    return layer.locked ? 0.45 : 1;
  }

  private syncSprites(): void {
    const scene = this.store.scene!;
    const index = objectsById(scene);
    const seen = new Set<string>();
    const layerDepth = new Map(scene.layers.map((l, i) => [l.id, i]));

    scene.objects.forEach((raw, i) => {
      const obj = this.resolved(raw);
      if (obj.type === "container") return;
      const layer = scene.layers.find((l) => l.id === raw.layerId);
      if (!layer) return;

      const key = obj.texture;
      if (!key || !this.textures.exists(key)) return;
      seen.add(raw.id);

      let sprite = this.sprites.get(raw.id);
      const frame = obj.frame && this.textures.get(key).has(obj.frame) ? obj.frame : undefined;
      if (!sprite) {
        sprite = this.add.sprite(0, 0, key, frame);
        sprite.setData("id", raw.id);
        this.sprites.set(raw.id, sprite);
      } else if (sprite.texture.key !== key || (frame && sprite.frame.name !== frame)) {
        sprite.setTexture(key, frame);
      }

      const world = worldTransform(raw, index);
      sprite.setPosition(world.x, world.y);
      sprite.setRotation(Phaser.Math.DegToRad(world.rotation));
      sprite.setScale(world.scaleX, world.scaleY);
      sprite.setOrigin(obj.originX, obj.originY);
      sprite.setVisible(obj.visible && layer.visible);
      sprite.setAlpha(layer.locked ? 0.4 : 1);
      sprite.setDepth((layerDepth.get(raw.layerId) ?? 0) * 100 + 1 + i * 0.01);
    });

    for (const [id, sprite] of [...this.sprites]) {
      if (seen.has(id)) continue;
      sprite.destroy();
      this.sprites.delete(id);
    }
  }

  private drawGrid(): void {
    const scene = this.store.scene!;
    const g = this.gridGfx;
    g.clear();
    if (!this.store.ui.showGrid) return;
    const size = scene.settings.gridSize;
    const w = scene.settings.width;
    const h = scene.settings.height;
    g.lineStyle(1, INK.grid, 0.08);
    for (let x = 0; x <= w; x += size) g.lineBetween(x, 0, x, h);
    for (let y = 0; y <= h; y += size) g.lineBetween(0, y, w, y);
    g.lineStyle(1, INK.bounds, 0.85);
    g.strokeRect(0, 0, w, h);
  }

  // -------------------------------------------------------------------
  // Overlay: selection, handles, bodies, guides, marquee
  // -------------------------------------------------------------------

  private drawOverlay(): void {
    const scene = this.store.scene;
    const g = this.overlayGfx;
    g.clear();
    if (!scene) return;
    const zoom = this.cameras.main.zoom || 1;

    if (this.store.ui.showBodies) {
      g.lineStyle(1 / zoom, INK.body, 0.85);
      for (const obj of scene.objects) {
        const resolved = this.resolved(obj);
        if (!resolved.body) continue;
        const sprite = this.sprites.get(obj.id);
        if (!sprite) continue;
        this.strokeBody(g, sprite, resolved);
      }
    }

    const selected = this.store.selection;
    for (const obj of selected) {
      const sprite = this.sprites.get(obj.id);
      if (sprite) {
        const b = sprite.getBounds();
        g.lineStyle(1.5 / zoom, INK.selection, 1);
        g.strokeRect(b.x, b.y, b.width, b.height);
      } else if (obj.type === "container") {
        const world = worldTransform(obj, this.selectionIndex(scene));
        g.lineStyle(1.5 / zoom, INK.container, 1);
        g.strokeRect(world.x - 12, world.y - 12, 24, 24);
        g.lineBetween(world.x - 18, world.y, world.x + 18, world.y);
        g.lineBetween(world.x, world.y - 18, world.x, world.y + 18);
      }
    }

    if (selected.length === 1) {
      const sprite = this.sprites.get(selected[0].id);
      if (sprite) {
        const size = HANDLE_SIZE / zoom;
        g.fillStyle(INK.handle, 1);
        for (const p of this.handlePoints(sprite)) {
          g.fillRect(p.x - size / 2, p.y - size / 2, size, size);
        }
      }
      if (this.store.ui.showBodies) {
        const resolved = this.resolved(selected[0]);
        const sprite2 = this.sprites.get(selected[0].id);
        if (resolved.body && sprite2) {
          const size = HANDLE_SIZE / zoom;
          g.fillStyle(INK.body, 1);
          for (const p of this.bodyHandlePoints(sprite2, resolved)) {
            g.fillRect(p.x - size / 2, p.y - size / 2, size, size);
          }
        }
      }
    }

    if (this.guides.x !== null) {
      g.lineStyle(1 / zoom, INK.guide, 1);
      g.lineBetween(this.guides.x, 0, this.guides.x, scene.settings.height);
    }
    if (this.guides.y !== null) {
      g.lineStyle(1 / zoom, INK.guide, 1);
      g.lineBetween(0, this.guides.y, scene.settings.width, this.guides.y);
    }

    if (this.drag === "marquee") {
      g.lineStyle(1 / zoom, INK.marquee, 1);
      g.fillStyle(INK.marquee, 0.12);
      g.fillRect(this.marquee.x, this.marquee.y, this.marquee.w, this.marquee.h);
      g.strokeRect(this.marquee.x, this.marquee.y, this.marquee.w, this.marquee.h);
    }

    if (this.drag === "rect") {
      const layer = this.store.activeLayer;
      if (layer?.kind === "tile") {
        const tw = layer.tileWidth;
        const th = layer.tileHeight;
        const c0 = Math.min(this.rectStart.col, this.rectEnd.col);
        const c1 = Math.max(this.rectStart.col, this.rectEnd.col);
        const r0 = Math.min(this.rectStart.row, this.rectEnd.row);
        const r1 = Math.max(this.rectStart.row, this.rectEnd.row);
        g.lineStyle(1.5 / zoom, INK.rect, 1);
        g.fillStyle(INK.rect, 0.15);
        g.fillRect(c0 * tw, r0 * th, (c1 - c0 + 1) * tw, (r1 - r0 + 1) * th);
        g.strokeRect(c0 * tw, r0 * th, (c1 - c0 + 1) * tw, (r1 - r0 + 1) * th);
      }
    }
  }

  private indexCache: { version: number; map: Map<string, SceneObject> } | null = null;

  private selectionIndex(scene: { objects: SceneObject[] }): Map<string, SceneObject> {
    if (this.indexCache?.version !== this.store.version) {
      this.indexCache = {
        version: this.store.version,
        map: new Map(scene.objects.map((o) => [o.id, o])),
      };
    }
    return this.indexCache.map;
  }

  private strokeBody(
    g: Phaser.GameObjects.Graphics,
    sprite: Phaser.GameObjects.Sprite,
    obj: SceneObject,
  ): void {
    const body = obj.body!;
    const left = sprite.x - sprite.displayWidth * sprite.originX + body.offsetX;
    const top = sprite.y - sprite.displayHeight * sprite.originY + body.offsetY;
    const dash = 4 / (this.cameras.main.zoom || 1);
    if (body.shape === "circle") {
      dashedCircle(g, left + body.radius, top + body.radius, body.radius, dash);
    } else {
      dashedRect(g, left, top, body.width, body.height, dash);
    }
  }

  private handlePoints(sprite: Phaser.GameObjects.Sprite) {
    const b = sprite.getBounds();
    return [
      { x: b.left, y: b.top },
      { x: b.right, y: b.top },
      { x: b.right, y: b.bottom },
      { x: b.left, y: b.bottom },
    ];
  }

  private bodyHandlePoints(sprite: Phaser.GameObjects.Sprite, obj: SceneObject) {
    const body = obj.body!;
    const left = sprite.x - sprite.displayWidth * sprite.originX + body.offsetX;
    const top = sprite.y - sprite.displayHeight * sprite.originY + body.offsetY;
    const w = body.shape === "circle" ? body.radius * 2 : body.width;
    const h = body.shape === "circle" ? body.radius * 2 : body.height;
    return [
      { x: left, y: top },
      { x: left + w, y: top },
      { x: left + w, y: top + h },
      { x: left, y: top + h },
      { x: left + w / 2, y: top + h / 2 },
    ];
  }

  // -------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------

  private wireInput(): void {
    this.input.mouse?.disableContextMenu();

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.onPointerDown(p));
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => this.onPointerMove(p));
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => this.onPointerUp(p));

    this.input.on(
      "wheel",
      (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
        const cam = this.cameras.main;
        const before = cam.getWorldPoint(p.x, p.y);
        const zoom = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.2, 4);
        cam.setZoom(zoom);
        const after = cam.getWorldPoint(p.x, p.y);
        cam.setScroll(cam.scrollX + (before.x - after.x), cam.scrollY + (before.y - after.y));
        this.store.setCamera({ x: cam.scrollX, y: cam.scrollY, zoom });
      },
    );

    const keyboard = this.input.keyboard;
    keyboard?.on("keydown-ALT", () => (this.altDown = true));
    keyboard?.on("keyup-ALT", () => (this.altDown = false));
    keyboard?.on("keydown-SPACE", () => (this.spaceDown = true));
    keyboard?.on("keyup-SPACE", () => (this.spaceDown = false));
  }

  /** Alt suspends snapping for a single drag rather than requiring a toggle. */
  private snapEnabled(): boolean {
    return this.store.ui.snap !== this.altDown;
  }

  private cellAt(p: Phaser.Input.Pointer, layer: TileLayer) {
    return {
      col: Math.floor(p.worldX / layer.tileWidth),
      row: Math.floor(p.worldY / layer.tileHeight),
    };
  }

  private onPointerDown(p: Phaser.Input.Pointer): void {
    const scene = this.store.scene;
    if (!scene) return;
    this.bridge.send("requestFocus", undefined);

    if (p.middleButtonDown() || this.spaceDown) {
      this.drag = "pan";
      this.dragStart = { x: p.x, y: p.y };
      return;
    }

    const tool = this.store.ui.tool;

    if (tool === "brush" || tool === "erase") {
      const layer = this.store.activeLayer;
      if (layer?.kind !== "tile") {
        this.store.setStatus("Pick a tile layer in the LAYERS panel to paint on");
        return;
      }
      this.store.beginStroke(tool === "erase" ? "Erase tiles" : "Paint tiles");
      this.lastPaintCell = "";
      this.paintAt(p, layer);
      return;
    }

    if (tool === "rect") {
      const layer = this.store.activeLayer;
      if (layer?.kind !== "tile") {
        this.store.setStatus("Rect fill needs a tile layer");
        return;
      }
      this.drag = "rect";
      this.rectStart = this.cellAt(p, layer);
      this.rectEnd = this.rectStart;
      return;
    }

    if (tool === "place") {
      this.placeAt(p);
      return;
    }

    // --- select tool ---
    const selected = this.store.selection;

    if (selected.length === 1 && this.store.ui.showBodies) {
      const resolved = this.resolved(selected[0]);
      const sprite = this.sprites.get(selected[0].id);
      if (resolved.body && sprite) {
        const idx = this.hitHandle(p, this.bodyHandlePoints(sprite, resolved));
        if (idx >= 0) {
          this.drag = "body";
          this.handleIndex = idx;
          this.dragStart = { x: p.worldX, y: p.worldY };
          this.dragBodyOrigin = { ...resolved.body };
          this.store.beginStroke("Resize body");
          return;
        }
      }
    }

    if (selected.length === 1) {
      const sprite = this.sprites.get(selected[0].id);
      if (sprite) {
        const idx = this.hitHandle(p, this.handlePoints(sprite));
        if (idx >= 0) {
          this.drag = "scale";
          this.handleIndex = idx;
          this.dragStart = { x: p.worldX, y: p.worldY };
          this.dragScaleOrigin.clear();
          this.dragScaleOrigin.set(selected[0].id, {
            scaleX: selected[0].scaleX,
            scaleY: selected[0].scaleY,
            w: sprite.width,
            h: sprite.height,
          });
          this.store.beginStroke("Scale");
          return;
        }
      }
    }

    const hit = this.hitObject(p);
    if (hit) {
      const view = this.store.view;
      if (p.event instanceof MouseEvent && (p.event.shiftKey || p.event.metaKey)) {
        this.store.toggleSelection(hit.id);
      } else if (!view.selection.includes(hit.id)) {
        this.store.setSelection([hit.id]);
      }
      this.drag = "move";
      this.dragStart = { x: p.worldX, y: p.worldY };
      this.dragOrigin.clear();
      for (const obj of this.store.selection) {
        this.dragOrigin.set(obj.id, { x: obj.x, y: obj.y });
      }
      this.store.beginStroke("Move");
      return;
    }

    this.drag = "marquee";
    this.dragStart = { x: p.worldX, y: p.worldY };
    this.marquee = { x: p.worldX, y: p.worldY, w: 0, h: 0 };
    if (!(p.event instanceof MouseEvent && p.event.shiftKey)) this.store.setSelection([]);
  }

  private onPointerMove(p: Phaser.Input.Pointer): void {
    const scene = this.store.scene;
    if (!scene) return;

    const layer = this.store.activeLayer;
    this.bridge.send("cursor", {
      x: Math.round(p.worldX),
      y: Math.round(p.worldY),
      col: layer?.kind === "tile" ? Math.floor(p.worldX / layer.tileWidth) : -1,
      row: layer?.kind === "tile" ? Math.floor(p.worldY / layer.tileHeight) : -1,
    });

    if ((this.store.ui.tool === "brush" || this.store.ui.tool === "erase") && p.isDown) {
      if (layer?.kind === "tile") this.paintAt(p, layer);
      return;
    }

    switch (this.drag) {
      case "pan": {
        const cam = this.cameras.main;
        cam.setScroll(
          cam.scrollX - (p.x - this.dragStart.x) / cam.zoom,
          cam.scrollY - (p.y - this.dragStart.y) / cam.zoom,
        );
        this.dragStart = { x: p.x, y: p.y };
        this.store.setCamera({ x: cam.scrollX, y: cam.scrollY });
        break;
      }
      case "move":
        this.dragMove(p);
        break;
      case "scale":
        this.dragScale(p);
        break;
      case "body":
        this.dragBody(p);
        break;
      case "marquee":
        this.marquee = {
          x: Math.min(this.dragStart.x, p.worldX),
          y: Math.min(this.dragStart.y, p.worldY),
          w: Math.abs(p.worldX - this.dragStart.x),
          h: Math.abs(p.worldY - this.dragStart.y),
        };
        break;
      case "rect": {
        if (layer?.kind === "tile") this.rectEnd = this.cellAt(p, layer);
        break;
      }
      default:
        break;
    }
  }

  private onPointerUp(p: Phaser.Input.Pointer): void {
    const tool = this.store.ui.tool;
    if (tool === "brush" || tool === "erase") {
      this.store.endStroke();
      this.lastPaintCell = "";
    }

    switch (this.drag) {
      case "move":
      case "scale":
      case "body":
        this.store.endStroke();
        this.guides = { x: null, y: null };
        this.bridge.send("snapHit", { x: null, y: null });
        break;
      case "marquee": {
        const picked = this.objectsIn(this.marquee);
        const additive = p.event instanceof MouseEvent && p.event.shiftKey;
        this.store.setSelection(
          additive ? [...this.store.view.selection, ...picked] : picked,
        );
        break;
      }
      case "rect": {
        const layer = this.store.activeLayer;
        if (layer?.kind === "tile") {
          const tileId = this.store.ui.brush?.tileId ?? 0;
          this.store.rectFill(layer.id, this.rectStart, this.rectEnd, tileId);
        }
        break;
      }
      default:
        break;
    }
    this.drag = null;
    this.handleIndex = -1;
  }

  // -------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------

  private paintAt(p: Phaser.Input.Pointer, layer: TileLayer): void {
    const { col, row } = this.cellAt(p, layer);
    const cell = `${col},${row}`;
    if (cell === this.lastPaintCell) return;
    this.lastPaintCell = cell;
    const tileId = this.store.ui.tool === "erase" ? -1 : (this.store.ui.brush?.tileId ?? 0);
    this.store.putTile(layer.id, col, row, tileId);
  }

  /**
   * Placement drops the object at the pointer, snapped, on the active object
   * layer, and selects it so the next move needs no re-click.
   */
  private placeAt(p: Phaser.Input.Pointer): void {
    const placement = this.store.ui.placement;
    if (!placement) {
      this.store.setStatus("Pick something in the asset dock first");
      return;
    }
    const point = this.snapWorld(p.worldX, p.worldY);
    this.guides = { x: null, y: null };

    if (placement.kind === "prefab") {
      const prefab = this.store.project.prefabs.find((pf) => pf.name === placement.id);
      if (!prefab) return;
      this.store.addObject({
        type: prefab.root.type,
        name: prefab.name,
        x: point.x,
        y: point.y,
        prefab: prefab.name,
        overrides: {},
        texture: prefab.root.texture,
        frame: prefab.root.frame,
        data: {},
      });
      return;
    }

    if (placement.kind === "asset") {
      const asset = this.store.project.assets.find((a) => a.id === placement.id);
      if (!asset) return;
      this.store.addObject({
        type: "sprite",
        name: asset.key,
        x: point.x,
        y: point.y,
        texture: asset.key,
        frame: placement.frame,
        data: {},
      });
      return;
    }

    const def = this.store.project.assets.find((a) => a.key === `obj-${placement.id}`);
    this.store.addObject({
      type: placement.id,
      x: point.x,
      y: point.y,
      texture: def?.key ?? `obj-${placement.id}`,
      data: {},
    });
  }

  private dragMove(p: Phaser.Input.Pointer): void {
    const dx = p.worldX - this.dragStart.x;
    const dy = p.worldY - this.dragStart.y;
    const selection = this.store.selection;
    if (!selection.length) return;

    const primary = selection[0];
    const origin = this.dragOrigin.get(primary.id);
    if (!origin) return;

    let targetX = origin.x + dx;
    let targetY = origin.y + dy;
    if (this.snapEnabled()) {
      const snapped = this.snapWorld(targetX, targetY, primary.id);
      targetX = snapped.x;
      targetY = snapped.y;
    } else {
      this.guides = { x: null, y: null };
    }

    const appliedDx = targetX - origin.x;
    const appliedDy = targetY - origin.y;
    for (const obj of selection) {
      const start = this.dragOrigin.get(obj.id);
      if (!start) continue;
      this.store.previewTransform(obj.id, start.x + appliedDx, start.y + appliedDy);
      this.bridge.send("transformPreview", {
        id: obj.id,
        x: start.x + appliedDx,
        y: start.y + appliedDy,
      });
    }
  }

  private dragScale(p: Phaser.Input.Pointer): void {
    const obj = this.store.selection[0];
    const origin = obj && this.dragScaleOrigin.get(obj.id);
    if (!obj || !origin) return;
    const dx = p.worldX - this.dragStart.x;
    const dy = p.worldY - this.dragStart.y;
    const signX = this.handleIndex === 0 || this.handleIndex === 3 ? -1 : 1;
    const signY = this.handleIndex === 0 || this.handleIndex === 1 ? -1 : 1;
    const nextW = Math.max(4, origin.w * Math.abs(origin.scaleX) + dx * signX * 2);
    const nextH = Math.max(4, origin.h * Math.abs(origin.scaleY) + dy * signY * 2);
    obj.scaleX = Math.round((nextW / origin.w) * 100) / 100;
    obj.scaleY = Math.round((nextH / origin.h) * 100) / 100;
    this.store.touch();
  }

  /**
   * The body draws over the sprite so the gap between art and collision is
   * visible while you drag it, and the numbers stay live in the Inspector.
   */
  private dragBody(p: Phaser.Input.Pointer): void {
    const obj = this.store.selection[0];
    if (!obj || !this.dragBodyOrigin) return;
    const body = obj.body ?? this.resolved(obj).body;
    if (!body) return;
    const dx = p.worldX - this.dragStart.x;
    const dy = p.worldY - this.dragStart.y;
    const origin = this.dragBodyOrigin;

    const next = { ...origin };
    if (this.handleIndex === 4) {
      next.offsetX = Math.round(origin.offsetX + dx);
      next.offsetY = Math.round(origin.offsetY + dy);
    } else {
      const signX = this.handleIndex === 0 || this.handleIndex === 3 ? -1 : 1;
      const signY = this.handleIndex === 0 || this.handleIndex === 1 ? -1 : 1;
      next.width = Math.max(2, Math.round(origin.width + dx * signX));
      next.height = Math.max(2, Math.round(origin.height + dy * signY));
      if (signX < 0) next.offsetX = Math.round(origin.offsetX + dx);
      if (signY < 0) next.offsetY = Math.round(origin.offsetY + dy);
    }

    const radius = Math.max(2, Math.round(Math.min(next.width, next.height) / 2));
    this.store.setObjectProp(
      obj.id,
      "body",
      { ...body, ...next, radius },
      "Resize body",
    );
    this.bridge.send("bodyPreview", {
      id: obj.id,
      width: next.width,
      height: next.height,
      offsetX: next.offsetX,
      offsetY: next.offsetY,
    });
  }

  // -------------------------------------------------------------------
  // Hit testing + snapping
  // -------------------------------------------------------------------

  /** Walks visible AND unlocked layers top-down, like the spec says. */
  private hitObject(p: Phaser.Input.Pointer): SceneObject | null {
    const scene = this.store.scene!;
    const order = [...scene.layers].reverse();
    for (const layer of order) {
      if (!layer.visible || layer.locked || layer.kind !== "object") continue;
      const members = scene.objects.filter((o) => o.layerId === layer.id);
      for (let i = members.length - 1; i >= 0; i--) {
        const obj = members[i];
        const sprite = this.sprites.get(obj.id);
        if (sprite?.visible && sprite.getBounds().contains(p.worldX, p.worldY)) {
          return this.pickThroughContainers(obj, scene);
        }
        if (obj.type === "container") {
          const world = worldTransform(obj, this.selectionIndex(scene));
          if (Math.abs(world.x - p.worldX) < 14 && Math.abs(world.y - p.worldY) < 14) return obj;
        }
      }
    }
    return null;
  }

  /**
   * Clicking a child of a container hits the container, so a whole set of
   * pickups moves as one node — unless the container is already selected, in
   * which case the click drills into the child.
   */
  private pickThroughContainers(obj: SceneObject, scene: { objects: SceneObject[] }): SceneObject {
    const index = this.selectionIndex(scene);
    const selected = new Set(this.store.view.selection);
    let node = obj;
    const chain: SceneObject[] = [obj];
    while (node.parentId) {
      const parent = index.get(node.parentId);
      if (!parent) break;
      chain.push(parent);
      node = parent;
    }
    // Deepest already-selected ancestor wins the drill-in.
    for (let i = chain.length - 1; i > 0; i--) {
      if (!selected.has(chain[i].id)) return chain[i];
    }
    return chain[0];
  }

  private hitHandle(p: Phaser.Input.Pointer, points: { x: number; y: number }[]): number {
    const zoom = this.cameras.main.zoom || 1;
    const r = (HANDLE_SIZE + 4) / zoom / 2;
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(points[i].x - p.worldX) <= r && Math.abs(points[i].y - p.worldY) <= r) return i;
    }
    return -1;
  }

  private objectsIn(rect: { x: number; y: number; w: number; h: number }): string[] {
    const scene = this.store.scene!;
    const bounds = new Phaser.Geom.Rectangle(rect.x, rect.y, rect.w, rect.h);
    const out: string[] = [];
    for (const obj of scene.objects) {
      const layer = scene.layers.find((l) => l.id === obj.layerId);
      if (!layer || !layer.visible || layer.locked) continue;
      const sprite = this.sprites.get(obj.id);
      if (!sprite) continue;
      if (Phaser.Geom.Rectangle.Overlaps(bounds, sprite.getBounds())) out.push(obj.id);
    }
    return out;
  }

  private snapWorld(x: number, y: number, excludeId?: string) {
    const scene = this.store.scene!;
    if (!this.snapEnabled()) {
      this.guides = { x: null, y: null };
      return { x: Math.round(x), y: Math.round(y) };
    }
    const boxes: {
      left: number;
      right: number;
      centerX: number;
      top: number;
      bottom: number;
      centerY: number;
    }[] = [];
    const camView = this.cameras.main.worldView;
    for (const obj of scene.objects) {
      if (obj.id === excludeId) continue;
      const sprite = this.sprites.get(obj.id);
      if (!sprite || !sprite.visible) continue;
      const b = sprite.getBounds();
      if (!Phaser.Geom.Rectangle.Overlaps(camView, b)) continue;
      boxes.push({
        left: b.left,
        right: b.right,
        centerX: b.centerX,
        top: b.top,
        bottom: b.bottom,
        centerY: b.centerY,
      });
    }
    const { xs, ys } = edgeCandidates(boxes);
    const result = snapPoint(x, y, {
      xs,
      ys,
      grid: scene.settings.gridSize,
      threshold: SNAP_THRESHOLD_PX,
      zoom: this.cameras.main.zoom || 1,
    });
    this.guides = { x: result.guideX, y: result.guideY };
    this.bridge.send("snapHit", { x: result.guideX, y: result.guideY });
    return { x: Math.round(result.x), y: Math.round(result.y) };
  }
}
