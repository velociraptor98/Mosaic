import { collectLoaderManifest } from "../../shared/manifest";
import { SCRIPT_BASE_FILE, scriptsOf } from "../../shared/scripts";
import { COLLIDES_PROPERTY } from "../../shared/tiled";
import { findPrefab, resolveObject, resolvePrefab, resolvedIndex } from "../../shared/prefabs";
import { DEFAULT_COLLIDE_WORLD_BOUNDS } from "../../shared/size";
import { worldTransform } from "../../shared/transform";
import {
  animRepeat,
  boundsAreClosed,
  type AssetDef,
  type BodyDef,
  type ProjectData,
  type SceneData,
  type SceneObject,
  type TileLayer,
} from "../../shared/types";
import { bindArgs } from "../../shared/prefabBinding";
import type { PrefabSource } from "../../shared/types";

/**
 * Layout beside code.
 *
 * A Phaser developer owns their scene classes. So Mosaic writes two kinds of
 * file, and the difference between them is the whole contract:
 *
 * - `*.layout.ts` is GENERATED. It holds what the editor authored — which
 *   objects exist, where they are, what they load — and is rewritten on every
 *   save. Nobody edits it, so it never has to be merged with anything.
 * - Everything else is YOURS. The scene class and the prefab class are written
 *   once, as a starting point, when they do not exist. After that Mosaic does
 *   not open them again, for any reason.
 *
 * The two meet through an import: your `create()` calls `createLevel_01(this)`
 * and gets back the objects, typed, by name.
 *
 * What the layout does NOT do is decide how the game behaves. It places
 * things, sizes their bodies and sorts them into groups; what collides with
 * what is a line of your own code, written against what it hands back.
 */

export type Language = "ts" | "js";

export interface GeneratedFile {
  path: string;
  contents: string;
  language: "json" | "ts" | "js";
  /**
   * `generated` is rewritten on every save. `yours` is written only when the
   * file does not exist yet.
   */
  owner: "generated" | "yours";
}

export interface CodegenOptions {
  language?: Language;
  /**
   * The `@property` fields a class currently declares, or null when the class
   * cannot be found. Lets the layout skip a value whose field was deleted from
   * the source, rather than assign to a property that no longer exists and
   * break the build over stale editor data.
   */
  declared?: (src: string, className: string) => Set<string> | null;
}

export const sceneLayoutPath = (key: string, lang: Language = "ts") =>
  `src/scenes/${className(key)}.layout.${lang}`;
export const sceneClassPath = (key: string, lang: Language = "ts") =>
  `src/scenes/${className(key)}.${lang}`;
export const prefabLayoutPath = (name: string, lang: Language = "ts") =>
  `src/prefabs/${className(name)}.layout.${lang}`;
export const prefabClassPath = (name: string, lang: Language = "ts") =>
  `src/prefabs/${className(name)}.${lang}`;

/** True for a path Mosaic regenerates, so the UI can say so. */
export function isGeneratedPath(rel: string): boolean {
  return /\.layout\.(ts|js)$/.test(rel) || /\.atlas\.json$/.test(rel);
}

/**
 * Every code file the project implies: a layout and a class per scene, a
 * layout and a class per prefab Mosaic generates, and a sidecar per sliced
 * atlas. Pure — the same project in produces the same bytes out.
 */
export function generateProjectFiles(
  project: ProjectData,
  opts: CodegenOptions = {},
): GeneratedFile[] {
  const lang = opts.language ?? "ts";
  const files: GeneratedFile[] = [];

  for (const scene of project.scenes) {
    files.push({
      path: sceneLayoutPath(scene.key, lang),
      contents: generateSceneLayout(project, scene, opts),
      language: lang,
      owner: "generated",
    });
    files.push({
      path: sceneClassPath(scene.key, lang),
      contents: generateSceneClass(scene, lang),
      language: lang,
      owner: "yours",
    });
  }

  for (const prefab of project.prefabs) {
    // A prefab bound to the project's own class has nothing to generate:
    // writing a lookalike beside it would be a second definition of the same
    // thing, and the wrong one would win.
    if (!hasGeneratedClass(project, prefab.name)) continue;
    files.push({
      path: prefabLayoutPath(prefab.name, lang),
      contents: generatePrefabLayout(project, prefab.name, lang),
      language: lang,
      owner: "generated",
    });
    files.push({
      path: prefabClassPath(prefab.name, lang),
      contents: generatePrefabClass(prefab.name, lang),
      language: lang,
      owner: "yours",
    });
  }

  // An atlas is two files, and `load.atlas(key, png, json)` names both. One
  // sliced in the editor has no document of its own, so it is written here
  // from the frames the project already holds.
  for (const asset of project.assets) {
    if (asset.kind !== "atlas" || !asset.frames?.length || asset.generated) continue;
    files.push({
      path: atlasJsonPath(asset),
      contents: atlasSidecar(asset),
      language: "json",
      owner: "generated",
    });
  }

  return files;
}

/** The files that concern one scene: its own pair, and the prefabs it places. */
export function generateSceneFiles(
  project: ProjectData,
  scene: SceneData,
  opts: CodegenOptions = {},
): GeneratedFile[] {
  const lang = opts.language ?? "ts";
  const wanted = new Set<string>([sceneLayoutPath(scene.key, lang), sceneClassPath(scene.key, lang)]);
  for (const name of usedPrefabs(project, scene)) {
    wanted.add(prefabLayoutPath(name, lang));
    wanted.add(prefabClassPath(name, lang));
  }
  const atlases = new Set(
    collectLoaderManifest(project, scene)
      .filter((e) => e.type === "atlas")
      .map((e) => e.key),
  );
  for (const asset of project.assets) if (atlases.has(asset.key)) wanted.add(atlasJsonPath(asset));
  return generateProjectFiles(project, opts).filter((f) => wanted.has(f.path));
}

function atlasJsonPath(asset: AssetDef): string {
  return asset.path.replace(/\.\w+$/, ".atlas.json");
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

/** Prefabs a scene places, base-first so a variant's parent is listed too. */
function usedPrefabs(project: ProjectData, scene: SceneData): string[] {
  const names = new Set<string>();
  for (const obj of scene.objects) {
    if (!obj.prefab) continue;
    for (const link of resolvePrefab(project, obj.prefab)?.chain ?? []) names.add(link);
  }
  return [...names].filter((n) => project.prefabs.some((p) => p.name === n)).sort();
}

/** False for a prefab backed by a class the project wrote itself. */
function hasGeneratedClass(project: ProjectData, name: string): boolean {
  const resolved = resolvePrefab(project, name);
  return !!resolved && !resolved.source;
}

export function className(key: string): string {
  const cleaned = key.replace(/[^\w]+/g, "_").replace(/^(\d)/, "_$1");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * camelCase's first step, with acronyms in mind: "Player" -> "player", but
 * "HUD" -> "hud" and "HUDText" -> "hudText", not "hUD".
 */
function lowerFirst(s: string): string {
  const run = /^[A-Z]+/.exec(s)?.[0] ?? "";
  if (run.length <= 1) return s.charAt(0).toLowerCase() + s.slice(1);
  // The last capital of a run starts the next word when a lowercase follows.
  const keep = run.length < s.length && /[a-z]/.test(s[run.length]) ? 1 : 0;
  return s.slice(0, run.length - keep).toLowerCase() + s.slice(run.length - keep);
}

function q(value: string): string {
  return JSON.stringify(value);
}

/** Names a generated function body may not take for one of its own locals. */
const RESERVED = new Set([
  // the function's own vocabulary
  "scene", "scripts", "groups", "maps", "Phaser", "ScriptHost", "joinGroup",
  // the language's
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
  "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static", "await", "async",
  "implements", "interface", "package", "private", "protected", "public", "arguments", "eval",
  "undefined", "window", "document",
]);

function identifier(name: string, used: Set<string>): string {
  let base = name.replace(/[^\w]+/g, "_").replace(/^(\d)/, "_$1");
  if (!base) base = "obj";
  base = lowerFirst(base);
  let out = base;
  let n = 2;
  while (used.has(out) || RESERVED.has(out)) out = `${base}${n++}`;
  used.add(out);
  return out;
}

// ---------------------------------------------------------------------------
// Scene layout — generated
// ---------------------------------------------------------------------------

interface Transform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

interface Field {
  name: string;
  type: string;
  doc: string;
}

/**
 * Emit order: loads -> world -> layers bottom-up -> groups -> bodies ->
 * animations -> camera -> music. Bodies come after groups because an arcade
 * group applies its own defaults to every child it takes; animations are
 * started after they are registered; the camera follows last because its
 * target has to exist.
 */
export function generateSceneLayout(
  project: ProjectData,
  scene: SceneData,
  opts: CodegenOptions = {},
): string {
  const lang = opts.language ?? "ts";
  const ts = lang === "ts";
  const cls = className(scene.key);
  const manifest = collectLoaderManifest(project, scene);
  // Resolved, so an instance composes its definition's transform, not the
  // stale copy stored on it.
  const index = resolvedIndex(project, scene);

  const used = new Set<string>();
  const varsById = new Map<string, string>();
  const groupVars = new Map<string, string>();
  /** One Phaser tilemap per Tiled map the scene uses, however many layers it places. */
  const mapVars = new Map<string, string>();
  const fields: Field[] = [];
  /** Body configuration, held back until every group exists. */
  const bodyLines: string[] = [];
  const usedPrefabClasses = new Set<string>();
  /** Script classes this scene constructs, keyed by src::class. */
  const scriptImports = new Map<string, { alias: string; module: string }>();
  /**
   * Module-scope identifiers already spoken for, so a script imported later
   * takes an alias instead of shadowing one. Seeded with the prefab class
   * names: a `Brick` prefab whose behaviour is a `Brick` script is the obvious
   * way to name that object, and two imports of one name do not compile.
   */
  const moduleNames = new Set<string>([
    "Phaser",
    "ScriptHost",
    "joinGroup",
    `${cls}Layout`,
    `preload${cls}`,
    `create${cls}`,
    ...usedPrefabs(project, scene).map(className),
  ]);

  const hasScripts = scene.objects.some((o) => scriptsOf(resolveObject(project, o)).length > 0);
  // ---- preload ----
  const P: string[] = [];
  if (!manifest.length) P.push(`  // No assets referenced by this scene.`);
  for (const entry of manifest) {
    const asset = project.assets.find((a) => a.key === entry.key);
    const path = asset?.path ?? `assets/${entry.key}.png`;
    if (entry.type === "spritesheet") {
      const fc = entry.frameConfig!;
      P.push(
        `  scene.load.spritesheet(${q(entry.key)}, ${q(path)}, { frameWidth: ${fc.frameWidth}, frameHeight: ${fc.frameHeight}, margin: ${fc.margin}, spacing: ${fc.spacing} });`,
      );
    } else if (entry.type === "atlas") {
      P.push(`  scene.load.atlas(${q(entry.key)}, ${q(path)}, ${q(path.replace(/\.\w+$/, ".atlas.json"))});`);
    } else if (entry.type === "audio") {
      P.push(`  scene.load.audio(${q(entry.key)}, ${q(path)});`);
    } else if (entry.type === "tilemap") {
      P.push(`  scene.load.tilemapTiledJSON(${q(entry.key)}, ${q(path)});`);
    } else {
      const note = asset?.generated ? "  // editor placeholder — replace with real art" : "";
      P.push(`  scene.load.image(${q(entry.key)}, ${q(path)});${note}`);
    }
  }

  // ---- create ----
  const L: string[] = [];
  if (scene.settings.backgroundColor) {
    L.push(`  scene.cameras.main.setBackgroundColor(${q(scene.settings.backgroundColor)});`);
  }
  L.push(`  scene.physics.world.setBounds(0, 0, ${scene.settings.width}, ${scene.settings.height});`);
  // Only when a side is actually open: every closed rectangle is Arcade's own
  // default, and emitting it would be a line that says nothing.
  if (!boundsAreClosed(scene.settings.bounds)) {
    const b = scene.settings.bounds!;
    L.push(`  scene.physics.world.setBoundsCollision(${b.left}, ${b.right}, ${b.top}, ${b.bottom});`);
  }
  if (scene.settings.gravityY) {
    L.push(`  scene.physics.world.gravity.y = ${scene.settings.gravityY};`);
  }
  if (hasScripts) {
    // One host per scene owns the update loop, so scripts run in the order
    // this file attaches them — which is the order the editor's list shows.
    L.push(`  const scripts = new ScriptHost(scene);`);
  }
  L.push(``);

  scene.layers.forEach((layer, depth) => {
    if (layer.kind === "tile") {
      const tile = layer as TileLayer;
      const asset = project.assets.find((a) => a.kind === "tilemap" && a.key === tile.map);
      const info = asset?.tilemap;
      // A layer whose map has gone, or was renamed out from under it in Tiled,
      // is skipped rather than emitted as a call that throws at run time. The
      // editor says so where the layer is listed.
      if (!info || !info.layers.includes(tile.layer)) return;

      let mv = mapVars.get(tile.map);
      if (!mv) {
        mv = identifier(`${tile.map}Map`, used);
        used.add(`${mv}Tiles`);
        mapVars.set(tile.map, mv);
        L.push(`  // ${asset.path} — authored in Tiled`);
        L.push(`  const ${mv} = scene.make.tilemap({ key: ${q(tile.map)} });`);
        const sets = info.tilesets.filter((t) => t.image);
        L.push(`  const ${mv}Tiles = [`);
        for (const set of sets) {
          L.push(`    ${mv}.addTilesetImage(${q(set.name)}, ${q(set.image!)})${ts ? "!" : ""},`);
        }
        L.push(`  ];`);
      }

      const v = identifier(tile.name, used);
      fields.push({
        name: v,
        type: "Phaser.Tilemaps.TilemapLayer",
        doc: `Tile layer "${tile.layer}" of ${asset.path}.`,
      });
      L.push(`  // layer ${depth}: ${tile.name} (tiles)`);
      L.push(
        `  const ${v} = ${mv}.createLayer(${q(tile.layer)}, ${mv}Tiles, 0, 0)${ts ? " as Phaser.Tilemaps.TilemapLayer" : ""};`,
      );
      L.push(`  ${v}.setDepth(${depth});`);
      // Named, so a lookup by name finds it in the running game too.
      L.push(`  ${v}.setName(${q(tile.name)});`);
      if (!layer.visible) L.push(`  ${v}.setVisible(false);`);
      // Which tiles are solid is said in Tiled, on the tile. Nothing collides
      // with the layer until your code adds a collider for it.
      if (info.collides) L.push(`  ${v}.setCollisionByProperty({ ${COLLIDES_PROPERTY}: true });`);
      L.push(``);
      return;
    }

    const members = scene.objects.filter((o) => o.layerId === layer.id);
    if (!members.length) return;
    L.push(`  // layer ${depth}: ${layer.name} (objects)`);
    for (const raw of members) {
      const obj = resolveObject(project, raw);
      // A prefab instance is exempt from both guards below. They ask "is there
      // anything to draw", which for a plain sprite means a texture — but a
      // prefab is drawn by its own constructor, and one bound to the project's
      // class may well be a Container with no texture of its own.
      if (!raw.prefab) {
        if (obj.type === "container") continue;
        if (!obj.texture && !obj.text) continue;
      }
      const world: Transform = worldTransform(index.get(raw.id) ?? raw, index);
      const v = identifier(obj.name, used);
      varsById.set(obj.id, v);

      if (obj.text) {
        emitText(L, v, obj, world, depth);
        fields.push({ name: v, type: "Phaser.GameObjects.Text", doc: `"${obj.name}"` });
        emitScripts(L, v, obj, scriptImports, moduleNames, opts);
        continue;
      }

      // A prefab instance is constructed through its own class, so the
      // behaviour written on that class actually runs. Everything the
      // definition owns is applied by the constructor; only what THIS instance
      // overrides is emitted after it.
      const prefab = resolvePrefab(project, raw.prefab);
      if (prefab) {
        usedPrefabClasses.add(prefab.name);
        const pcls = className(prefab.name);
        L.push(`  const ${v} = new ${pcls}(${constructorArgs(prefab, obj, world)});`);
        L.push(`  ${v}.setName(${q(obj.name)}).setDepth(${depth});`);
        if (prefab.root.body && !prefab.source) bodyLines.push(`  ${v}.applyBody();`);
        emitProperties(L, bodyLines, v, obj, prefab.root as unknown as SceneObject, world, ts);
        emitClassProps(L, v, obj, prefab, opts);
        fields.push({ name: v, type: pcls, doc: `"${obj.name}" — an instance of the ${prefab.name} prefab.` });
      } else {
        const factory = obj.body ? "scene.physics.add.sprite" : "scene.add.sprite";
        const frameArg = obj.frame ? `, ${q(obj.frame)}` : "";
        L.push(
          `  const ${v} = ${factory}(${round(world.x)}, ${round(world.y)}, ${q(obj.texture ?? "")}${frameArg});`,
        );
        L.push(`  ${v}.setName(${q(obj.name)}).setDepth(${depth});`);
        emitProperties(L, bodyLines, v, obj, null, world, ts);
        fields.push({
          name: v,
          type: obj.body
            ? "Phaser.Types.Physics.Arcade.SpriteWithDynamicBody"
            : "Phaser.GameObjects.Sprite",
          doc: `"${obj.name}"`,
        });
      }

      if (obj.sounds?.spawn) L.push(`  scene.sound.play(${q(obj.sounds.spawn)});`);

      emitScripts(L, v, obj, scriptImports, moduleNames, opts);
    }
    L.push(``);
  });

  // Every group the project defines, not only the ones this scene places
  // something in: a group is how code says "every bullet", and the bullets may
  // all be made by code. Project order first, then any tag an object still
  // carries for a group that has since been removed from the project.
  const groupNames = [...project.groups];
  for (const raw of scene.objects) {
    const g = resolveObject(project, raw).group;
    if (g && !groupNames.includes(g)) groupNames.push(g);
  }
  // Group locals are named after every object has taken its name, so a group
  // can never push an object off the identifier the author gave it.
  for (const group of groupNames) {
    groupVars.set(group, identifier(`${group.replace(/[^\w]/g, "")}Group`, used));
  }

  // ---- groups ----
  // Membership only. A group is how the scene's code names "every brick"; what
  // happens when the ball meets one is that code's to say.
  if (groupVars.size) {
    const depthOf = new Map(scene.layers.map((l, i) => [l.id, i] as const));
    const firstObjectLayer = scene.layers.findIndex((l) => l.kind !== "tile");
    L.push(`  // groups — an object your code adds later gets its authored body back`);
    L.push(`  // (a group resets bodies to its own defaults) and, if it has no depth yet,`);
    L.push(`  // the depth of the layer this group's objects were placed on.`);
    for (const [group, gv] of groupVars) {
      const placed = scene.objects
        .map((raw) => ({ raw, obj: resolveObject(project, raw) }))
        .filter(({ obj }) => obj.group === group && obj.body && varsById.has(obj.id));
      const members = placed.map(({ obj }) => varsById.get(obj.id)!);
      const depth = homeDepth(placed.map(({ raw }) => depthOf.get(raw.layerId) ?? -1), firstObjectLayer);
      L.push(`  const ${gv} = scene.physics.add.group(${members.length ? `[${members.join(", ")}]` : ""});`);
      L.push(`  ${gv}.createCallback = joinGroup(${depth >= 0 ? depth : ""});`);
    }
    L.push(``);
    if (bodyLines.length) {
      L.push(`  // bodies, after their groups: a group applies its own defaults`);
      L.push(`  // to every child it takes, and would overwrite these.`);
      L.push(...bodyLines);
      L.push(``);
    }
  } else if (bodyLines.length) {
    L.push(...bodyLines);
    L.push(``);
  }

  // ---- animations ----
  // Every animation the project defines, not only the ones an object names on
  // spawn: nothing in a scene file can say what your code plays, and an
  // animation that is merely absent fails at the moment it is asked for.
  const anims = project.anims.filter((a) => a.frames.length > 0);
  if (anims.length) {
    L.push(`  // animations — global in Phaser, so a second scene finds them already there`);
    for (const anim of anims) {
      L.push(`  if (!scene.anims.exists(${q(anim.key)})) {`);
      L.push(`    scene.anims.create({`);
      L.push(`      key: ${q(anim.key)},`);
      L.push(
        `      frames: [${anim.frames
          .map(
            (f) =>
              `{ key: ${q(f.textureKey)}, frame: ${frameLiteral(f.frame)}${f.duration ? `, duration: ${f.duration}` : ""} }`,
          )
          .join(", ")}],`,
      );
      L.push(`      frameRate: ${anim.fps},`);
      L.push(`      repeat: ${animRepeat(anim)},`);
      if (anim.yoyo) L.push(`      yoyo: true,`);
      L.push(`    });`);
      L.push(`  }`);
    }
    for (const raw of scene.objects) {
      const obj = resolveObject(project, raw);
      const v = varsById.get(obj.id);
      if (v && obj.playOnSpawn) L.push(`  ${v}.play(${q(obj.playOnSpawn)});`);
    }
    L.push(``);
  }

  emitCamera(L, scene, varsById, index);
  emitMusic(L, scene);

  // ---- what create hands back ----
  const groupEntries = [...groupVars].map(([group, gv]) => ({ key: propertyKey(group), gv, group }));
  const returned = [
    ...fields.map((f) => f.name),
    groupEntries.length
      ? `groups: { ${groupEntries.map((g) => (g.key === g.gv ? g.gv : `${g.key}: ${g.gv}`)).join(", ")} }`
      : `groups: {}`,
    ...(mapVars.size
      ? [`maps: { ${[...mapVars].map(([key, mv]) => `${propertyKey(key)}: ${mv}`).join(", ")} }`]
      : []),
    ...(hasScripts ? ["scripts"] : []),
  ];
  L.push(`  return {`);
  for (const line of returned) L.push(`    ${line},`);
  L.push(`  };`);

  // ---- assemble ----
  const out: string[] = [];
  out.push(`// GENERATED by Mosaic from src/scenes/${scene.key}.scene.json — do not edit.`);
  out.push(`//`);
  out.push(`// Every save in the editor rewrites this file. Your code lives in`);
  out.push(`// ./${cls}.${lang}, which Mosaic wrote once and will not touch again.`);
  out.push(`import Phaser from "phaser";`);
  const layoutFile = sceneLayoutPath(scene.key, lang);
  for (const name of [...usedPrefabClasses].sort()) {
    const source = resolvePrefab(project, name)?.source;
    if (source) {
      const spec = relativeModule(layoutFile, source.module);
      out.push(
        source.export === "default"
          ? `import ${className(name)} from "${spec}";`
          : source.export === className(name)
            ? `import { ${source.export} } from "${spec}";`
            : `import { ${source.export} as ${className(name)} } from "${spec}";`,
      );
      continue;
    }
    out.push(`import { ${className(name)} } from "../prefabs/${className(name)}${ts ? "" : ".js"}";`);
  }
  if (hasScripts) {
    out.push(`import { ScriptHost } from "${relativeModule(layoutFile, SCRIPT_BASE_FILE)}";`);
    for (const [key, entry] of [...scriptImports].sort(([a], [b]) => a.localeCompare(b))) {
      const name = key.split("::")[1];
      const binding = entry.alias === name ? name : `${name} as ${entry.alias}`;
      out.push(`import { ${binding} } from "${entry.module}";`);
    }
  }
  out.push(``);

  if (ts) {
    out.push(`/** Everything the editor placed in ${scene.key}, by name. */`);
    out.push(`export interface ${cls}Layout {`);
    for (const field of fields) {
      out.push(`  /** ${field.doc.replace(/\*\//g, "*\\/")} */`);
      out.push(`  ${field.name}: ${field.type};`);
    }
    out.push(`  /** Every group the project defines, built even when this scene places nothing in it. */`);
    out.push(
      groupEntries.length
        ? `  groups: { ${groupEntries.map((g) => `${g.key}: Phaser.Physics.Arcade.Group`).join("; ")} };`
        : `  groups: {};`,
    );
    if (mapVars.size) {
      out.push(`  /** The Tiled maps themselves — for object layers, tile lookups and the rest. */`);
      out.push(
        `  maps: { ${[...mapVars.keys()].map((key) => `${propertyKey(key)}: Phaser.Tilemaps.Tilemap`).join("; ")} };`,
      );
    }
    if (hasScripts) {
      out.push(`  /** Runs the script components attached in the editor. */`);
      out.push(`  scripts: ScriptHost;`);
    }
    out.push(`}`);
    out.push(``);
  }

  out.push(`/** Queues everything this scene's objects load. Call from preload(). */`);
  out.push(`export function preload${cls}(scene${ts ? ": Phaser.Scene" : ""})${ts ? ": void" : ""} {`);
  out.push(...P);
  out.push(`}`);
  out.push(``);
  out.push(`/** Builds the scene as authored and hands the objects back. Call from create(). */`);
  out.push(
    ts
      ? `export function create${cls}(scene: Phaser.Scene): ${cls}Layout {`
      : `export function create${cls}(scene) {`,
  );
  out.push(...L);
  out.push(`}`);

  if (groupVars.size) {
    out.push(``);
    out.push(...JOIN_GROUP[lang]);
  }

  out.push(``);
  return out.join("\n");
}

/**
 * The depth an object added to a group at run time is drawn at: the object
 * layer most of the group's placed members sit on (the lower on a tie), or,
 * when the scene places none, the scene's first object layer. -1 when the
 * scene has no object layer at all, and depth is then left alone.
 */
function homeDepth(memberDepths: number[], firstObjectLayer: number): number {
  const counts = new Map<number, number>();
  for (const d of memberDepths) if (d >= 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = -1;
  let most = 0;
  for (const [d, n] of counts) {
    if (n > most || (n === most && d < best)) [best, most] = [d, n];
  }
  return best >= 0 ? best : firstObjectLayer;
}

/**
 * Installed as each group's createCallback once the layout's own members are
 * in, so it runs only for what the game's code adds afterwards. Arcade resets
 * the body of anything a group takes to the group's defaults — gravity on,
 * world-bounds collision off, immovable off, bounce 0. The shape survives;
 * the settings do not — which silently undid the body
 * the editor authored; `applyBody()` puts it back. A depth is given only to an
 * object still at 0, the depth nothing has set: one the code placed itself is
 * left where it was put.
 */
const JOIN_GROUP: Record<"ts" | "js", string[]> = {
  ts: [
    `/** What a group does with an object added to it after the layout ran. */`,
    `function joinGroup(depth?: number): Phaser.Types.GameObjects.Group.GroupCallback {`,
    `  return (child) => {`,
    `    const made = child as Phaser.GameObjects.GameObject & {`,
    `      applyBody?: () => unknown;`,
    `      depth?: number;`,
    `      setDepth?: (value: number) => unknown;`,
    `    };`,
    `    made.applyBody?.();`,
    `    if (depth !== undefined && made.depth === 0) made.setDepth?.(depth);`,
    `  };`,
    `}`,
  ],
  js: [
    `/** What a group does with an object added to it after the layout ran. */`,
    `function joinGroup(depth) {`,
    `  return (child) => {`,
    `    child.applyBody?.();`,
    `    if (depth !== undefined && child.depth === 0) child.setDepth?.(depth);`,
    `  };`,
    `}`,
  ],
};

/** A spritesheet frame is a number to Phaser; an atlas frame is a name. */
function frameLiteral(frame: string): string {
  return /^\d+$/.test(frame) ? frame : q(frame);
}

function propertyKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : q(name);
}

/**
 * Attaches the object's script components, in list order.
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
  opts: CodegenOptions,
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
      entry = { alias, module: relativeModule("src/scenes/x.ts", script.src) };
      imports.set(key, entry);
    }
    const declared = opts.declared?.(script.src, script.class) ?? null;
    const props = Object.entries(script.props ?? {}).filter(([k]) => !declared || declared.has(k));
    const propsArg = props.length
      ? `{ ${props.map(([k, val]) => `${propertyKey(k)}: ${JSON.stringify(val)}`).join(", ")} }`
      : "{}";
    const enabledArg = script.enabled ? "" : ", false";
    L.push(`  scripts.add(${v}, new ${entry.alias}(), ${propsArg}${enabledArg});`);
  }
}

/**
 * Values for the `@property` fields a prefab's own class declares.
 *
 * This is behaviour without a component: the class is an ordinary
 * `Phaser.GameObjects.Sprite` subclass, the field is an ordinary field, and
 * the editor sets it the way your own code would.
 */
function emitClassProps(
  L: string[],
  v: string,
  obj: SceneObject,
  prefab: { name: string; source?: PrefabSource },
  opts: CodegenOptions,
): void {
  const where = prefab.source
    ? { src: prefab.source.module, cls: prefab.source.export === "default" ? prefab.name : prefab.source.export }
    : { src: prefabClassPath(prefab.name, opts.language ?? "ts"), cls: className(prefab.name) };
  const declared = opts.declared?.(where.src, where.cls) ?? null;
  // `obj` is resolved, so these are the definition's defaults with the
  // instance's own values over them.
  for (const [key, value] of Object.entries(obj.props ?? {})) {
    if (declared && !declared.has(key)) continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
    L.push(`  ${v}.${key} = ${JSON.stringify(value)};`);
  }
}

/** Text is CONTENT, so it is built here rather than left for create() to write by hand. */
function emitText(L: string[], v: string, obj: SceneObject, world: Transform, depth: number): void {
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
    `  const ${v} = scene.add.text(${round(world.x)}, ${round(world.y)}, ${q(t.content)}, { ${style.join(", ")} });`,
  );
  L.push(`  ${v}.setName(${q(obj.name)}).setDepth(${depth});`);
  if (t.stroke && t.strokeThickness) L.push(`  ${v}.setStroke(${q(t.stroke)}, ${t.strokeThickness});`);
  if (obj.originX !== 0.5 || obj.originY !== 0.5) {
    L.push(`  ${v}.setOrigin(${obj.originX}, ${obj.originY});`);
  }
  if (world.rotation !== 0) L.push(`  ${v}.setAngle(${round(world.rotation)});`);
  if (world.scaleX !== 1 || world.scaleY !== 1) {
    L.push(`  ${v}.setScale(${round(world.scaleX)}, ${round(world.scaleY)});`);
  }
  // A HUD does not scroll with the level it is drawn over.
  if (t.fixed) L.push(`  ${v}.setScrollFactor(0);`);
  if (!obj.visible) L.push(`  ${v}.setVisible(false);`);
  for (const [k, val] of Object.entries(obj.data ?? {})) {
    L.push(`  ${v}.setData(${q(k)}, ${JSON.stringify(val)});`);
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
    lines.push(`  scene.cameras.main.setBounds(0, 0, ${scene.settings.width}, ${scene.settings.height});`);
  }
  if (def.zoom !== 1) lines.push(`  scene.cameras.main.setZoom(${round(def.zoom)});`);
  if (def.deadzoneWidth > 0 || def.deadzoneHeight > 0) {
    lines.push(`  scene.cameras.main.setDeadzone(${def.deadzoneWidth}, ${def.deadzoneHeight});`);
  }
  if (def.follow) {
    const target = [...index.values()].find((o) => o.name === def.follow);
    const v = target ? varsById.get(target.id) : undefined;
    if (v) {
      lines.push(
        `  scene.cameras.main.startFollow(${v}, false, ${round(def.lerpX)}, ${round(def.lerpY)});`,
      );
    } else {
      lines.push(`  // camera follows ${q(def.follow)}, which this scene does not contain`);
    }
  }
  if (!lines.length) return;
  L.push(`  // camera (scene settings)`);
  L.push(...lines);
  L.push(``);
}

function emitMusic(L: string[], scene: SceneData): void {
  const music = scene.settings.music;
  if (!music?.key) return;
  L.push(`  scene.sound.play(${q(music.key)}, { volume: ${round(music.volume)}, loop: ${music.loop} });`);
  L.push(``);
}

/**
 * Emits the property calls for one object.
 *
 * With `base` null (a plain object) everything is emitted. With `base` set
 * (a prefab instance, base = the definition) only what DIFFERS is emitted —
 * the constructor already applied the rest, and re-emitting it would bake the
 * definition into the scene and break propagation.
 */
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
  world: Transform,
  ts: boolean,
): void {
  const differs = (key: keyof SceneObject) =>
    !base || JSON.stringify(obj[key]) !== JSON.stringify(base[key]);

  // The constructor applies the definition's own scale/rotation; a containing
  // parent's contribution still has to be applied here.
  const baseRotation = base ? base.rotation : 0;
  const baseScaleX = base ? base.scaleX : 1;
  const baseScaleY = base ? base.scaleY : 1;

  if (base ? world.rotation !== baseRotation : world.rotation !== 0) {
    L.push(`  ${v}.setAngle(${round(world.rotation)});`);
  }
  if (world.scaleX !== baseScaleX || world.scaleY !== baseScaleY) {
    L.push(`  ${v}.setScale(${round(world.scaleX)}, ${round(world.scaleY)});`);
  }
  if (base && (differs("texture") || differs("frame"))) {
    L.push(`  ${v}.setTexture(${q(obj.texture ?? "")}${obj.frame ? `, ${q(obj.frame)}` : ""});`);
  }
  if (differs("originX") || differs("originY")) {
    if (base || obj.originX !== 0.5 || obj.originY !== 0.5) {
      L.push(`  ${v}.setOrigin(${obj.originX}, ${obj.originY});`);
    }
  }
  if (differs("visible") && !obj.visible) L.push(`  ${v}.setVisible(false);`);
  if (base && differs("visible") && obj.visible) L.push(`  ${v}.setVisible(true);`);

  const b = obj.body;
  const bb = base?.body ?? null;
  // A prefab instance whose body matches the definition needs nothing: the
  // class constructor already sized it.
  if (b && !(bb && JSON.stringify(b) === JSON.stringify(bb))) {
    // A plain physics sprite is typed with a dynamic body. A prefab class is
    // not — its `body` may be static or absent as far as the compiler knows.
    const target = base && ts ? `(${v}.body as Phaser.Physics.Arcade.Body)` : `${v}.body`;
    bodyOut.push(...bodyCalls(target, b, bb, "  "));
  }

  const baseData = (base?.data ?? {}) as Record<string, unknown>;
  for (const [k, val] of Object.entries(obj.data ?? {})) {
    if (base && JSON.stringify(baseData[k]) === JSON.stringify(val)) continue;
    L.push(`  ${v}.setData(${q(k)}, ${JSON.stringify(val)});`);
  }
}

/** Arcade body setters for `b`, skipping what `bb` (the definition) already says. */
function bodyCalls(target: string, b: BodyDef, bb: BodyDef | null, indent: string): string[] {
  const out: string[] = [];
  if (b.shape === "circle") {
    out.push(`${indent}${target}.setCircle(${b.radius}, ${b.offsetX}, ${b.offsetY});`);
  } else {
    out.push(`${indent}${target}.setSize(${b.width}, ${b.height}, false);`);
    out.push(`${indent}${target}.setOffset(${b.offsetX}, ${b.offsetY});`);
  }
  if (b.immovable !== (bb?.immovable ?? false)) {
    out.push(`${indent}${target}.setImmovable(${b.immovable});`);
  }
  if (b.allowGravity !== (bb?.allowGravity ?? true)) {
    out.push(`${indent}${target}.setAllowGravity(${b.allowGravity});`);
  }
  if (b.bounce !== (bb?.bounce ?? 0)) {
    out.push(`${indent}${target}.setBounce(${b.bounce}, ${b.bounce});`);
  }
  const walls = b.collideWorldBounds ?? DEFAULT_COLLIDE_WORLD_BOUNDS;
  if (walls !== (bb ? (bb.collideWorldBounds ?? DEFAULT_COLLIDE_WORLD_BOUNDS) : false)) {
    out.push(`${indent}${target}.setCollideWorldBounds(${walls});`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scene class — yours
// ---------------------------------------------------------------------------

/**
 * The starting point for a scene's own class.
 *
 * Written once. It is deliberately small: a scene that only shows what the
 * editor placed needs three lines, and everything after that is the game.
 */
export function generateSceneClass(scene: SceneData, lang: Language = "ts"): string {
  const ts = lang === "ts";
  const cls = className(scene.key);
  const imports = ts
    ? `import { create${cls}, preload${cls}, type ${cls}Layout } from "./${cls}.layout";`
    : `import { create${cls}, preload${cls} } from "./${cls}.layout.js";`;
  return `import Phaser from "phaser";
${imports}

/**
 * ${scene.name || scene.key} — this file is yours.
 *
 * Mosaic wrote it once, as a starting point, and will not touch it again. What
 * you place in the editor arrives through ./${cls}.layout.${lang}, which is
 * regenerated on every save: \`create${cls}(this)\` builds the scene and hands
 * the objects back by name.
 */
export class ${cls} extends Phaser.Scene {
  ${ts ? `layout!: ${cls}Layout;\n\n  ` : ""}constructor() {
    super(${q(scene.key)});
  }

  preload()${ts ? ": void" : ""} {
    preload${cls}(this);
  }

  create()${ts ? ": void" : ""} {
    this.layout = create${cls}(this);
  }

  update(_time${ts ? ": number" : ""}, _delta${ts ? ": number" : ""})${ts ? ": void" : ""} {}
}
`;
}

// ---------------------------------------------------------------------------
// Prefab layout — generated
// ---------------------------------------------------------------------------

/**
 * The half of a prefab the editor owns: which texture, which body, which
 * defaults. Emitted as a base class, so the class you write extends it and
 * neither file ever has to be merged with the other.
 *
 * A variant extends its parent's class — YOUR class, not the generated one —
 * so behaviour written on `Brick` reaches `Brick_Red` the way inheritance
 * normally works, and the variant only restates what it changed.
 */
export function generatePrefabLayout(
  project: ProjectData,
  name: string,
  lang: Language = "ts",
): string {
  const ts = lang === "ts";
  // Resolved: a variant has no tree of its own, and the class it becomes has
  // to hold the values it actually resolves to.
  const prefab = resolvePrefab(project, name)!;
  const cls = className(name);
  const node = prefab.root;
  const parentName = findPrefab(project, name)?.base;
  const parent = parentName ? resolvePrefab(project, parentName) : undefined;
  const physical = !!node.body;

  const L: string[] = [];
  L.push(`// GENERATED by Mosaic from src/prefabs/${name}.prefab.json — do not edit.`);
  L.push(`//`);
  L.push(`// Every save in the editor rewrites this file. Your code lives in`);
  L.push(`// ./${cls}.${lang}, which extends the class below.`);
  L.push(`import Phaser from "phaser";`);

  if (parent && parentName && !parent.source) {
    const pcls = className(parentName);
    const pnode = parent.root;
    L.push(`import { ${pcls} } from "./${pcls}${ts ? "" : ".js"}";`);
    L.push(``);
    L.push(`/** ${name} is a variant of ${parentName}: it inherits the class and restates what differs. */`);
    L.push(`export class ${cls}Base extends ${pcls} {`);
    L.push(`  constructor(scene${ts ? ": Phaser.Scene" : ""}, x${ts ? ": number" : ""}, y${ts ? ": number" : ""}) {`);
    L.push(`    super(scene, x, y);`);
    if (node.texture !== pnode.texture || node.frame !== pnode.frame) {
      L.push(`    this.setTexture(${q(node.texture ?? "")}${node.frame ? `, ${q(node.frame)}` : ""});`);
    }
    if (node.originX !== pnode.originX || node.originY !== pnode.originY) {
      L.push(`    this.setOrigin(${node.originX}, ${node.originY});`);
    }
    if (node.scaleX !== pnode.scaleX || node.scaleY !== pnode.scaleY) {
      L.push(`    this.setScale(${node.scaleX}, ${node.scaleY});`);
    }
    if (physical && !pnode.body) L.push(`    scene.physics.add.existing(this);`);
    const bodyChanged = physical && JSON.stringify(node.body) !== JSON.stringify(pnode.body);
    if (bodyChanged) L.push(`    this.applyBody();`);
    const pdata = (pnode.data ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(node.data ?? {})) {
      if (JSON.stringify(pdata[k]) === JSON.stringify(v)) continue;
      L.push(`    this.setData(${q(k)}, ${JSON.stringify(v)});`);
    }
    L.push(`  }`);
    if (JSON.stringify(node.props ?? {}) !== JSON.stringify(pnode.props ?? {})) {
      L.push(``);
      emitDefaults(L, node.props ?? {}, ts, true);
    }
    if (bodyChanged) {
      L.push(``);
      emitApplyBody(L, node.body!, ts, !!pnode.body);
    }
    L.push(`}`);
    L.push(``);
    return L.join("\n");
  }

  L.push(``);
  L.push(
    `export class ${cls}Base extends ${physical ? "Phaser.Physics.Arcade.Sprite" : "Phaser.GameObjects.Sprite"} {`,
  );
  // Narrowed once, here, so `this.body.blocked.down` in your class needs no cast.
  if (physical && ts) {
    L.push(`  declare body: Phaser.Physics.Arcade.Body;`);
    L.push(``);
  }
  L.push(`  constructor(scene${ts ? ": Phaser.Scene" : ""}, x${ts ? ": number" : ""}, y${ts ? ": number" : ""}) {`);
  L.push(`    super(scene, x, y, ${q(node.texture ?? "")}${node.frame ? `, ${q(node.frame)}` : ""});`);
  L.push(`    scene.add.existing(this);`);
  if (physical) L.push(`    scene.physics.add.existing(this);`);
  if (node.originX !== 0.5 || node.originY !== 0.5) {
    L.push(`    this.setOrigin(${node.originX}, ${node.originY});`);
  }
  if (node.scaleX !== 1 || node.scaleY !== 1) {
    L.push(`    this.setScale(${node.scaleX}, ${node.scaleY});`);
  }
  if (node.rotation) L.push(`    this.setAngle(${round(node.rotation)});`);
  if (physical) L.push(`    this.applyBody();`);
  for (const [k, v] of Object.entries(node.data ?? {})) {
    L.push(`    this.setData(${q(k)}, ${JSON.stringify(v)});`);
  }
  if (node.playOnSpawn) {
    L.push(`    // Plays ${q(node.playOnSpawn)} on spawn — started by the scene layout, once the`);
    L.push(`    // animation is registered. A play() here would run before the key exists.`);
  }
  L.push(`  }`);
  L.push(``);
  emitDefaults(L, node.props ?? {}, ts, false);
  L.push(``);
  emitSpawn(L, cls, ts);
  if (node.body) {
    L.push(``);
    emitApplyBody(L, node.body, ts, false);
  }
  L.push(`}`);
  L.push(``);
  return L.join("\n");
}

/**
 * The values the editor set on the definition for the class's own @property
 * fields. Static, because they cannot be applied in this constructor: your
 * class's field initialisers run after it and would put the code's defaults
 * straight back. `spawn` applies them afterwards.
 */
function emitDefaults(L: string[], props: Record<string, unknown>, ts: boolean, overrides: boolean): void {
  const entries = Object.entries(props).filter(([k]) => /^[A-Za-z_$][\w$]*$/.test(k));
  const literal = entries.length
    ? `{ ${entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`
    : "{}";
  L.push(`  /** What the editor set on this prefab's definition, for the class's @property fields. */`);
  L.push(
    ts
      ? `  static ${overrides ? "override " : ""}readonly defaults: Readonly<Record<string, unknown>> = ${literal};`
      : `  static defaults = ${literal};`,
  );
}

/**
 * Making one from code, the way the layout makes the ones placed in the
 * editor: constructed, then given the definition's values. Called on your
 * class — `Bullet.spawn(scene, x, y)` — so it builds your class, and a variant
 * builds the variant.
 */
function emitSpawn(L: string[], cls: string, ts: boolean): void {
  L.push(`  /**`);
  L.push(`   * Makes one at run time, with the values the editor set on the definition.`);
  L.push(`   * Call it on your own class: \`${cls}.spawn(scene, x, y)\`.`);
  L.push(`   */`);
  if (ts) {
    L.push(`  static spawn<T extends Phaser.GameObjects.GameObject>(`);
    L.push(`    this: (new (scene: Phaser.Scene, x: number, y: number) => T) & { defaults: object },`);
    L.push(`    scene: Phaser.Scene,`);
    L.push(`    x: number,`);
    L.push(`    y: number,`);
    L.push(`  ): T {`);
  } else {
    L.push(`  static spawn(scene, x, y) {`);
  }
  L.push(`    const made = new this(scene, x, y);`);
  L.push(`    Object.assign(made, this.defaults);`);
  L.push(`    return made;`);
  L.push(`  }`);
}

function emitApplyBody(L: string[], b: BodyDef, ts: boolean, overrides: boolean): void {
  L.push(`  /**`);
  L.push(`   * The body authored in the editor. Public and idempotent because joining an`);
  L.push(`   * arcade group overwrites a body with the GROUP's defaults, so the layout's`);
  L.push(`   * groups call this again for anything added to them.`);
  L.push(`   */`);
  L.push(`  ${overrides && ts ? "override " : ""}applyBody()${ts ? ": this" : ""} {`);
  L.push(`    const body = this.body${ts ? " as Phaser.Physics.Arcade.Body" : ""};`);
  // Everything is stated, not just what differs from Arcade's defaults: this
  // runs again after a group has reset the body, and has to put it all back.
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
}

// ---------------------------------------------------------------------------
// Prefab class — yours
// ---------------------------------------------------------------------------

export function generatePrefabClass(name: string, lang: Language = "ts"): string {
  const ts = lang === "ts";
  const cls = className(name);
  return `import { ${cls}Base } from "./${cls}.layout${ts ? "" : ".js"}";

/**
 * ${name} — this file is yours.
 *
 * Mosaic wrote it once and will not touch it again. The art, the body and the
 * defaults you author in the editor arrive through ${cls}Base
 * (./${cls}.layout.${lang}, regenerated on every save). Behaviour goes here, the
 * way it would on any Phaser sprite — and a field marked @property shows up in
 * the editor's inspector for every ${name} you place.
 *
 * To make one from code, use \`${cls}.spawn(scene, x, y)\`: it is \`new\` plus the
 * values the editor set on the definition.
 */
export class ${cls} extends ${cls}Base {
  // preUpdate(time${ts ? ": number" : ""}, delta${ts ? ": number" : ""})${ts ? ": void" : ""} {
  //   super.preUpdate(time, delta);
  // }
}
`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The argument list for a prefab's constructor.
 *
 * A prefab Mosaic generates takes `(scene, x, y)`, because Mosaic wrote the
 * base. One bound to the project's own class takes whatever that class
 * declares, so the call is built from the recorded parameter names rather than
 * assumed — passing a scene where a name was wanted is the kind of bug that
 * compiles.
 */
function constructorArgs(
  prefab: { name: string; source?: PrefabSource },
  obj: SceneObject,
  world: { x: number; y: number },
): string {
  const plan = prefab.source ? bindArgs(prefab.source.params) : null;
  if (!plan) return `scene, ${round(world.x)}, ${round(world.y)}`;
  return plan
    .map((arg) => {
      switch (arg.kind) {
        case "scene":
          return "scene";
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
  const to = toModule.replace(/\.(ts|tsx|mts)$/, "").split("/");
  while (from.length && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const up = from.map(() => "..");
  const spec = [...up, ...to].join("/");
  return spec.startsWith(".") ? spec : `./${spec}`;
}
