import Phaser from "phaser";
import { resolveObject } from "../shared/prefabs";
import { objectsById as indexObjects, worldTransform } from "../shared/transform";
import { collectLoaderManifest } from "../shared/manifest";
import { scriptsOf } from "../shared/scripts";
import { ScriptHost, type ScriptComponent } from "./scripts";
import type {
  AnimDef,
  ProjectData,
  SceneData,
  SceneObject,
  TileLayer,
} from "../shared/types";

/**
 * The runtime scene builder. This is the code path the editor's play-test
 * uses AND the code path a shipped game uses, which is the whole point: what
 * you tune in the editor is what runs.
 *
 *   class Level1 extends Phaser.Scene {
 *     preload() { preloadProject(this, project, scene); }
 *     create()  { const { objectsById } = buildScene(this, project, scene); }
 *   }
 *
 * Nothing here imports React, the editor bridge, or any UI code.
 */

export interface BuiltScene {
  objectsById: Map<string, Phaser.GameObjects.Sprite>;
  tileLayers: Map<string, Phaser.Tilemaps.TilemapLayer>;
  groups: Map<string, Phaser.Physics.Arcade.Group>;
  /** Pairs wired from the project collision matrix, for debugging/inspection. */
  pairs: { a: string; b: string; rule: string }[];
  /** Set when script classes were supplied and something was attached. */
  scripts: ScriptHost | null;
}

export function preloadProject(
  scene: Phaser.Scene,
  project: ProjectData,
  sceneData: SceneData,
): void {
  for (const entry of collectLoaderManifest(project, sceneData)) {
    if (scene.textures.exists(entry.key) && entry.type !== "audio") continue;
    switch (entry.type) {
      case "spritesheet":
        scene.load.spritesheet(entry.key, entry.url, entry.frameConfig!);
        break;
      case "atlas":
        // Atlas frames are registered by hand after load (see registerAtlasFrames)
        // so an atlas needs no companion JSON file at runtime.
        scene.load.image(entry.key, entry.url);
        break;
      case "audio":
        scene.load.audio(entry.key, entry.url);
        break;
      default:
        scene.load.image(entry.key, entry.url);
    }
  }
}

/** Adds hand-sliced atlas frames onto an already-loaded base texture. */
export function registerAtlasFrames(scene: Phaser.Scene, project: ProjectData): void {
  for (const asset of project.assets) {
    if (asset.kind !== "atlas" || !asset.frames) continue;
    if (!scene.textures.exists(asset.key)) continue;
    const texture = scene.textures.get(asset.key);
    for (const frame of asset.frames) {
      if (texture.has(frame.name)) continue;
      texture.add(frame.name, 0, frame.x, frame.y, frame.w, frame.h);
    }
  }
}

export function registerAnimations(scene: Phaser.Scene, anims: AnimDef[]): void {
  for (const def of anims) {
    if (!def.frames.length) continue;
    if (scene.anims.exists(def.key)) scene.anims.remove(def.key);
    scene.anims.create({
      key: def.key,
      frames: def.frames.map((f) => ({
        key: f.textureKey,
        frame: f.frame,
        duration: f.duration ?? 0,
      })),
      frameRate: def.fps,
      repeat: def.loop ? -1 : 0,
    });
  }
}

export function buildScene(
  scene: Phaser.Scene,
  project: ProjectData,
  data: SceneData,
  options: {
    physics?: boolean;
    /**
     * Script classes by name. Behaviour is your code, so the loader cannot
     * import it — hand it the classes and the scene's script references are
     * constructed, given their authored values and run. Omit it and scripts
     * are inert, which is what the editor's play-test does.
     */
    scripts?: Record<string, new () => ScriptComponent>;
  } = {},
): BuiltScene {
  const withPhysics = options.physics !== false && !!scene.physics;
  const host = options.scripts ? new ScriptHost(scene) : null;
  registerAtlasFrames(scene, project);
  registerAnimations(scene, project.anims);

  const tileLayers = new Map<string, Phaser.Tilemaps.TilemapLayer>();
  const objectsByIdMap = new Map<string, Phaser.GameObjects.Sprite>();
  const groups = new Map<string, Phaser.Physics.Arcade.Group>();
  const index = indexObjects(data);

  data.layers.forEach((layer, depth) => {
    if (layer.kind === "tile") {
      const created = createTileLayer(scene, project, layer, depth);
      if (created) {
        tileLayers.set(layer.id, created);
        if (withPhysics) {
          const tileset = project.assets.find((a) => a.id === layer.tilesetId);
          const collides = tileset?.tileCollides ?? [];
          if (collides.length) created.setCollision(collides);
        }
      }
      return;
    }

    for (const obj of data.objects) {
      if (obj.layerId !== layer.id) continue;
      const resolved = resolveObject(project, obj);
      if (resolved.type === "container") continue;
      const sprite = createSprite(scene, resolved, index, depth, withPhysics);
      if (!sprite) continue;
      objectsByIdMap.set(obj.id, sprite);
      if (host && options.scripts) attachScripts(host, sprite, resolved, options.scripts);

      const groupName = resolved.group;
      if (withPhysics && groupName && resolved.body) {
        let group = groups.get(groupName);
        if (!group) {
          group = scene.physics.add.group();
          groups.set(groupName, group);
        }
        group.add(sprite);
      }
    }
  });

  const pairs = withPhysics ? wireCollisions(scene, project, groups, tileLayers) : [];

  return { objectsById: objectsByIdMap, tileLayers, groups, pairs, scripts: host };
}

/**
 * Attaches an object's scripts in list order — the order the editor shows,
 * because that order is what update() is called in.
 *
 * A reference whose class was not supplied is skipped with a warning rather
 * than throwing: one missing behaviour should not take the scene down.
 */
function attachScripts(
  host: ScriptHost,
  sprite: Phaser.GameObjects.Sprite,
  obj: SceneObject,
  classes: Record<string, new () => ScriptComponent>,
): void {
  for (const ref of scriptsOf(obj)) {
    // Keyed by path first, so two classes of one name stay apart; a game that
    // supplies a plain name -> class map still resolves.
    const Ctor = classes[`${ref.src}::${ref.class}`] ?? classes[ref.class];
    if (!Ctor) {
      console.warn(`[mosaic] ${obj.name}: no class supplied for script "${ref.class}"`);
      continue;
    }
    host.add(sprite, new Ctor(), ref.props ?? {}, ref.enabled);
  }
}

function createTileLayer(
  scene: Phaser.Scene,
  project: ProjectData,
  layer: TileLayer,
  depth: number,
): Phaser.Tilemaps.TilemapLayer | null {
  const tileset = project.assets.find((a) => a.id === layer.tilesetId);
  if (!tileset || !scene.textures.exists(tileset.key)) return null;

  const map = scene.make.tilemap({
    data: layer.data,
    tileWidth: layer.tileWidth,
    tileHeight: layer.tileHeight,
  });
  const image = map.addTilesetImage(
    tileset.key,
    tileset.key,
    tileset.frameWidth ?? layer.tileWidth,
    tileset.frameHeight ?? layer.tileHeight,
    tileset.margin ?? 0,
    tileset.spacing ?? 0,
  );
  if (!image) return null;
  // gpu:false keeps the classic TilemapLayer, which is what the editor's
  // per-tile hit-testing and the collision helpers below expect.
  const created = map.createLayer(0, image, 0, 0, false) as Phaser.Tilemaps.TilemapLayer | null;
  if (!created) return null;
  created.setDepth(depth);
  created.setVisible(layer.visible);
  created.setName(layer.name);
  return created;
}

function createSprite(
  scene: Phaser.Scene,
  obj: SceneObject,
  index: Map<string, SceneObject>,
  depth: number,
  withPhysics: boolean,
): Phaser.GameObjects.Sprite | null {
  const world = worldTransform(obj, index);
  const textureKey = obj.texture;
  if (!textureKey || !scene.textures.exists(textureKey)) return null;

  const sprite =
    withPhysics && obj.body
      ? scene.physics.add.sprite(world.x, world.y, textureKey, obj.frame)
      : scene.add.sprite(world.x, world.y, textureKey, obj.frame);

  sprite.setName(obj.name);
  sprite.setRotation(Phaser.Math.DegToRad(world.rotation));
  sprite.setScale(world.scaleX, world.scaleY);
  sprite.setOrigin(obj.originX, obj.originY);
  sprite.setVisible(obj.visible);
  sprite.setDepth(depth);
  sprite.setData("sceneObjectId", obj.id);
  sprite.setData("sceneObject", obj);
  for (const [k, v] of Object.entries(obj.data ?? {})) sprite.setData(k, v);

  if (withPhysics && obj.body) applyBody(sprite, obj);
  if (obj.playOnSpawn && scene.anims.exists(obj.playOnSpawn)) sprite.play(obj.playOnSpawn);

  return sprite;
}

export function applyBody(sprite: Phaser.GameObjects.Sprite, obj: SceneObject): void {
  const body = sprite.body as Phaser.Physics.Arcade.Body | null;
  const def = obj.body;
  if (!body || !def) return;
  if (def.shape === "circle") {
    body.setCircle(def.radius, def.offsetX, def.offsetY);
  } else {
    body.setSize(def.width, def.height, false);
    body.setOffset(def.offsetX, def.offsetY);
  }
  body.setImmovable(def.immovable);
  body.setAllowGravity(def.allowGravity);
  body.setBounce(def.bounce, def.bounce);
  body.setCollideWorldBounds(true);
}

/**
 * Pair rules are authored once per project instead of being scattered through
 * create(). Every unordered pair is wired at most once.
 */
function wireCollisions(
  scene: Phaser.Scene,
  project: ProjectData,
  groups: Map<string, Phaser.Physics.Arcade.Group>,
  tileLayers: Map<string, Phaser.Tilemaps.TilemapLayer>,
): { a: string; b: string; rule: string }[] {
  const seen = new Set<string>();
  const pairs: { a: string; b: string; rule: string }[] = [];

  for (const [a, row] of Object.entries(project.collision ?? {})) {
    for (const [b, rule] of Object.entries(row ?? {})) {
      if (rule === "ignore") continue;
      const key = [a, b].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const ga = groups.get(a);
      const gb = groups.get(b);
      if (!ga || !gb) continue;
      if (rule === "overlap") scene.physics.add.overlap(ga, gb);
      else scene.physics.add.collider(ga, gb);
      pairs.push({ a, b, rule });
    }
  }

  // Everything with a body collides with solid tile layers.
  for (const layer of tileLayers.values()) {
    for (const group of groups.values()) scene.physics.add.collider(group, layer);
  }

  return pairs;
}
