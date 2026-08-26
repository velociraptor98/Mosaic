import { collectLoaderManifest } from "../../shared/manifest";
import { SCRIPT_BASE_FILE, scriptsOf } from "../../shared/scripts";
import { resolveObject, resolvePrefab, resolvedIndex } from "../../shared/prefabs";
import { DEFAULT_COLLIDE_WORLD_BOUNDS } from "../../shared/size";
import { worldTransform } from "../../shared/transform";
import {
  animRepeat,
  boundsAreClosed,
  type AssetDef,
  type ProjectData,
  type SceneData,
  type SceneObject,
  type TileLayer,
} from "../../shared/types";
import { MANIFEST_PATH, toManifest } from "../project/serialize";
import { bindArgs } from "../../shared/prefabBinding";
import type { CollisionRule, PrefabSource } from "../../shared/types";

export interface GeneratedFile {
  path: string;
  contents: string;
  language: "json" | "ts";
}

export type ExportTarget = "sceneJson" | "tsSceneClass" | "tsSceneModule" | "both";

/**
 * The generator is pure: the same scene in produces the same bytes out, so
 * regenerating keeps diffs small enough to read in review.
 */
export function generateFiles(
  project: ProjectData,
  scene: SceneData,
  target: ExportTarget,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  if (target === "sceneJson" || target === "both") {
    files.push({
      path: `src/scenes/${scene.key}.scene.json`,
      contents: JSON.stringify(scene, null, 2) + "\n",
      language: "json",
    });
    // The same manifest the project reader consumes, so an exported folder
    // can be opened again — export is a round trip, not a one-way dump.
    files.push({
      path: MANIFEST_PATH,
      contents: JSON.stringify(toManifest(project), null, 2) + "\n",
      language: "json",
    });
  }

  if (target === "tsSceneModule") {
    files.push({
      path: `src/scenes/${sceneClassName(scene.key)}.objects.ts`,
      contents: generateSceneModule(project, scene),
      language: "ts",
    });
    for (const prefab of usedPrefabs(project, scene)) {
      if (resolvePrefab(project, prefab)?.source) continue;
      files.push({
        path: `src/prefabs/${className(prefab)}.ts`,
        contents: generatePrefabClass(project, prefab),
        language: "ts",
      });
    }
  }

  if (target === "tsSceneClass" || target === "both") {
    files.push({
      path: `src/scenes/${sceneClassName(scene.key)}.ts`,
      contents: generateSceneClass(project, scene),
      language: "ts",
    });
    for (const prefab of usedPrefabs(project, scene)) {
      // A prefab bound to the project's own class has nothing to generate:
      // writing a lookalike beside it would be the second definition of the
      // same thing, and the wrong one would win.
      if (resolvePrefab(project, prefab)?.source) continue;
      files.push({
        path: `src/prefabs/${className(prefab)}.ts`,
        contents: generatePrefabClass(project, prefab),
        language: "ts",
      });
    }
  }

  // An atlas is two files, and the generated `load.atlas(key, png, json)` names
  // both. The JSON side was never written — the slicer's status line said it
  // had been, but the frames only ever went into the manifest — so a generated
  // scene using an atlas failed to load one. Emitted here, from the frames the
  // project already holds, in the JSON-hash shape Phaser reads.
  if (target !== "sceneJson") {
    for (const entry of collectLoaderManifest(project, scene)) {
      if (entry.type !== "atlas") continue;
      const asset = project.assets.find((a) => a.key === entry.key);
      if (!asset?.frames?.length) continue;
      files.push({
        path: asset.path.replace(/\.\w+$/, ".atlas.json"),
        contents: atlasSidecar(asset),
        language: "json",
      });
    }
  }

  return files;
}

/** Phaser's JSON-hash atlas format, from the frames the editor already has. */
function atlasSidecar(asset: AssetDef): string {
  const frames: Record<string, unknown> = {};
  for (const f of asset.frames ?? []) {
    frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
      sourceSize: { w: f.w, h: f.h },
      pivot: { x: f.pivotX, y: f.pivotY },
    };
  }
  return (
    JSON.stringify(
      {
        frames,
        meta: {
          app: "Mosaic",
          image: asset.path.split("/").pop(),
          format: "RGBA8888",
          size: { w: asset.width, h: asset.height },
          scale: "1",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function usedPrefabs(project: ProjectData, scene: SceneData): string[] {
  const names = new Set<string>();
  for (const obj of scene.objects) if (obj.prefab) names.add(obj.prefab);
  return [...names].filter((n) => project.prefabs.some((p) => p.name === n)).sort();
}

/** Level_01 -> Level_01Scene */
export function sceneClassName(key: string): string {
  return `${className(key)}Scene`;
}

export function className(key: string): string {
  const cleaned = key.replace(/[^\w]+/g, "_");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function q(value: string): string {
  return JSON.stringify(value);
}

function varName(obj: SceneObject, used: Set<string>): string {
  let base = obj.name.replace(/[^\w]+/g, "_").replace(/^(\d)/, "_$1");
  if (!base) base = "obj";
  base = base.charAt(0).toLowerCase() + base.slice(1);
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

/**
 * Emit order: preload -> create(layers bottom-up) -> colliders -> animations.
 * play-on-spawn calls are emitted with the animations, after the anims they
 * reference exist.
 */
/**
 * How a generated scene relates to the project.
 *
 * `class` — Mosaic owns the scene: it emits a `Phaser.Scene` subclass with
 * keep-markers for hand-written code. Right for a project Mosaic started.
 *
 * `module` — the project owns the scene: Mosaic emits functions its existing
 * `create()` calls. Right for a project that already had one, where taking the
 * class over would mean rewriting somebody's game to import its layout.
 */
export type SceneEmitMode = "class" | "module";

export function generateSceneClass(project: ProjectData, scene: SceneData): string {
  return emitScene(project, scene, "class");
}

/** The non-owning form: functions the project's own scene calls. */
export function generateSceneModule(project: ProjectData, scene: SceneData): string {
  return emitScene(project, scene, "module");
}

function emitScene(project: ProjectData, scene: SceneData, mode: SceneEmitMode): string {
  const cls = sceneClassName(scene.key);
  const manifest = collectLoaderManifest(project, scene);
  // Resolved, so an instance composes its definition's transform, not the
  // stale copy stored on it.
  const index = resolvedIndex(project, scene);
  const used = new Set<string>();
  const varsById = new Map<string, string>();
  const groupVars = new Map<string, string>();
  /**
   * Pairs the matrix asked for, so the class can declare their hooks.
   *
   * BOTH rules get one. A "collide" pair used to be emitted as a bare
   * `physics.add.collider(a, b)` with nowhere to hang behaviour, so anything
   * that needed a physical response AND to know it happened — a brick that
   * breaks, a ball that leaves a paddle at an angle — could not be authored
   * here at all and had to be re-registered inside a script.
   */
  const pairHandlers: { name: string; a: string; b: string; rule: CollisionRule }[] = [];
  /** Body configuration, held back until every group exists. */
  const bodyLines: string[] = [];
  const usedPrefabClasses = new Set<string>();
  const objectKeys = new Set<string>();
  /** Script classes this scene constructs, keyed by src::class. */
  const scriptImports = new Map<string, { alias: string; module: string }>();
  /**
   * Module-scope identifiers already spoken for, so a script imported later
   * takes an alias instead of shadowing one.
   *
   * Seeded with the PREFAB class names before anything is emitted. A brick
   * prefab called `Brick` whose behaviour is a script called `Brick` is the
   * obvious way to author that object, and it used to emit two imports of the
   * same name — a file that does not compile, and whose first error is a
   * duplicate identifier rather than anything the author would recognise.
   */
  const scriptAliases = new Set<string>([
    "Phaser",
    "ScriptHost",
    "sceneData",
    cls,
    ...usedPrefabs(project, scene).map(className),
  ]);

  /** Keys of `this.objects`, kept unique even when two objects share a name. */
  const objectKey = (name: string, fallback: string): string => {
    let key = name;
    if (objectKeys.has(key)) key = fallback;
    let n = 2;
    while (objectKeys.has(key)) key = `${fallback}${n++}`;
    objectKeys.add(key);
    return key;
  };
  // The body is collected in sections rather than written straight out, so the
  // same emitted lines can be wrapped two ways: as a Phaser.Scene that Mosaic
  // owns, or as functions the project's OWN scene calls. Every line below uses
  // `this` for the scene, which is what makes the second form possible at all —
  // the module wrapper invokes the bodies with the caller's scene as `this`.
  const preloadBody: string[] = [];
  const createBody: string[] = [];
  const handlerBody: string[] = [];
  let L: string[] = preloadBody;

  // ---- preload ----
  if (!manifest.length) L.push(`    // No assets referenced by this scene.`);
  for (const entry of manifest) {
    const asset = project.assets.find((a) => a.key === entry.key);
    const path = asset?.path ?? `assets/${entry.key}.png`;
    if (entry.type === "spritesheet") {
      const fc = entry.frameConfig!;
      L.push(
        `    this.load.spritesheet(${q(entry.key)}, ${q(path)}, { frameWidth: ${fc.frameWidth}, frameHeight: ${fc.frameHeight}, margin: ${fc.margin}, spacing: ${fc.spacing} });`,
      );
    } else if (entry.type === "atlas") {
      L.push(`    this.load.atlas(${q(entry.key)}, ${q(path)}, ${q(path.replace(/\.\w+$/, ".atlas.json"))});`);
    } else if (entry.type === "audio") {
      L.push(`    this.load.audio(${q(entry.key)}, ${q(path)});`);
    } else {
      const note = asset?.generated ? "  // editor placeholder — replace with real art" : "";
      L.push(`    this.load.image(${q(entry.key)}, ${q(path)});${note}`);
    }
  }
  L.push(`    // <keep id="preload">`);
  L.push(`    // </keep>`);

  // ---- create ----
  L = createBody;
  if (scene.settings.backgroundColor) {
    L.push(`    this.cameras.main.setBackgroundColor(${q(scene.settings.backgroundColor)});`);
  }
  L.push(
    `    this.physics.world.setBounds(0, 0, ${scene.settings.width}, ${scene.settings.height});`,
  );
  // Only when a side is actually open: every closed rectangle is Arcade's own
  // default, and emitting it would be a line that says nothing.
  if (!boundsAreClosed(scene.settings.bounds)) {
    const b = scene.settings.bounds!;
    L.push(
      `    this.physics.world.setBoundsCollision(${b.left}, ${b.right}, ${b.top}, ${b.bottom});`,
    );
  }
  if (scene.settings.gravityY) {
    L.push(`    this.physics.world.gravity.y = ${scene.settings.gravityY};`);
  }
  if (sceneHasScripts(project, scene)) {
    // One host per scene owns the update loop, so scripts run in the order
    // this file attaches them — which is the order the editor's list shows.
    L.push(`    this.scripts = new ScriptHost(this);`);
  }
  L.push(``);

  scene.layers.forEach((layer, depth) => {
    if (layer.kind === "tile") {
      const tile = layer as TileLayer;
      const tileset = project.assets.find((a) => a.id === tile.tilesetId);
      if (!tileset) return;
      const v = varName({ name: tile.name } as SceneObject, used);
      L.push(`    // layer ${depth}: ${tile.name} (tiles)`);
      // Tile data stays in the .scene.json; the class reads it back so the
      // generated source does not carry thousands of literal numbers.
      L.push(
        `    const ${v}Data = (sceneData.layers[${depth}] as { data: number[][] }).data;`,
      );
      L.push(
        `    const ${v}Map = this.make.tilemap({ data: ${v}Data, tileWidth: ${tile.tileWidth}, tileHeight: ${tile.tileHeight} });`,
      );
      L.push(
        `    const ${v}Tiles = ${v}Map.addTilesetImage(${q(tileset.key)}, ${q(tileset.key)}, ${tileset.frameWidth ?? tile.tileWidth}, ${tileset.frameHeight ?? tile.tileHeight}, ${tileset.margin ?? 0}, ${tileset.spacing ?? 0})!;`,
      );
      L.push(
        `    const ${v} = ${v}Map.createLayer(0, ${v}Tiles, 0, 0, false) as Phaser.Tilemaps.TilemapLayer;`,
      );
      L.push(`    ${v}.setDepth(${depth});`);
      // Named for the same reason objects are: a script looking a layer up by
      // name has to find it in the shipped game too.
      L.push(`    ${v}.setName(${q(tile.name)});`);
      if (!layer.visible) L.push(`    ${v}.setVisible(false);`);
      const collides = tileset.tileCollides ?? [];
      if (collides.length) L.push(`    ${v}.setCollision([${collides.join(", ")}]);`);
      L.push(`    this.tileLayers[${q(tile.name)}] = ${v};`);
      L.push(``);
      return;
    }

    const members = scene.objects.filter((o) => o.layerId === layer.id);
    if (!members.length) return;
    L.push(`    // layer ${depth}: ${layer.name} (objects)`);
    for (const raw of members) {
      const obj = resolveObject(project, raw);
      // A prefab instance is exempt from both guards below. They ask "is there
      // anything to draw", which for a plain sprite means a texture — but a
      // prefab is drawn by its own constructor, and one bound to the project's
      // class may well be a Container with no texture of its own. Dropping
      // those silently emitted a scene missing exactly the objects that had
      // behaviour attached.
      if (!raw.prefab) {
        if (obj.type === "container") continue;
        if (!obj.texture && !obj.text) continue;
      }
      const world = worldTransform(index.get(raw.id) ?? raw, index);
      const v = varName(obj, used);
      varsById.set(obj.id, v);

      if (obj.text) {
        emitText(L, v, obj, world, depth);
        emitScripts(L, v, obj, scriptImports, scriptAliases);
        L.push(`    this.objects[${q(objectKey(obj.name, v))}] = ${v};`);
        continue;
      }

      // A prefab instance is constructed through its own class, so the
      // hand-written behaviour on that class actually runs. Everything the
      // definition owns is applied by the constructor; only what THIS instance
      // overrides is emitted after it.
      const prefab = resolvePrefab(project, raw.prefab);
      if (prefab) {
        usedPrefabClasses.add(prefab.name);
        L.push(
          `    const ${v} = new ${className(prefab.name)}(${constructorArgs(prefab, obj, world)});`,
        );
        L.push(`    ${v}.setName(${q(obj.name)}).setDepth(${depth});`);
        if (prefab.root.body) bodyLines.push(`    ${v}.applyBody();`);
        emitProperties(L, bodyLines, v, obj, prefab.root as unknown as SceneObject, world);
      } else {
        const factory = obj.body ? "this.physics.add.sprite" : "this.add.sprite";
        const frameArg = obj.frame ? `, ${q(obj.frame)}` : "";
        L.push(
          `    const ${v} = ${factory}(${round(world.x)}, ${round(world.y)}, ${q(obj.texture ?? "")}${frameArg});`,
        );
        L.push(`    ${v}.setName(${q(obj.name)}).setDepth(${depth});`);
        emitProperties(L, bodyLines, v, obj, null, world);
      }

      if (obj.sounds?.overlap) {
        L.push(`    ${v}.setData("__sfxOverlap", ${q(obj.sounds.overlap)});`);
      }
      if (obj.sounds?.spawn) {
        L.push(`    this.sound.play(${q(obj.sounds.spawn)});`);
      }

      emitScripts(L, v, obj, scriptImports, scriptAliases);

      if (obj.group && obj.body) {
        let gv = groupVars.get(obj.group);
        if (!gv) {
          gv = `${obj.group.replace(/[^\w]/g, "")}Group`;
          groupVars.set(obj.group, gv);
        }
      }
      L.push(`    this.objects[${q(objectKey(obj.name, v))}] = ${v};`);
    }
    L.push(``);
  });

  // ---- groups + colliders ----
  if (groupVars.size) {
    L.push(`    // collision groups`);
    for (const [group, gv] of groupVars) {
      const members = scene.objects
        .map((o) => resolveObject(project, o))
        .filter((o) => o.group === group && o.body && varsById.has(o.id))
        .map((o) => varsById.get(o.id)!);
      L.push(`    const ${gv} = this.physics.add.group([${members.join(", ")}]);`);
      L.push(`    this.groups[${q(group)}] = ${gv};`);
    }
    L.push(``);
    if (bodyLines.length) {
      L.push(`    // bodies, after their groups: a group applies its own defaults`);
      L.push(`    // to every child it takes, and would overwrite these.`);
      L.push(...bodyLines);
      L.push(``);
    }

    const emitted = new Set<string>();
    const pairLines: string[] = [];
    for (const [a, row] of Object.entries(project.collision ?? {})) {
      for (const [b, rule] of Object.entries(row ?? {})) {
        if (rule === "ignore") continue;
        if (!groupVars.has(a) || !groupVars.has(b)) continue;
        const key = [a, b].sort().join("|");
        if (emitted.has(key)) continue;
        emitted.add(key);
        const fn = rule === "overlap" ? "overlap" : "collider";
        const name = `on${className(a)}${className(b)}`;
        pairHandlers.push({ name, a, b, rule });
        pairLines.push(
          `    this.physics.add.${fn}(${groupVars.get(a)}, ${groupVars.get(b)}, this.${name});`,
        );
      }
    }
    if (pairLines.length) {
      L.push(`    // collision matrix (authored once, in the project)`);
      L.push(...pairLines);
      L.push(``);
    }
    const tileLayerNames = scene.layers.filter((l) => l.kind === "tile");
    if (tileLayerNames.length) {
      for (const layer of tileLayerNames) {
        for (const gv of groupVars.values()) {
          L.push(`    this.physics.add.collider(${gv}, this.tileLayers[${q(layer.name)}]);`);
        }
      }
      L.push(``);
    }
  }

  // ---- animations ----
  const anims = usedAnims(project, scene);
  if (anims.length) {
    L.push(`    // animations`);
    for (const anim of anims) {
      L.push(`    this.anims.create({`);
      L.push(`      key: ${q(anim.key)},`);
      L.push(
        `      frames: [${anim.frames
          .map(
            (f) =>
              `{ key: ${q(f.textureKey)}, frame: ${q(f.frame)}${f.duration ? `, duration: ${f.duration}` : ""} }`,
          )
          .join(", ")}],`,
      );
      L.push(`      frameRate: ${anim.fps},`);
      L.push(`      repeat: ${animRepeat(anim)},`);
      if (anim.yoyo) L.push(`      yoyo: true,`);
      L.push(`    });`);
    }
    // Started here, after anims.create, for plain objects and prefab
    // instances alike.
    for (const raw of scene.objects) {
      const obj = resolveObject(project, raw);
      const v = varsById.get(obj.id);
      if (v && obj.playOnSpawn) L.push(`    ${v}.play(${q(obj.playOnSpawn)});`);
    }
    L.push(``);
  }

  // The camera comes last: a follow target has to exist before it is followed.
  emitCamera(L, scene, varsById, index);
  emitMusic(L, scene);

  L.push(`    // <keep id="create">`);
  L.push(`    // Your own wiring goes here — it survives regeneration.`);
  L.push(`    // </keep>`);

  const hasScripts = sceneHasScripts(project, scene);

  L = handlerBody;
  for (const handler of pairHandlers) {
    L.push(
      `  /** ${handler.a} × ${handler.b} — authored as "${handler.rule}" in the collision matrix. */`,
    );
    // Phaser's own alias, rather than spelled-out parameters: it has widened
    // between versions, and the emitted class has to compile against whichever
    // one the project depends on.
    L.push(`  ${handler.name}: Phaser.Types.Physics.Arcade.ArcadePhysicsCallback = (`);
    L.push(`    ${handler.a},`);
    L.push(`    ${handler.b},`);
    L.push(`  ) => {`);
    L.push(`    // Cues authored on either object. Anything conditional is`);
    L.push(`    // behaviour and belongs below, or in a script.`);
    L.push(`    this.playContactCues(${handler.a}, ${handler.b});`);
    // The scripts on either object hear about it, so behaviour attached to a
    // PREFAB reaches every instance without the scene naming any of them.
    if (hasScripts) {
      L.push(`    this.scripts.contact(${handler.a}, ${handler.b}, ${q(handler.rule)});`);
    }
    L.push(`    // <keep id="${handler.name}">`);
    L.push(`    // </keep>`);
    L.push(`  };`);
    L.push(``);
  }
  if (pairHandlers.length) {
    L.push(`  /** Plays the contact cue either object declared, if it has one. */`);
    L.push(`  private playContactCues(...parts: unknown[]): void {`);
    L.push(`    for (const part of parts) {`);
    L.push(`      const key = (part as Phaser.GameObjects.GameObject)?.getData?.("__sfxOverlap");`);
    L.push(`      if (typeof key === "string" && this.cache.audio.exists(key)) this.sound.play(key);`);
    L.push(`    }`);
    L.push(`  }`);
    L.push(``);
  }
  const fields: string[] = [];
  if (hasScripts) fields.push(`  scripts!: ScriptHost;`);
  // A scene holds sprites and text, so the map says so. Callers reaching for
  // a body still cast — Sprite never had one either.
  fields.push(
    `  objects: Record<string, Phaser.GameObjects.Sprite | Phaser.GameObjects.Text> = {};`,
  );
  fields.push(`  tileLayers: Record<string, Phaser.Tilemaps.TilemapLayer> = {};`);
  fields.push(`  groups: Record<string, Phaser.Physics.Arcade.Group> = {};`);

  const out: string[] =
    mode === "class"
      ? assembleClass(cls, scene, preloadBody, createBody, handlerBody, fields)
      : assembleModule(cls, scene, preloadBody, createBody, handlerBody);

  const imports: string[] = [];
  if (scene.layers.some((l) => l.kind === "tile")) {
    imports.push(`import sceneData from "./${scene.key}.scene.json";`);
  }
  for (const name of [...usedPrefabClasses].sort()) {
    const source = resolvePrefab(project, name)?.source;
    if (source) {
      const spec = relativeModule(`src/scenes/${sceneClassName(scene.key)}.ts`, source.module);
      imports.push(
        source.export === "default"
          ? `import ${className(name)} from "${spec}";`
          : `import { ${source.export} as ${className(name)} } from "${spec}";`,
      );
      continue;
    }
    imports.push(`import { ${className(name)} } from "../prefabs/${className(name)}";`);
  }
  if (scriptImports.size) {
    imports.push(`import { ScriptHost } from "${moduleFor(SCRIPT_BASE_FILE)}";`);
    for (const [key, entry] of [...scriptImports].sort(([a], [b]) => a.localeCompare(b))) {
      const name = key.split("::")[1];
      const binding = entry.alias === name ? name : `${name} as ${entry.alias}`;
      imports.push(`import { ${binding} } from "${entry.module}";`);
    }
  }
  if (!imports.length) return out.join("\n");
  return out.join("\n").replace(
    `import Phaser from "phaser";`,
    [`import Phaser from "phaser";`, ...imports].join("\n"),
  );
}

/** The form Mosaic owns: a Phaser.Scene of its own. */
function assembleClass(
  cls: string,
  scene: SceneData,
  preloadBody: string[],
  createBody: string[],
  handlerBody: string[],
  fields: string[],
): string[] {
  return [
    `// GENERATED by Mosaic from src/scenes/${scene.key}.scene.json`,
    `// Regenerating rewrites this file; code between the keep markers below survives.`,
    `import Phaser from "phaser";`,
    ``,
    `export class ${cls} extends Phaser.Scene {`,
    `  constructor() {`,
    `    super(${q(scene.key)});`,
    `  }`,
    ``,
    `  preload(): void {`,
    ...preloadBody,
    `  }`,
    ``,
    `  create(): void {`,
    ...createBody,
    `  }`,
    ``,
    `  update(_time: number, _delta: number): void {`,
    `    // <keep id="update">`,
    `    // </keep>`,
    `  }`,
    ``,
    ...handlerBody,
    ...fields,
    `}`,
    ``,
  ];
}

/**
 * The form the PROJECT owns: functions its own scene calls.
 *
 * An existing Phaser project already has a scene class, with its own state and
 * its own update loop, and taking that over is not something an editor should
 * do to import a layout. So Mosaic emits what it actually knows — the objects,
 * and the loads they need — and the project's `create()` calls it:
 *
 *     create() {
 *       this.doors = [];
 *       buildMainGame(this);
 *     }
 *
 * The bodies are the same lines the class form emits, `this` and all, so they
 * are invoked with the caller's scene as `this` rather than rewritten. That is
 * also why the maps are attached to that scene: `this.objects` inside a body
 * has to resolve to something, and the caller having them afterwards is the
 * point.
 */
function assembleModule(
  cls: string,
  scene: SceneData,
  preloadBody: string[],
  createBody: string[],
  handlerBody: string[],
): string[] {
  const built = `${cls}Built`;
  const hasHandlers = handlerBody.length > 0;
  // In a class the handlers are fields and the helper a method. Here they are
  // attached to the caller's scene, because the collision lines in the body
  // reach for them as `this.<name>` either way.
  const attached = handlerBody.map((line) =>
    /^  [A-Za-z_$][\w$]*: Phaser\.Types/.test(line)
      ? line.replace(/^  ([A-Za-z_$][\w$]*): Phaser\.Types[^=]*= \(/, "  self.$1 = (")
      : line,
  );

  return [
    `// GENERATED by Mosaic from src/scenes/${scene.key}.scene.json`,
    `// Regenerating rewrites this file. Your scene class is yours — this only`,
    `// builds the objects the editor authored, into a scene you already have.`,
    `import Phaser from "phaser";`,
    ``,
    `export interface ${built} {`,
    `  objects: Record<string, Phaser.GameObjects.Sprite | Phaser.GameObjects.Text>;`,
    `  tileLayers: Record<string, Phaser.Tilemaps.TilemapLayer>;`,
    `  groups: Record<string, Phaser.Physics.Arcade.Group>;`,
    `}`,
    ``,
    `type Host = Phaser.Scene & ${built} & Record<string, unknown>;`,
    ``,
    `/** Queues everything this scene's objects load. Call from your preload(). */`,
    `export function preload${cls}(scene: Phaser.Scene): void {`,
    `  preloadBody.call(scene as Host);`,
    `}`,
    ``,
    `/** Builds the authored objects into your scene. Call from your create(). */`,
    `export function build${cls}(scene: Phaser.Scene): ${built} {`,
    `  const host = scene as Host;`,
    `  host.objects ??= {};`,
    `  host.tileLayers ??= {};`,
    `  host.groups ??= {};`,
    `  buildBody.call(host);`,
    `  return { objects: host.objects, tileLayers: host.tileLayers, groups: host.groups };`,
    `}`,
    ``,
    `function preloadBody(this: Host): void {`,
    ...preloadBody,
    `}`,
    ``,
    `function buildBody(this: Host): void {`,
    ...(hasHandlers ? [`  const self = this;`, ...attached] : []),
    ...createBody,
    `}`,
    ...(hasHandlers
      ? [
          ``,
          `function playContactCues(this: Host, ...parts: unknown[]): void {`,
          `  for (const part of parts) {`,
          `    const key = (part as Phaser.GameObjects.GameObject)?.getData?.("__sfxOverlap");`,
          `    if (typeof key === "string" && this.cache.audio.exists(key)) this.sound.play(key);`,
          `  }`,
          `}`,
        ]
      : []),
    ``,
  ];
}

function sceneHasScripts(project: ProjectData, scene: SceneData): boolean {
  return scene.objects.some((o) => scriptsOf(resolveObject(project, o)).length > 0);
}

/** src/scripts/Foo.ts, as imported from a file in src/scenes/. */
function moduleFor(src: string): string {
  const withoutExt = src.replace(/\.(ts|tsx|js|jsx|mts|mjs)$/, "");
  const parts = withoutExt.split("/");
  const from = ["src", "scenes"];
  let shared = 0;
  while (shared < from.length && parts[shared] === from[shared]) shared++;
  const up = from.length - shared;
  const rel = [...Array(up).fill(".."), ...parts.slice(shared)].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Attaches the object's scripts, in list order.
 *
 * A disabled script is still constructed and still gets its values — the
 * runtime skips create/update — so switching one off in the editor and back on
 * at runtime behaves the way the inspector implies.
 */
function emitScripts(
  L: string[],
  v: string,
  obj: SceneObject,
  imports: Map<string, { alias: string; module: string }>,
  aliases: Set<string>,
): void {
  for (const script of scriptsOf(obj)) {
    const key = `${script.src}::${script.class}`;
    let entry = imports.get(key);
    if (!entry) {
      // Two classes may share a name in different folders; the second one to
      // arrive is imported under an alias rather than shadowing the first.
      let alias = script.class;
      let n = 2;
      while (aliases.has(alias)) alias = `${script.class}${n++}`;
      aliases.add(alias);
      entry = { alias, module: moduleFor(script.src) };
      imports.set(key, entry);
    }
    const props = Object.entries(script.props ?? {});
    const propsArg = props.length
      ? `{ ${props.map(([k, val]) => `${JSON.stringify(k)}: ${JSON.stringify(val)}`).join(", ")} }`
      : "{}";
    const enabledArg = script.enabled ? "" : ", false";
    L.push(`    this.scripts.add(${v}, new ${entry.alias}(), ${propsArg}${enabledArg});`);
  }
}

/**
 * Emits the property calls for one object.
 *
 * With `base` null (a plain object) everything is emitted. With `base` set
 * (a prefab instance, base = the definition) only what DIFFERS is emitted —
 * the constructor already applied the rest, and re-emitting it would bake the
 * definition into the scene and break propagation.
 */
/**
 * Text is CONTENT, so it is emitted from the scene rather than left for
 * create() to build by hand.
 */
function emitText(
  L: string[],
  v: string,
  obj: SceneObject,
  world: { x: number; y: number; rotation: number; scaleX: number; scaleY: number },
  depth: number,
): void {
  const t = obj.text!;
  const style: string[] = [
    `fontFamily: ${q(t.fontFamily)}`,
    `fontSize: ${q(`${t.fontSize}px`)}`,
    `color: ${q(t.color)}`,
    `align: ${q(t.align)}`,
  ];
  if (t.backgroundColor) style.push(`backgroundColor: ${q(t.backgroundColor)}`);
  if (t.wrapWidth > 0) style.push(`wordWrap: { width: ${t.wrapWidth} }`);
  L.push(
    `    const ${v} = this.add.text(${round(world.x)}, ${round(world.y)}, ${q(t.content)}, { ${style.join(", ")} });`,
  );
  L.push(`    ${v}.setName(${q(obj.name)}).setDepth(${depth});`);
  if (t.stroke && t.strokeThickness) {
    L.push(`    ${v}.setStroke(${q(t.stroke)}, ${t.strokeThickness});`);
  }
  if (obj.originX !== 0.5 || obj.originY !== 0.5) {
    L.push(`    ${v}.setOrigin(${obj.originX}, ${obj.originY});`);
  }
  if (world.rotation !== 0) L.push(`    ${v}.setAngle(${round(world.rotation)});`);
  if (world.scaleX !== 1 || world.scaleY !== 1) {
    L.push(`    ${v}.setScale(${round(world.scaleX)}, ${round(world.scaleY)});`);
  }
  // A HUD does not scroll with the level it is drawn over.
  if (t.fixed) L.push(`    ${v}.setScrollFactor(0);`);
  if (!obj.visible) L.push(`    ${v}.setVisible(false);`);
  for (const [k, val] of Object.entries(obj.data ?? {})) {
    L.push(`    ${v}.setData(${q(k)}, ${JSON.stringify(val)});`);
  }
}

/** The camera, from the scene's own settings rather than from hand-written code. */
function emitCamera(
  L: string[],
  scene: SceneData,
  varsById: Map<string, string>,
  index: Map<string, SceneObject>,
): void {
  const def = scene.settings.camera;
  if (!def) return;
  const lines: string[] = [];
  if (def.clampToBounds) {
    lines.push(
      `    this.cameras.main.setBounds(0, 0, ${scene.settings.width}, ${scene.settings.height});`,
    );
  }
  if (def.zoom !== 1) lines.push(`    this.cameras.main.setZoom(${round(def.zoom)});`);
  if (def.deadzoneWidth > 0 || def.deadzoneHeight > 0) {
    lines.push(
      `    this.cameras.main.setDeadzone(${def.deadzoneWidth}, ${def.deadzoneHeight});`,
    );
  }
  if (def.follow) {
    const target = [...index.values()].find((o) => o.name === def.follow);
    const v = target ? varsById.get(target.id) : undefined;
    if (v) {
      lines.push(
        `    this.cameras.main.startFollow(${v}, false, ${round(def.lerpX)}, ${round(def.lerpY)});`,
      );
    } else {
      lines.push(`    // camera follows ${q(def.follow)}, which this scene does not contain`);
    }
  }
  if (!lines.length) return;
  L.push(`    // camera (scene settings)`);
  L.push(...lines);
  L.push(``);
}

function emitMusic(L: string[], scene: SceneData): void {
  const music = scene.settings.music;
  if (!music?.key) return;
  L.push(
    `    this.sound.play(${q(music.key)}, { volume: ${round(music.volume)}, loop: ${music.loop} });`,
  );
  L.push(``);
}

function emitProperties(
  L: string[],
  /**
   * Body lines go here rather than into L. An arcade group applies its own
   * defaults to every child it takes, so a body configured before the object
   * joins its group is silently overwritten — these are emitted after the
   * groups are built.
   */
  bodyOut: string[],
  v: string,
  obj: SceneObject,
  base: SceneObject | null,
  world: { rotation: number; scaleX: number; scaleY: number },
): void {
  const differs = (key: keyof SceneObject) =>
    !base || JSON.stringify(obj[key]) !== JSON.stringify(base[key]);

  // The constructor applies the definition's own scale/rotation; a containing
  // parent's contribution still has to be applied here.
  const baseRotation = base ? base.rotation : 0;
  const baseScaleX = base ? base.scaleX : 1;
  const baseScaleY = base ? base.scaleY : 1;

  if (base ? world.rotation !== baseRotation : world.rotation !== 0) {
    L.push(`    ${v}.setAngle(${round(world.rotation)});`);
  }
  if (world.scaleX !== baseScaleX || world.scaleY !== baseScaleY) {
    L.push(`    ${v}.setScale(${round(world.scaleX)}, ${round(world.scaleY)});`);
  }
  if (base && (differs("texture") || differs("frame"))) {
    L.push(
      `    ${v}.setTexture(${q(obj.texture ?? "")}${obj.frame ? `, ${q(obj.frame)}` : ""});`,
    );
  }
  if (differs("originX") || differs("originY")) {
    if (base || obj.originX !== 0.5 || obj.originY !== 0.5) {
      L.push(`    ${v}.setOrigin(${obj.originX}, ${obj.originY});`);
    }
  }
  if (differs("visible") && !obj.visible) L.push(`    ${v}.setVisible(false);`);
  if (base && differs("visible") && obj.visible) L.push(`    ${v}.setVisible(true);`);

  emitBody(bodyOut, v, obj, base);

  const baseData = (base?.data ?? {}) as Record<string, unknown>;
  for (const [k, val] of Object.entries(obj.data ?? {})) {
    if (base && JSON.stringify(baseData[k]) === JSON.stringify(val)) continue;
    L.push(`    ${v}.setData(${q(k)}, ${JSON.stringify(val)});`);
  }
}

function emitBody(
  L: string[],
  v: string,
  obj: SceneObject,
  base: SceneObject | null,
): void {
  const b = obj.body;
  if (!b) return;
  const bb = base?.body ?? null;
  // A prefab instance whose body matches the definition needs nothing: the
  // class constructor already sized it.
  if (bb && JSON.stringify(b) === JSON.stringify(bb)) return;
  const body = base ? `${v}.body!` : `${v}.body`;

  if (b.shape === "circle") {
    L.push(`    ${body}.setCircle(${b.radius}, ${b.offsetX}, ${b.offsetY});`);
  } else {
    L.push(`    ${body}.setSize(${b.width}, ${b.height}, false);`);
    L.push(`    ${body}.setOffset(${b.offsetX}, ${b.offsetY});`);
  }
  if (b.immovable !== (bb?.immovable ?? false)) {
    L.push(`    ${body}.setImmovable(${b.immovable});`);
  }
  if (b.allowGravity !== (bb?.allowGravity ?? true)) {
    L.push(`    ${body}.setAllowGravity(${b.allowGravity});`);
  }
  if (b.bounce !== (bb?.bounce ?? 0)) {
    L.push(`    ${body}.setBounce(${b.bounce}, ${b.bounce});`);
  }
  const walls = b.collideWorldBounds ?? DEFAULT_COLLIDE_WORLD_BOUNDS;
  if (walls !== (bb ? (bb.collideWorldBounds ?? DEFAULT_COLLIDE_WORLD_BOUNDS) : false)) {
    L.push(`    ${body}.setCollideWorldBounds(${walls});`);
  }
}

/**
 * Every animation the project defines — the same set the runtime loader
 * registers.
 *
 * This used to return only the ones a scene object named in `playOnSpawn`,
 * which quietly dropped any animation played from a script. The play-test
 * registers them all, so the animation ran in the editor and did not exist in
 * the build: `play("hero_walk")` on a key Phaser had never been given.
 *
 * A scene carrying animations it never plays is a cost worth paying for that.
 * Narrowing the set is a feature to design deliberately, not a filter to apply
 * silently, because nothing can tell from the scene file what a script plays.
 */
function usedAnims(project: ProjectData, scene: SceneData) {
  void scene;
  return project.anims.filter((a) => a.frames.length > 0);
}

export function generatePrefabClass(project: ProjectData, name: string): string {
  // Resolved: a variant has no tree of its own, and the class it becomes has
  // to hold the values it actually resolves to.
  const prefab = resolvePrefab(project, name)!;
  const cls = className(name);
  const node = prefab.root;
  const L: string[] = [];
  L.push(`// GENERATED by Mosaic from prefabs/${name}.prefab.json`);
  L.push(`// The definition's properties are re-emitted on save; your methods survive.`);
  L.push(`import Phaser from "phaser";`);
  L.push(``);
  const physical = !!node.body;
  L.push(
    `export class ${cls} extends ${physical ? "Phaser.Physics.Arcade.Sprite" : "Phaser.GameObjects.Sprite"} {`,
  );
  L.push(`  constructor(scene: Phaser.Scene, x: number, y: number) {`);
  L.push(
    `    super(scene, x, y, ${q(node.texture ?? "")}${node.frame ? `, ${q(node.frame)}` : ""});`,
  );
  L.push(`    scene.add.existing(this);`);
  if (physical) L.push(`    scene.physics.add.existing(this);`);
  if (node.originX !== 0.5 || node.originY !== 0.5) {
    L.push(`    this.setOrigin(${node.originX}, ${node.originY});`);
  }
  if (node.scaleX !== 1 || node.scaleY !== 1) {
    L.push(`    this.setScale(${node.scaleX}, ${node.scaleY});`);
  }
  if (node.body) L.push(`    this.applyBody();`);
  for (const [k, v] of Object.entries(node.data ?? {})) {
    L.push(`    this.setData(${q(k)}, ${JSON.stringify(v)});`);
  }
  if (node.playOnSpawn) {
    L.push(``);
    L.push(`    // Plays ${q(node.playOnSpawn)} on spawn — started by the scene, not here:`);
    L.push(`    // create() registers animations after it builds its objects, so a`);
    L.push(`    // play() in this constructor would fire before the key exists.`);
  }
  L.push(`    // <keep id="ctor">`);
  L.push(`    // </keep>`);
  L.push(`  }`);
  L.push(``);
  if (node.body) {
    const b = node.body;
    L.push(`  /**`);
    L.push(`   * The definition's body. Public and idempotent because joining an`);
    L.push(`   * arcade group overwrites a body with the GROUP's defaults, so the`);
    L.push(`   * scene calls this again once the groups exist.`);
    L.push(`   */`);
    L.push(`  applyBody(): this {`);
    // `this.body` on an Arcade.Sprite is Body | StaticBody, and only Body has
    // the setters below. Narrowing once here keeps the emitted class compiling
    // under the strict tsconfig the scaffold writes.
    L.push(`    const body = this.body as Phaser.Physics.Arcade.Body;`);
    if (b.shape === "circle") L.push(`    body.setCircle(${b.radius}, ${b.offsetX}, ${b.offsetY});`);
    else {
      L.push(`    body.setSize(${b.width}, ${b.height}, false);`);
      L.push(`    body.setOffset(${b.offsetX}, ${b.offsetY});`);
    }
    L.push(`    body.setImmovable(${b.immovable});`);
    L.push(`    body.setAllowGravity(${b.allowGravity});`);
    L.push(`    body.setBounce(${b.bounce}, ${b.bounce});`);
    L.push(`    body.setCollideWorldBounds(${b.collideWorldBounds ?? DEFAULT_COLLIDE_WORLD_BOUNDS});`);
    L.push(`    return this;`);
    L.push(`  }`);
    L.push(``);
  }
  L.push(`  // Exposed on instances: ${prefab.exposed.join(", ") || "(nothing)"}`);
  L.push(`  // <keep id="body">`);
  L.push(`  // </keep>`);
  L.push(`}`);
  L.push(``);
  return L.join("\n");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}


/**
 * The argument list for a prefab's constructor.
 *
 * A prefab Mosaic generates takes `(scene, x, y)`, because Mosaic wrote it. One
 * bound to the project's own class takes whatever that class declares, so the
 * call is built from the recorded parameter names rather than assumed — passing
 * a scene where a name was wanted is the kind of bug that compiles.
 */
function constructorArgs(
  prefab: { name: string; source?: PrefabSource },
  obj: SceneObject,
  world: { x: number; y: number },
): string {
  const plan = prefab.source ? bindArgs(prefab.source.params) : null;
  if (!plan) return `this, ${round(world.x)}, ${round(world.y)}`;
  return plan
    .map((arg) => {
      switch (arg.kind) {
        case "scene":
          return "this";
        case "x":
          return String(round(world.x));
        case "y":
          return String(round(world.y));
        case "name":
          return q(obj.name);
        case "texture":
          return q(obj.texture ?? "");
        case "frame":
          return q(obj.frame ?? "");
      }
    })
    .join(", ");
}

/** An import specifier from one project-relative file to another. */
function relativeModule(fromFile: string, toModule: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toModule.split("/");
  while (from.length && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const up = from.map(() => "..");
  const spec = [...up, ...to].join("/");
  return spec.startsWith(".") ? spec : `./${spec}`;
}
