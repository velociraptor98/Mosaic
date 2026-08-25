import { uid, uniqueKey, uniqueName } from "../store/ids";
import { unbindableParams } from "../../shared/prefabBinding";
import {
  DEFAULT_COLLIDE_WORLD_BOUNDS,
} from "../../shared/size";
import type {
  AnimDef,
  AssetDef,
  BodyDef,
  Layer,
  ProjectData,
  SceneData,
  PrefabDef,
  PrefabSource,
  SceneObject,
  TextDef,
} from "../../shared/types";

/**
 * Turns a recording of somebody else's Phaser scene into one of ours.
 *
 * Mosaic's model is declarative and a hand-written `create()` is not, so there
 * is no sound way to READ that code into objects. What there is a sound way to
 * do is *run* it and look at what it built: the recording this consumes is a
 * snapshot of `scene.children.list` taken the moment `create()` returned, plus
 * the loader calls and animations that got it there.
 *
 * That makes the boundary sharp and explainable, which matters more here than
 * coverage: anything `create()` builds is imported, anything built later — in
 * `update()`, on a timer, on an event — is not, because at snapshot time it
 * does not exist. This function never guesses at the difference.
 *
 * It is pure. The recording arrives as data, so the mapping is testable
 * against a real third-party scene without booting anything.
 */

export interface RecordedBody {
  w: number;
  h: number;
  immovable: boolean;
  allowGravity: boolean;
  collideWorldBounds: boolean;
  bounceX?: number;
  bounceY?: number;
}

export interface RecordedObject {
  /** Constructor name. A non-builtin one names a prefab candidate. */
  kind: string;
  name: string | null;
  /** Parent's name or kind, for objects inside a Container. */
  parent: string | null;
  x: number;
  y: number;
  depth: number;
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  originX: number;
  originY: number;
  visible: boolean;
  texture?: string;
  frame?: string;
  text?: string;
  /** Animation playing when the snapshot was taken. */
  anim?: string;
  body?: RecordedBody;
}

export interface RecordedLoad {
  method: string;
  args: unknown[];
  /** `load.setPath()` in effect at the call. */
  path?: string;
  /** `load.setBaseURL()` in effect at the call — set means remote. */
  baseURL?: string;
}

export interface RecordedAnim {
  key: string;
  frameRate: number;
  repeat: number;
  yoyo?: boolean;
  frames: { textureKey: string; frame: string }[];
}

export interface RecordedTexture {
  key: string;
  width: number;
  height: number;
  /** PNG data URL, read back off the texture Phaser actually resolved. */
  dataUrl: string;
  /** Atlas frame boxes; empty for a plain image. */
  frames: { name: string; x: number; y: number; w: number; h: number; pivotX: number; pivotY: number }[];
}

export interface Recording {
  sceneKey: string;
  settings: {
    backgroundColor?: string | null;
    /**
     * The camera colour's alpha. An untouched camera reports a perfectly valid
     * `#000000` at alpha 0, so the colour alone cannot say whether anyone set
     * it — and taking it at face value silently replaces the author's real
     * background with black.
     */
    backgroundColorAlpha?: number | null;
    /** The game config's colour, which the scene camera does not carry. */
    gameBackgroundColor?: string | null;
    canvas?: { w: number; h: number } | null;
    worldBounds?: { w: number; h: number } | null;
    gravityY?: number | null;
  };
  anims: RecordedAnim[];
  loads: RecordedLoad[];
  objects: RecordedObject[];
  /** The pixels behind the keys, captured after the loader finished. */
  textures?: RecordedTexture[];
}

export interface PrefabCandidate {
  /** The class every one of these objects was constructed from. */
  className: string;
  count: number;
  /** Set when the project's own class can be constructed from a snapshot. */
  bound?: PrefabSource;
  /** Parameters that stopped it being bound, when it could not be. */
  blockedBy?: string[];
}

/**
 * What the caller knows about the project's own classes.
 *
 * Supplied by the script index rather than the recording: a snapshot knows the
 * constructor NAME, only the source knows its signature and which file it is
 * in, and both are needed to construct one.
 */
export interface KnownClass {
  name: string;
  /** Project-relative module path. */
  src: string;
  isDefault: boolean;
  ctorParams: string[] | null;
}

export interface ImportResult {
  scene: SceneData;
  anims: AnimDef[];
  assets: Omit<AssetDef, "url">[];
  /**
   * Art to write into the project, base64 PNG.
   *
   * An import that only recorded asset *paths* produced a scene that could not
   * draw: the paths were relative to a web root the project does not have, or
   * pointed at a CDN. The bytes the loader actually resolved are the one thing
   * that is true regardless, so they come along and land under `assets/`.
   */
  files: { rel: string; base64: string }[];
  prefabCandidates: PrefabCandidate[];
  /** Prefabs backed by the project's own classes, ready to add. */
  prefabs: PrefabDef[];
  issues: string[];
}

/**
 * Phaser's own display types. Anything else is a subclass the project wrote,
 * which is the strongest prefab signal a snapshot can carry: eight objects of
 * class `Snowman` are eight instances of one authored thing, and saying so is
 * better than importing eight unrelated sprites that happen to match.
 */
const BUILTIN_KINDS = new Set([
  "Image",
  "Sprite",
  "Text",
  "Container",
  "ArcadeImage",
  "ArcadeSprite",
  "TileSprite",
  "BitmapText",
  "Graphics",
  "Rectangle",
  "Zone",
]);

const DEFAULT_TEXT: Omit<TextDef, "content"> = {
  fontFamily: "sans-serif",
  fontSize: 16,
  color: "#ffffff",
  align: "left",
  wrapWidth: 0,
};

export function sceneFromRecording(rec: Recording, known: KnownClass[] = []): ImportResult {
  const issues: string[] = [];

  // ---- 1. what is actually in the scene ------------------------------------
  // An object pool is the normal way to write a Phaser game and the normal way
  // to ruin an import: this scene carries 64 pre-spawned snowballs, parked and
  // switched off until the game needs one. They are machinery, not content.
  //
  // `visible` is the whole test. Parking position is not — a full-screen
  // overlay legitimately sits at (0, 0), and an earlier version of this filter
  // threw one away for it.
  const live = rec.objects.filter((o) => o.visible);
  const parked = rec.objects.length - live.length;
  if (parked) {
    issues.push(
      `Skipped ${parked} hidden object(s) — pooled or switched off at create() time, not authored content`,
    );
  }

  // ---- 2. layers ----------------------------------------------------------
  // Phaser orders by a depth number, Mosaic by layer position. The distinct
  // depths ARE the layering the author expressed, so they map across directly
  // instead of everything landing in one pile.
  const depths = [...new Set(live.map((o) => o.depth))].sort((a, b) => a - b);
  const layers: Layer[] = depths.map((d) => ({
    id: uid("layer"),
    name: depths.length === 1 ? "Objects" : `Depth ${d}`,
    kind: "object",
    visible: true,
    locked: false,
  }));
  const layerByDepth = new Map(depths.map((d, i) => [d, layers[i].id]));

  // ---- 3. objects ---------------------------------------------------------
  // What makes something a container is that things are inside it, not what
  // its class is called. Projects subclass Container constantly — `Door`,
  // `Card`, `HealthBar` — and matching the name "Container" would type every
  // one of them as a textureless sprite while still parenting children to it.
  //
  // An empty subclass is the one case this cannot see, and a container with
  // nothing in it imports the same either way.
  const hasChildren = new Set(live.map((o) => o.parent).filter((p): p is string => !!p));

  const names: string[] = [];
  const idByRecord = new Map<RecordedObject, string>();
  const objects: SceneObject[] = [];
  let unnamed = 0;

  for (const o of live) {
    // Nothing here calls setName(), so identity has to be built rather than
    // read. The class name is the most meaningful thing available.
    let base = o.name;
    if (!base) {
      unnamed += 1;
      base = o.frame ? `${o.kind}_${o.frame}` : o.kind;
    }
    const name = uniqueName(base, names);
    names.push(name);

    const id = uid("obj");
    idByRecord.set(o, id);

    objects.push({
      id,
      name,
      type:
        o.text !== undefined
          ? "text"
          : o.kind === "Container" || (o.name !== null && hasChildren.has(o.name))
            ? "container"
            : "sprite",
      layerId: layerByDepth.get(o.depth)!,
      parentId: null, // resolved below, once every id exists
      x: o.x,
      y: o.y,
      rotation: o.rotationDeg,
      scaleX: o.scaleX,
      scaleY: o.scaleY,
      originX: o.originX,
      originY: o.originY,
      visible: true,
      // A Text object's texture is a canvas Phaser minted for it, with a uuid
      // for a key. Carrying that across would invent an asset that does not
      // exist, so text keeps its content and no texture at all.
      ...(o.text === undefined && o.texture ? { texture: o.texture } : {}),
      ...(o.text === undefined && o.frame ? { frame: o.frame } : {}),
      ...(o.text !== undefined ? { text: { ...DEFAULT_TEXT, content: o.text } } : {}),
      ...(o.anim ? { playOnSpawn: o.anim } : {}),
      ...(o.body ? { body: bodyFrom(o.body) } : {}),
      data: {},
    });
  }

  // Containers: the recording names a parent, so re-point children at the id.
  const byName = new Map<string, string>();
  for (const [rec_, id] of idByRecord) if (rec_.name) byName.set(rec_.name, id);
  live.forEach((o, i) => {
    if (!o.parent) return;
    const parentId = byName.get(o.parent);
    if (parentId) objects[i].parentId = parentId;
  });

  if (unnamed) {
    issues.push(
      `${unnamed} object(s) had no name — Phaser only keeps one if setName() was called, so they were named after their class`,
    );
  }
  if (live.some((o) => o.text !== undefined)) {
    issues.push(
      "Text styling (font, size, colour) is not recoverable from a snapshot — imported text uses the editor's defaults",
    );
  }

  // ---- 4. scene settings --------------------------------------------------
  // Prefer what the scene set, fall back to what the game config declared —
  // but only count the camera when its alpha says somebody actually set it.
  const cameraSet = (rec.settings.backgroundColorAlpha ?? 1) > 0;
  const bg =
    (cameraSet ? firstColour(rec.settings.backgroundColor) : null) ??
    firstColour(rec.settings.gameBackgroundColor) ??
    "#000000";
  const canvas = rec.settings.worldBounds ?? rec.settings.canvas ?? { w: 960, h: 540 };

  const scene: SceneData = {
    key: uniqueKey(rec.sceneKey, []),
    name: rec.sceneKey,
    settings: {
      width: canvas.w,
      height: canvas.h,
      backgroundColor: bg,
      gravityY: rec.settings.gravityY ?? 0,
      gridSize: 32,
    },
    layers,
    objects,
  };

  // ---- 5. animations ------------------------------------------------------
  const anims: AnimDef[] = rec.anims.map((a) => ({
    key: a.key,
    fps: a.frameRate,
    repeat: a.repeat,
    ...(a.yoyo ? { yoyo: true } : {}),
    frames: a.frames.map((f) => ({ textureKey: f.textureKey, frame: f.frame })),
  }));

  // ---- 6. assets ----------------------------------------------------------
  // The loader calls say what was asked for; the captured textures say what was
  // actually resolved. Prefer the second: it is the only version that survives
  // a CDN base URL or a path relative to a web root this project does not have.
  const { assets, remote } = assetsFrom(rec.loads);
  const files: { rel: string; base64: string }[] = [];
  const byKey = new Map(assets.map((a) => [a.key, a]));

  for (const tex of rec.textures ?? []) {
    const comma = tex.dataUrl.indexOf(",");
    if (comma < 0) continue;
    const rel = `assets/imported/${safeFile(tex.key)}.png`;
    files.push({ rel, base64: tex.dataUrl.slice(comma + 1) });

    const frames =
      tex.frames.length > 1
        ? tex.frames.map((f) => ({
            name: f.name,
            x: f.x,
            y: f.y,
            w: f.w,
            h: f.h,
            pivotX: f.pivotX,
            pivotY: f.pivotY,
          }))
        : undefined;

    const existing = byKey.get(tex.key);
    if (existing) {
      existing.path = rel;
      existing.width = tex.width;
      existing.height = tex.height;
      if (frames) {
        existing.kind = "atlas";
        existing.frames = frames;
      }
    } else {
      // Loaded some way the loader recorder did not model — still real art.
      const asset: Omit<AssetDef, "url"> = {
        id: `asset-${tex.key}`,
        key: tex.key,
        kind: frames ? "atlas" : "image",
        path: rel,
        width: tex.width,
        height: tex.height,
        ...(frames ? { frames } : {}),
      };
      assets.push(asset);
      byKey.set(tex.key, asset);
    }
  }

  // Anything with no captured bytes is dropped rather than recorded.
  //
  // Audio is the usual case: the recorder reads textures back off the GPU-free
  // texture manager, and there is no equivalent for a sound. Keeping those in
  // the manifest looked tidier but was worse — every one became a permanent
  // "missing from disk" warning against a file the project never had, which is
  // noise the user cannot act on. Saying it once, here, is honest.
  const unresolved = assets.filter((a) => !a.path.startsWith("assets/imported/"));
  const resolved = assets.filter((a) => a.path.startsWith("assets/imported/"));
  if (unresolved.length) {
    issues.push(
      `${unresolved.length} asset(s) had no bytes to bring across (${unresolved
        .slice(0, 3)
        .map((a) => a.key)
        .join(", ")}${unresolved.length > 3 ? ", …" : ""}) — audio is not captured, so these were left out rather than imported as broken references`,
    );
  }
  if (remote.length && files.length) {
    issues.push(
      `Art was fetched from ${remote[0]} and is being copied into assets/imported/ — the project itself has no copy of it`,
    );
  }

  // ---- 7. prefab candidates ----------------------------------------------
  // A class the project wrote is the strongest signal a snapshot carries, and
  // when its constructor can be satisfied it is more than a signal: the scene
  // can construct the real thing, with its real behaviour, instead of a sprite
  // that looks like it and does nothing.
  const counts = new Map<string, number>();
  for (const o of live) {
    if (BUILTIN_KINDS.has(o.kind)) continue;
    counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  }
  const knownByName = new Map(known.map((k) => [k.name, k]));
  const prefabCandidates: PrefabCandidate[] = [...counts]
    .map(([className, count]) => {
      const cls = knownByName.get(className);
      if (!cls || cls.ctorParams === null) return { className, count };
      const blocked = unbindableParams(cls.ctorParams);
      if (blocked.length) return { className, count, blockedBy: blocked };
      return {
        className,
        count,
        bound: {
          module: cls.src,
          export: cls.isDefault ? "default" : cls.name,
          params: cls.ctorParams,
        },
      };
    })
    .sort((a, b) => b.count - a.count);

  for (const c of prefabCandidates) {
    if (!c.blockedBy) continue;
    issues.push(
      `${c.className} takes ${c.blockedBy.join(", ")} in its constructor — a scene snapshot cannot supply that, so its ${c.count} object(s) came in as plain sprites rather than the real class`,
    );
  }

  // ---- 8. bind the instances to those prefabs -----------------------------
  // Only the bound ones. An unbound class stays a plain sprite: a prefab that
  // cannot be constructed would export a scene that throws on the first line.
  const prefabs: PrefabDef[] = [];
  for (const candidate of prefabCandidates) {
    if (!candidate.bound) continue;
    const sample = live.find((o) => o.kind === candidate.className);
    if (!sample) continue;
    prefabs.push({
      name: candidate.className,
      exposed: ["x", "y", "visible", "scaleX", "scaleY", "rotation"],
      source: candidate.bound,
      root: {
        lid: uid("lid"),
        name: candidate.className,
        type: "sprite",
        x: 0,
        y: 0,
        rotation: 0,
        scaleX: sample.scaleX,
        scaleY: sample.scaleY,
        originX: sample.originX,
        originY: sample.originY,
        visible: true,
        ...(sample.texture ? { texture: sample.texture } : {}),
        ...(sample.frame ? { frame: sample.frame } : {}),
        ...(sample.body ? { body: bodyFrom(sample.body) } : {}),
        data: {},
        children: [],
      },
    });
  }

  const boundNames = new Set(prefabs.map((p) => p.name));
  live.forEach((o, i) => {
    if (!boundNames.has(o.kind)) return;
    objects[i].prefab = o.kind;
    // A prefab instance's children come from the class's own constructor, so
    // the ones the snapshot saw inside it are not the scene's to place.
    objects[i].texture = undefined;
    objects[i].frame = undefined;
  });
  const boundChildIds = new Set(
    objects.filter((o) => o.prefab).map((o) => o.id),
  );
  const kept = objects.filter((o) => !(o.parentId && boundChildIds.has(o.parentId)));
  scene.objects = kept;

  if (prefabs.length) {
    issues.push(
      `${prefabs.length} class(es) bound to the project's own code (${prefabs
        .map((p) => `${p.name} → ${p.source!.module}`)
        .join(", ")}) — the exported scene constructs the real thing`,
    );
  }

  return { scene, anims, assets: resolved, files, prefabCandidates, prefabs, issues };
}

/** A loader key is free-form; a filename is not. */
function safeFile(key: string): string {
  return key.replace(/[^\w.-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "asset";
}

function bodyFrom(b: RecordedBody): BodyDef {
  return {
    shape: "box",
    width: b.w,
    height: b.h,
    radius: Math.round(Math.max(b.w, b.h) / 2),
    offsetX: 0,
    offsetY: 0,
    immovable: b.immovable,
    allowGravity: b.allowGravity,
    // Phaser tracks bounce per axis; Mosaic authors one number. They agree in
    // every case a body was given a plain setBounce().
    bounce: b.bounceX ?? 0,
    collideWorldBounds: b.collideWorldBounds ?? DEFAULT_COLLIDE_WORLD_BOUNDS,
  };
}

/** "rgba(0,0,0,1)" and "#3366b2" both arrive here; "" and null do not count. */
function firstColour(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (m) {
    return (
      "#" +
      [m[1], m[2], m[3]]
        .map((n) => Number(n).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  return value.startsWith("#") ? value : null;
}

/**
 * Loader calls back into asset metadata.
 *
 * The loader is a stateful API — `setPath` and `setBaseURL` apply to every call
 * after them, and `load.image()` takes a key, an array of keys, or a config
 * object. The recording captures the path state at each call so this does not
 * have to replay the loader to know where a file was coming from.
 */
function assetsFrom(loads: RecordedLoad[]): {
  assets: Omit<AssetDef, "url">[];
  remote: string[];
} {
  const assets: Omit<AssetDef, "url">[] = [];
  const remote: string[] = [];
  const seen = new Set<string>();

  const push = (key: string, path: string, extra: Partial<AssetDef> = {}) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    assets.push({
      id: `asset-${key}`,
      key,
      kind: (extra.kind ?? "image") as AssetDef["kind"],
      path,
      width: 0,
      height: 0,
      ...extra,
    } as Omit<AssetDef, "url">);
  };

  for (const load of loads) {
    if (load.baseURL && !remote.includes(load.baseURL)) remote.push(load.baseURL);
    const dir = load.path ?? "";
    const [first, second, third] = load.args as [unknown, unknown, unknown];

    // `load.image([ "a", "b" ])` — the key is also the filename.
    if (Array.isArray(first)) {
      for (const key of first as string[]) push(key, `${dir}${key}.png`);
      continue;
    }
    if (typeof first !== "string") continue;
    const key = first;

    switch (load.method) {
      case "atlas":
        push(key, `${dir}${typeof second === "string" ? second : key + ".png"}`, {
          kind: "atlas",
        });
        break;
      case "spritesheet": {
        const cfg = (third ?? {}) as { frameWidth?: number; frameHeight?: number };
        push(key, `${dir}${typeof second === "string" ? second : key + ".png"}`, {
          kind: "spritesheet",
          frameWidth: cfg.frameWidth ?? 0,
          frameHeight: cfg.frameHeight ?? 0,
        });
        break;
      }
      case "audio": {
        // Phaser takes a list of formats and picks one; the first is enough to
        // name the asset, and the rest are the same sound.
        const src = Array.isArray(second) ? (second as string[])[0] : second;
        push(key, `${dir}${typeof src === "string" ? src : key + ".mp3"}`, { kind: "audio" });
        break;
      }
      case "image":
        push(key, `${dir}${typeof second === "string" ? second : key + ".png"}`);
        break;
      default:
        // glsl, json, bitmapFont and friends have no Mosaic equivalent.
        break;
    }
  }

  return { assets, remote };
}

/**
 * Folds an imported scene into a project.
 *
 * Additive on purpose. The project may already hold work — the starter Mosaic
 * showed, or an earlier import — and an import is the user asking for one more
 * scene, never for everything else to be replaced. Keys and asset keys are
 * de-duplicated rather than overwritten, so importing twice gives two scenes
 * instead of silently eating the first.
 */
export function applyImport(project: ProjectData, imported: ImportResult): string[] {
  const notes: string[] = [];

  const key = uniqueKey(imported.scene.key, project.scenes.map((s) => s.key));
  if (key !== imported.scene.key) {
    notes.push(`Imported as "${key}" — "${imported.scene.key}" was already taken.`);
  }
  project.scenes.push({ ...imported.scene, key, name: imported.scene.name });

  let addedAssets = 0;
  const assetKeys = new Set(project.assets.map((a) => a.key));
  for (const asset of imported.assets) {
    if (assetKeys.has(asset.key)) continue;
    assetKeys.add(asset.key);
    // The bytes are not copied: these files live where the project already put
    // them, and an import that duplicated somebody's art folder into ours would
    // be a worse outcome than one that points at it.
    project.assets.push({ ...asset, url: "" } as ProjectData["assets"][number]);
    addedAssets += 1;
  }
  if (addedAssets) notes.push(`Added ${addedAssets} asset reference(s).`);

  let addedPrefabs = 0;
  const prefabNames = new Set(project.prefabs.map((p) => p.name));
  for (const prefab of imported.prefabs) {
    if (prefabNames.has(prefab.name)) continue;
    prefabNames.add(prefab.name);
    project.prefabs.push(prefab);
    addedPrefabs += 1;
  }
  if (addedPrefabs) notes.push(`Bound ${addedPrefabs} prefab(s) to the project's own classes.`);

  let addedAnims = 0;
  const animKeys = new Set(project.anims.map((a) => a.key));
  for (const anim of imported.anims) {
    if (animKeys.has(anim.key)) continue;
    animKeys.add(anim.key);
    project.anims.push(anim);
    addedAnims += 1;
  }
  if (addedAnims) notes.push(`Added ${addedAnims} animation(s).`);

  return [...notes, ...imported.issues];
}
