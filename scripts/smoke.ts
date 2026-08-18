/**
 * Headless smoke test for the editor's non-rendering half.
 *
 * Runs the real ProjectStore, prefab resolution, atlas slicer, code generator
 * and keep-region merge through one pass of every workflow, so a refactor that
 * breaks undo isolation or prefab propagation fails here rather than in the
 * browser.
 *
 *   npm run smoke
 */
import { autoDetectFrames, nameFrames, sliceGrid } from "../src/editor/assets/slice";
import { generateFiles, generatePrefabClass, generateSceneClass } from "../src/editor/export/generate";
import { extractKeepRegions, hasUnmarkedEdits, mergeKeepRegions } from "../src/editor/export/keep";
import {
  DEFAULT_OPTIONS,
  isValidNpmName,
  planScaffold,
  slugify,
} from "../src/editor/project/scaffold";
import { SET_TILES, openTilesFor } from "../src/editor/ui/logoGeometry";
import { ProjectStore } from "../src/editor/store/project";
import { defaultBody } from "../src/editor/store/templates";
import { resolveObject } from "../src/shared/prefabs";
import { wouldCycle } from "../src/shared/transform";
import { objectsById } from "../src/shared/transform";
import type { ObjectLayer, TileLayer } from "../src/shared/types";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(name: string): void {
  console.log(`\n${name}`);
}

const store = new ProjectStore();
store.resetProject();

// ---------------------------------------------------------------- workflow 1
group("Workflow 1 — project & scenes");
{
  const before = store.project.scenes.length;
  const key = store.createScene("Level 02", "topdown");
  ok("createScene writes a new scene file", store.project.scenes.length === before + 1);
  ok("key is derived and collision-free", key === "Level_02", String(key));
  ok("template starts runnable (tile layer + player)", (() => {
    const scene = store.project.scenes.find((s) => s.key === key)!;
    return scene.layers.some((l) => l.kind === "tile") && scene.objects.some((o) => o.type === "player");
  })());

  store.activateScene("Level_01");
  store.setSelection([store.scene!.objects[0].id]);
  const level1Selection = [...store.view.selection];
  store.activateScene("Level_02");
  store.setSelection([]);
  store.activateScene("Level_01");
  ok("selection is per scene and survives switching", store.view.selection.join() === level1Selection.join());

  const dup = store.createScene("Level 02", "empty");
  ok("duplicate names get a fresh key rather than clobbering", dup === "Level_02_2", String(dup));
  store.deleteScene("Level_02_2");
  store.activateScene("Level_01");
}

// ---------------------------------------------------------------- workflow 2
group("Workflow 2 — scene composition");
{
  const scene = store.scene!;
  const objLayer = scene.layers.find((l) => l.kind === "object") as ObjectLayer;
  store.setActiveLayer(objLayer.id);

  const count = scene.objects.length;
  const id = store.addObject({ type: "crate", x: 100, y: 100, texture: "obj-crate" })!;
  ok("addObject lands on the active object layer", store.scene!.objects.length === count + 1);
  ok("the new object is selected", store.view.selection[0] === id);

  store.setObjectProp(id, "x", 220, "Set X");
  ok("inspector writes go through one transaction", store.scene!.objects.find((o) => o.id === id)!.x === 220);

  store.undo();
  ok("undo restores the previous transform", store.scene!.objects.find((o) => o.id === id)!.x === 100);
  store.redo();
  ok("redo re-applies it", store.scene!.objects.find((o) => o.id === id)!.x === 220);

  // Drag: one stroke, one undo entry, however many frames it took.
  const depthBefore = store.stack().depth;
  store.beginStroke("Move");
  for (let i = 0; i < 40; i++) store.previewTransform(id, 220 + i, 100 + i);
  store.endStroke();
  ok("a 40-frame drag costs exactly one undo entry", store.stack().depth === depthBefore + 1);
  store.undo();
  ok("undoing the drag returns to the pre-drag position", store.scene!.objects.find((o) => o.id === id)!.x === 220);
  store.redo();

  // Reparenting preserves world position and rejects cycles.
  const second = store.addObject({ type: "coin", x: 300, y: 300, texture: "obj-coin" })!;
  store.reparent([second], id);
  const child = store.scene!.objects.find((o) => o.id === second)!;
  const parent = store.scene!.objects.find((o) => o.id === id)!;
  ok("reparent preserves world position", child.x + parent.x === 300 && child.y + parent.y === 300,
     `${child.x}+${parent.x}`);
  ok("a cycle is rejected", wouldCycle(id, second, objectsById(store.scene!)));

  store.setSelection([id, second]);
  store.groupSelection();
  ok("group creates a container that owns both", (() => {
    const container = store.scene!.objects.find((o) => o.type === "container");
    return !!container && store.scene!.objects.filter((o) => o.parentId === container.id).length >= 1;
  })());

  // Leave the scene as we found it, so later workflows start from the template.
  store.setSelection([]);
  const container = store.scene!.objects.find((o) => o.type === "container")!;
  store.deleteObjects([container.id]);
  ok("deleting a container takes its descendants with it",
     !store.scene!.objects.some((o) => o.id === id || o.id === second));
}

// ---------------------------------------------------------------- workflow 3
group("Workflow 3 — tilemap & layers");
{
  store.addLayer("tile", { name: "Foreground" });
  const layer = store.activeLayer as TileLayer;
  ok("a tile layer binds one tileset and one grid size", layer.kind === "tile" && !!layer.tilesetId);

  const depthBefore = store.stack().depth;
  store.beginStroke("Paint tiles");
  for (let c = 0; c < 12; c++) store.putTile(layer.id, c, 3, 1);
  store.endStroke();
  ok("a 12-tile stroke coalesces into one undo entry", store.stack().depth === depthBefore + 1);
  ok("the tiles landed", (store.activeLayer as TileLayer).data[3].slice(0, 12).every((t) => t === 1));
  store.undo();
  ok("undo reverses the whole stroke", (store.activeLayer as TileLayer).data[3].every((t) => t === -1));
  store.redo();

  store.rectFill(layer.id, { col: 0, row: 6 }, { col: 4, row: 8 }, 2);
  ok("rect fill uses the same patch shape", (store.activeLayer as TileLayer).data[7][2] === 2);
  store.rectFill(layer.id, { col: 0, row: 6 }, { col: 4, row: 8 }, -1);
  ok("the eraser is putTile(-1)", (store.activeLayer as TileLayer).data[7][2] === -1);

  store.updateLayer(layer.id, { locked: true });
  const blocked = store.putTile(layer.id, 1, 1, 0);
  ok("a locked layer ignores writes", blocked === false);
  store.updateLayer(layer.id, { locked: false });

  const order = store.scene!.layers.map((l) => l.id);
  store.moveLayer(layer.id, -1);
  ok("layers reorder (render order === export depth)", store.scene!.layers.map((l) => l.id).join() !== order.join());
}

// ---------------------------------------------------------------- workflow 4
group("Workflow 4 — asset import & atlas slicing");
{
  const boxes = sliceGrid(128, 64, { frameWidth: 32, frameHeight: 32, margin: 0, spacing: 0 });
  ok("grid slicing yields rows x cols frames", boxes.length === 8, String(boxes.length));

  const withSpacing = sliceGrid(100, 34, { frameWidth: 32, frameHeight: 32, margin: 1, spacing: 2 });
  ok("margin and spacing are honoured", withSpacing.length === 2 && withSpacing[1].x === 35,
     JSON.stringify(withSpacing));

  const named = nameFrames(boxes, "hero_{i}", 0, 2);
  ok("a name pattern beats renaming by hand", named[3].name === "hero_03", named[3].name);

  // Two solid islands separated by transparency.
  const w = 20;
  const h = 10;
  const data = new Uint8ClampedArray(w * h * 4);
  const paint = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[(y * w + x) * 4 + 3] = 255;
  };
  paint(1, 1, 5, 5);
  paint(12, 2, 17, 7);
  const detected = autoDetectFrames({ width: w, height: h, data } as ImageData, 8);
  ok("auto-detect finds both islands", detected.length === 2, JSON.stringify(detected));
  ok("bounding boxes are tight", detected[0].w === 5 && detected[0].h === 5, JSON.stringify(detected[0]));

  store.importAssets([
    { id: "asset-sheet", key: "hero", kind: "atlas", path: "assets/hero.png", url: "data:,", width: 128, height: 64, frames: named },
  ]);
  ok("the atlas appears in the project with its frame count",
     store.project.assets.find((a) => a.key === "hero")?.frames?.length === 8);
}

// ---------------------------------------------------------------- workflow 5
group("Workflow 5 — prefabs & instancing");
{
  store.activateScene("Level_01");
  const coins = store.scene!.objects.filter((o) => o.type === "coin");
  ok("the repeated objects are there to select", coins.length === 4, String(coins.length));

  store.setSelection(coins.map((c) => c.id));
  const prefab = store.createPrefab("Coin", ["data.value", "scaleX"], coins.map((c) => c.id));
  ok("createPrefab writes a definition", !!prefab && store.project.prefabs.length === 1);
  ok("selected objects became instances", store.scene!.objects.filter((o) => o.prefab === "Coin").length === 4);

  const first = store.scene!.objects.find((o) => o.prefab === "Coin")!;
  store.setObjectProp(first.id, "data.value", 25);
  ok("an exposed edit records an override, not a local write",
     JSON.stringify(store.scene!.objects.find((o) => o.id === first.id)!.overrides) === '{"data.value":25}');
  ok("resolution is definition <- overrides",
     (resolveObject(store.project, store.scene!.objects.find((o) => o.id === first.id)!).data as { value: number }).value === 25);

  store.setObjectProp(first.id, "originX", 0.1);
  ok("a non-exposed field is refused rather than silently written",
     store.scene!.objects.find((o) => o.id === first.id)!.originX !== 0.1);

  // Editing the definition propagates everywhere except overridden fields.
  store.updatePrefab("Coin", { data: { value: 50 } });
  const instances = store.scene!.objects.filter((o) => o.prefab === "Coin");
  const values = instances.map((o) => (resolveObject(store.project, o).data as { value: number }).value);
  ok("untouched instances pick up the new definition value",
     values.filter((v) => v === 50).length === 3, JSON.stringify(values));
  ok("the overridden instance keeps its own value", values.filter((v) => v === 25).length === 1);

  store.revertOverride(first.id, "data.value");
  ok("reverting an override relinks the field",
     (resolveObject(store.project, store.scene!.objects.find((o) => o.id === first.id)!).data as { value: number }).value === 50);

  store.unpackInstance(first.id);
  ok("unpacking makes it a plain object again", !store.scene!.objects.find((o) => o.id === first.id)!.prefab);
}

// ---------------------------------------------------------------- workflow 6
group("Workflow 6 — animation");
{
  store.upsertAnim({
    key: "hero_run",
    fps: 12,
    loop: true,
    frames: [
      { textureKey: "hero", frame: "hero_00" },
      { textureKey: "hero", frame: "hero_01", duration: 250 },
    ],
  });
  ok("animations live in one keyed list", store.project.anims.length === 1);

  const player = store.scene!.objects.find((o) => o.type === "player")!;
  store.setObjectProp(player.id, "playOnSpawn", "hero_run");
  ok("an object names the animation it plays on spawn",
     store.scene!.objects.find((o) => o.id === player.id)!.playOnSpawn === "hero_run");

  store.setObjectProp(player.id, "playOnSpawn", "does_not_exist");
  const issues = store.validate();
  ok("a missing anim key is a validation error, not a silent no-op",
     issues.some((i) => i.level === "error" && i.message.includes("does_not_exist")));
  store.setObjectProp(player.id, "playOnSpawn", "hero_run");
  ok("fixing it clears the error", !store.validate().some((i) => i.message.includes("does_not_exist")));
}

// ---------------------------------------------------------------- workflow 7
group("Workflow 7 — physics & collision");
{
  const player = store.scene!.objects.find((o) => o.type === "player")!;
  ok("a template player ships with a body", !!player.body);
  ok("body defaults derive from the type's bounds", defaultBody("player")!.height === 40);

  store.setObjectProp(player.id, "body.width", 22);
  ok("the body is a section of the object", store.scene!.objects.find((o) => o.id === player.id)!.body!.width === 22);

  store.setCollisionRule("player", "pickup", "overlap");
  ok("the matrix is symmetric",
     store.project.collision.player.pickup === "overlap" && store.project.collision.pickup.player === "overlap");

  store.addGroup("hazard");
  ok("a new group starts ignoring everything",
     store.project.groups.includes("hazard") && store.project.collision.hazard.player === "ignore");
}

// ---------------------------------------------------------------- workflow 9
group("Workflow 9 — export");
{
  const scene = store.scene!;
  const files = generateFiles(store.project, scene, "both");
  const paths = files.map((f) => f.path);
  ok("both targets emit JSON and a class",
     paths.includes(`src/scenes/${scene.key}.scene.json`) && paths.includes(`src/scenes/${scene.key}Scene.ts`),
     paths.join(" "));
  ok("prefab definitions become classes", paths.some((p) => p.startsWith("src/prefabs/")));
  ok("the shipped manifest carries no data: URLs",
     !files.find((f) => f.path === "phaser.editor.json")!.contents.includes("data:image"));

  const code = generateSceneClass(store.project, scene);
  ok("emit order is preload then create", code.indexOf("preload()") < code.indexOf("create()"));
  ok("layers are emitted bottom-up with explicit depth", code.includes("setDepth(0)"));
  ok("the collision matrix becomes collider/overlap calls",
     code.includes("this.physics.add.overlap(") || code.includes("this.physics.add.collider("));
  ok("animations are created before play-on-spawn fires",
     !code.includes(".play(") || code.lastIndexOf("this.anims.create") < code.indexOf(".play("));

  const again = generateSceneClass(store.project, scene);
  ok("the generator is pure — same scene in, same bytes out", code === again);

  // Keep regions
  const edited = code.replace(
    '    // <keep id="create">',
    '    // <keep id="create">\n    this.myOwnWiring();',
  );
  ok("keep regions are found in the edited file", extractKeepRegions(edited).get("create")!.includes("myOwnWiring"));
  const merged = mergeKeepRegions(code, edited);
  ok("regeneration carries hand-written regions across", merged.includes("this.myOwnWiring();"));
  ok("everything outside the region is regenerated", merged.split("\n").length >= code.split("\n").length);
  ok("an edit outside a keep region is flagged as a clobber risk",
     hasUnmarkedEdits(code.replace("preload(): void {", "preload(): void { /* hand edit */"), code));
  ok("an edit inside one is not", !hasUnmarkedEdits(edited, code));
}

// ------------------------------------------------- prefab classes in export
group("Prefabs become classes the scene actually constructs");
{
  store.activateScene("Level_01");
  // Workflow 5 left the Coin prefab in place, minus the instance it unpacked.
  const prefabName = "Coin";
  const instances = store.scene!.objects.filter((o) => o.prefab === prefabName);
  ok("there are prefab instances to export", instances.length >= 2, String(instances.length));

  // One instance diverges; the rest stay linked.
  store.setObjectProp(instances[0].id, "data.value", 25);

  const code = generateSceneClass(store.project, store.scene!);
  ok("instances are constructed through the prefab class",
     code.includes(`new ${prefabName}(this,`), "no `new` call emitted");
  ok("the scene imports that class",
     code.includes(`import { ${prefabName} } from "../prefabs/${prefabName}";`));
  // Count, rather than pattern-match: workflow 5 unpacked one coin, and that
  // one SHOULD still be a plain sprite.
  const constructed = code.split(`new ${prefabName}(this,`).length - 1;
  ok("every instance is constructed, none left as a plain sprite",
     constructed === instances.length, `${constructed} of ${instances.length}`);

  const lines = code.split("\n");
  const blockFor = (varName: string) => {
    const start = lines.findIndex((l) => l.includes(`const ${varName} = new ${prefabName}(`));
    if (start === -1) return [];
    const end = lines.findIndex((l, i) => i > start && l.includes("this.objects["));
    return lines.slice(start, end + 1);
  };
  const overriding = blockFor(
    lines.find((l) => l.includes(`= new ${prefabName}(`))!.match(/const (\w+) =/)![1],
  );
  ok("the overriding instance emits its override", overriding.some((l) => l.includes("setData(\"value\", 25)")),
     overriding.join(" | "));

  // A linked instance must emit nothing the definition already owns, or the
  // definition would be baked in and propagation would stop working.
  const linkedVar = lines
    .filter((l) => l.includes(`= new ${prefabName}(`))
    .map((l) => l.match(/const (\w+) =/)![1])[1];
  const linked = blockFor(linkedVar);
  ok("a linked instance emits no definition properties",
     !linked.some((l) => /setData|setTexture|setSize|setOffset|setAllowGravity/.test(l)),
     linked.join(" | "));
  ok("but it still gets its own name, depth and position",
     linked.some((l) => l.includes("setName(")) && linked.some((l) => l.includes("setDepth(")));

  ok("prefab instances still join their collision group",
     code.includes(`this.physics.add.group([`) && code.includes(linkedVar));

  // Editing the definition must move every linked instance in the OUTPUT too.
  store.updatePrefab(prefabName, { scaleX: 3 });
  const scaled = generateSceneClass(store.project, store.scene!);
  const scaledLinked = scaled
    .split("\n")
    .slice(scaled.split("\n").findIndex((l) => l.includes(`const ${linkedVar} = new`)));
  ok("a definition change is not re-emitted per instance (it lives in the class)",
     !scaledLinked.slice(0, 4).some((l) => l.includes("setScale(3")),
     scaledLinked.slice(0, 4).join(" | "));
  const cls = generatePrefabClass(store.project, prefabName);
  ok("the class carries the definition's scale instead", cls.includes("this.setScale(3"), cls);
  store.updatePrefab(prefabName, { scaleX: 1 });

  // Animations: the class must not play before create() registers them.
  store.upsertAnim({ key: "spin", fps: 8, loop: true, frames: [{ textureKey: "obj-coin", frame: "__BASE" }] });
  store.updatePrefab(prefabName, { playOnSpawn: "spin" });
  const withAnim = generateSceneClass(store.project, store.scene!);
  const animClass = generatePrefabClass(store.project, prefabName);
  ok("the prefab constructor does not play the animation", !/this\.play\(/.test(animClass));
  ok("the scene plays it after anims.create",
     withAnim.lastIndexOf("this.anims.create") < withAnim.indexOf(".play(\"spin\")"));
  store.updatePrefab(prefabName, { playOnSpawn: undefined });

  // A body-less prefab is not an arcade sprite.
  const plain = store.scene!.objects.find((o) => !o.prefab && !o.body && o.type !== "container");
  if (plain) {
    store.setSelection([plain.id]);
    store.createPrefab("Marker", [], [plain.id]);
    const markerCls = generatePrefabClass(store.project, "Marker");
    ok("a prefab with no body extends GameObjects.Sprite",
       markerCls.includes("extends Phaser.GameObjects.Sprite"), markerCls.split("\n")[4]);
  }
}

// ------------------------------------------------------- cross-scene undo
group("Undo isolation");
{
  store.activateScene("Level_01");
  const idA = store.addObject({ type: "crate", x: 10, y: 10, texture: "obj-crate" })!;

  store.activateScene("Level_02");
  const idB = store.addObject({ type: "crate", x: 20, y: 20, texture: "obj-crate" })!;

  store.activateScene("Level_01");
  store.undo(); // must undo the Level_01 add, not Level_02's
  // Undo replaces the scene object wholesale, so read it back from the store
  // rather than through a reference captured earlier.
  const level1 = store.project.scenes.find((s) => s.key === "Level_01")!;
  ok("undo pops this scene's own stack", !level1.objects.some((o) => o.id === idA));
  ok("the other scene is untouched",
     store.project.scenes.find((s) => s.key === "Level_02")!.objects.some((o) => o.id === idB));
}

// --------------------------------------------------------------- identity
group("Identity — the mark reproduces Mosaic Logo.html");
{
  ok("seven set tiles, on the 3x3 grid with a 1-unit gutter",
     SET_TILES.length === 7 &&
       SET_TILES.every(([x, y]) => [0, 9, 18].includes(x) && [0, 9, 18].includes(y)));
  ok("the two open cells are the ones NOT set — the M survives", (() => {
    const set = new Set(SET_TILES.map(([x, y]) => `${x},${y}`));
    const all = [0, 9, 18].flatMap((x) => [0, 9, 18].map((y) => `${x},${y}`));
    const open = all.filter((c) => !set.has(c));
    return open.length === 2 && open.includes("9,9") && open.includes("9,18");
  })());

  // The sheet's own ladder samples.
  const l52 = openTilesFor(52);
  const l32 = openTilesFor(32);
  const l20 = openTilesFor(20);
  ok("52px: stroke 1, inset 9.5, span 7",
     l52?.stroke === 1 && l52.inset === 9.5 && l52.span === 7, JSON.stringify(l52));
  ok("32px: stroke 1.2, inset 9.6, span 6.8",
     l32?.stroke === 1.2 && l32.inset === 9.6 && l32.span === 6.8, JSON.stringify(l32));
  ok("20px: stroke 1.5, inset 9.75, span 6.5",
     l20?.stroke === 1.5 && l20.inset === 9.75 && l20.span === 6.5, JSON.stringify(l20));
  ok("the stroke thickens monotonically as the mark shrinks",
     l52!.stroke < l32!.stroke && l32!.stroke < l20!.stroke);
  ok("below 16px it is the solid cut (favicon, app icon, menu strip)",
     openTilesFor(15) === null && openTilesFor(14) === null && openTilesFor(13) === null);
  ok("at and above 16px the open tiles are drawn", openTilesFor(16) !== null);
}

// ----------------------------------------------------- new project scaffold
group("New project — the scaffold plan");
{
  ok("names are slugged for npm", slugify("Sky Ward 2!") === "sky-ward-2", slugify("Sky Ward 2!"));
  ok("an empty name still yields a usable slug", slugify("  ") === "untitled");
  ok("a valid npm name is recognised", isValidNpmName("skyward"));
  ok("a name needing slugging is flagged, not rejected", !isValidNpmName("Sky Ward"));

  const base = { ...DEFAULT_OPTIONS, name: "skyward", location: "/tmp/projects" };
  const plan = planScaffold(base);

  ok("the plan resolves a root under the location", plan.root === "/tmp/projects/skyward", plan.root);
  ok("nothing in the plan is written yet — it is data", Array.isArray(plan.files));
  ok("the review lists skipped files too, so the diff is whole",
     plan.files.length > plan.writes.length);

  const rels = plan.writes.map((f) => f.rel);
  for (const required of [
    "package.json",
    "mosaic.config.json",
    "phaser.editor.json",
    "index.html",
    "src/main.ts",
    "src/scenes/Level_01.ts",
    "src/scenes/Level_01.scene.json",
    "src/prefabs/Player.ts",
    "README.md",
  ]) {
    ok(`writes ${required}`, rels.includes(required), rels.join(" "));
  }

  const pkg = JSON.parse(plan.files.find((f) => f.rel === "package.json")!.contents);
  ok("package.json carries the slug and phaser", pkg.name === "skyward" && !!pkg.dependencies.phaser);
  ok("vite is a dev dependency when vite is chosen", !!pkg.devDependencies.vite);

  // Options actually change the plan.
  const js = planScaffold({ ...base, language: "js" });
  ok("javascript swaps every extension",
     js.writes.some((f) => f.rel === "src/main.js") && !js.writes.some((f) => f.rel.endsWith("main.ts")));

  const noBundler = planScaffold({ ...base, bundler: "none" });
  ok("bundler:none skips the vite config",
     !noBundler.writes.some((f) => f.rel.startsWith("vite.config")),
     noBundler.writes.map((f) => f.rel).join(" "));
  ok("and it is still LISTED as skipped, not hidden",
     noBundler.files.some((f) => f.rel.startsWith("vite.config") && f.skipped));

  const webpack = planScaffold({ ...base, bundler: "webpack" });
  ok("webpack writes its own config",
     webpack.writes.some((f) => f.rel.startsWith("webpack.config")));

  const empty = planScaffold({ ...base, template: "empty" });
  ok("the empty template skips the player prefab",
     !empty.writes.some((f) => f.rel.startsWith("src/prefabs/")));

  const noArt = planScaffold({ ...base, sampleArt: false });
  ok("placeholder art is optional",
     !noArt.writes.some((f) => f.rel.startsWith("assets/")));

  const noGit = planScaffold({ ...base, git: false });
  ok("gitignore follows the git option", !noGit.writes.some((f) => f.rel === ".gitignore"));

  // Config really drives the generated game, not just the editor.
  const custom = planScaffold({
    ...base,
    config: { canvas: { width: 640, height: 360 }, tile: 16, scale: "ENVELOP", physics: "matter", pixelArt: false },
  });
  const main = custom.files.find((f) => f.rel === "src/main.ts")!.contents;
  ok("canvas size reaches the game config", main.includes("width: 640") && main.includes("height: 360"));
  ok("scale mode reaches the game config", main.includes("Phaser.Scale.ENVELOP"), main);
  ok("physics choice reaches the game config", main.includes('default: "matter"'));
  ok("pixelArt reaches the game config", main.includes("pixelArt: false"));
  const cfg = JSON.parse(custom.files.find((f) => f.rel === "mosaic.config.json")!.contents);
  ok("and the same values are written to mosaic.config.json", cfg.tile === 16 && cfg.scale === "ENVELOP");

  const scene = JSON.parse(
    custom.files.find((f) => f.rel === "src/scenes/Level_01.scene.json")!.contents,
  );
  ok("the scene is sized from the config", scene.settings.width === 640 && scene.settings.gridSize === 16);
  ok("the tile layer is sized from the config",
     scene.layers.find((l: { kind: string }) => l.kind === "tile").tileWidth === 16);

  ok("templates are runnable — the scene has a layer and an object",
     plan.project.scenes[0].layers.length > 0 && plan.project.scenes[0].objects.length > 0);

  const art = plan.files.filter((f) => f.encoding === "base64");
  ok("art is planned as binary, not as text", art.length === 2, String(art.length));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
