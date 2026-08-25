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
import {
  attachableClasses,
  buildIndex,
  componentFiles,
  sourceFiles,
  parseScriptFile,
  propertiesOf,
} from "../src/editor/scripts/parse";
import { samplePlayerController, scriptStub, toClassName } from "../src/editor/scripts/stub";
import { scriptFilePath, scriptsOf } from "../src/shared/scripts";
import { shapeTextureKey } from "../src/shared/definitions";
import { generateFiles, generatePrefabClass, generateSceneClass } from "../src/editor/export/generate";
import { extractKeepRegions, hasUnmarkedEdits, mergeKeepRegions } from "../src/editor/export/keep";
import {
  DEFAULT_OPTIONS,
  isValidNpmName,
  planScaffold,
  slugify,
} from "../src/editor/project/scaffold";
import { SET_TILES, openTilesFor } from "../src/shared/logoGeometry";
import { FIELD, REVERSED, mosaicIconBitmap, pixelAt } from "../src/shared/logoBitmap";
import {
  CONFIG_PATH,
  MANIFEST_PATH,
  projectFromSource,
  projectToFiles,
  toManifest,
} from "../src/editor/project/serialize";
import {
  applyImport,
  sceneFromRecording,
  type RecordedObject,
  type Recording,
} from "../src/editor/import/fromRecording";
import { createStarterProject } from "../src/editor/store/templates";
import { bindArgs, boundArgValues, unbindableParams } from "../src/shared/prefabBinding";
import { collectLoaderManifest } from "../src/shared/manifest";
import { ProjectStore } from "../src/editor/store/project";
import { bodyForSize, objectSize } from "../src/shared/size";
import { canInherit, resolveObject, resolvePrefab } from "../src/shared/prefabs";
import { wouldCycle } from "../src/shared/transform";
import { objectsById } from "../src/shared/transform";
import type { ObjectLayer, TileLayer } from "../src/shared/types";

let failures = 0;
let checks = 0;

/** A recorded display-list entry, with the defaults a snapshot always carries. */
function obj(over: Partial<RecordedObject> & { kind: string }): RecordedObject {
  return {
    name: null, parent: null, x: 0, y: 0, depth: 0, rotationDeg: 0,
    scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5, visible: true,
    ...over,
  };
}

function ok(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Change a definition the way the editor does: open it as a document, edit it,
 * push it. There is no other write path — the propagation panel exists so that
 * there is not one.
 */
function editPrefab(name: string, patch: Record<string, unknown>): void {
  const returnTo = store.activeSceneKey;
  store.openPrefab(name);
  for (const [path, value] of Object.entries(patch)) {
    store.setObjectProp(store.prefabDoc!.rootId, path, value, `Set ${path}`);
  }
  store.pushPrefabSave();
  store.closePrefab(true);
  store.activateScene(returnTo);
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
  ok("template starts runnable (tile layer + a placed instance)", (() => {
    const scene = store.project.scenes.find((s) => s.key === key)!;
    return scene.layers.some((l) => l.kind === "tile") && scene.objects.some((o) => !!o.prefab);
  })());
  ok("its starter content is prefabs the project owns, not engine types",
     store.project.prefabs.some((p) => p.name === "Player") &&
       store.project.scenes.every((sc) => sc.objects.every((o) => o.type === "sprite")),
     JSON.stringify(store.project.prefabs.map((p) => p.name)));

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
group("Workflow 5 — promote, isolate, expose, vary, place, propagate");
{
  store.activateScene("Level_01");
  // The fixture this workflow needs is PLAIN repeated objects. The starter
  // project ships them as Pickup instances, so they are unpacked first — which
  // is itself the editor action for "stop linking this to a definition".
  const seeds = store.scene!.objects.filter((o) => o.prefab === "Pickup");
  ok("the repeated objects are there to select", seeds.length === 4, String(seeds.length));
  for (const seed of seeds) store.unpackInstance(seed.id);
  const coins = store.scene!.objects.filter((o) => seeds.some((s) => s.id === o.id));
  ok("unpacking leaves plain objects behind", coins.every((c) => !c.prefab));
  for (const coin of coins) store.setObjectProp(coin.id, "data.value", 10);

  // --- promote ---------------------------------------------------------
  const before = store.project.prefabs.length;
  store.setSelection(coins.map((c) => c.id));
  const check = store.promoteCheck(coins.map((c) => c.id));
  ok("siblings of one parent promote together", check.ok, check.reason ?? "");

  const prefab = store.createPrefab({
    name: "Coin",
    objectId: check.root!.id,
    exposed: ["data.value", "scaleX"],
    siblingIds: check.siblings.map((o) => o.id),
  });
  ok("createPrefab writes a definition",
     !!prefab && store.project.prefabs.length === before + 1);
  ok("selected objects became instances",
     store.scene!.objects.filter((o) => o.prefab === "Coin").length === 4);
  ok("the definition's root carries a local id", !!prefab!.root!.lid);


  const first = store.scene!.objects.find((o) => o.prefab === "Coin")!;
  store.setObjectProp(first.id, "data.value", 25);
  ok("an exposed edit records an override, not a local write",
     JSON.stringify(store.scene!.objects.find((o) => o.id === first.id)!.overrides) === '{"data.value":25}');
  ok("resolution is definition <- overrides",
     (resolveObject(store.project, store.scene!.objects.find((o) => o.id === first.id)!).data as { value: number }).value === 25);

  store.setObjectProp(first.id, "originX", 0.1);
  ok("a non-exposed field is refused rather than silently written",
     store.scene!.objects.find((o) => o.id === first.id)!.originX !== 0.1);

  // --- isolate ---------------------------------------------------------
  ok("prefab edit mode opens the definition as its own document", store.openPrefab("Coin"));
  ok("the document IS the active scene", store.scene!.key === "prefab:Coin");
  ok("the stage holds only the prefab", store.scene!.objects.length === 1);
  ok("the underlying scene stays open", store.sceneBehind!.key === "Level_01");
  ok("the document starts with its own clean undo stack", store.stack().depth === 0);

  // Editing the definition does NOT touch the scenes until it is saved.
  store.setObjectProp(store.prefabDoc!.rootId, "data", { value: 50 }, "Set value");
  ok("the document is modified", store.isDirty("prefab:Coin"));
  {
    const untouched = store.project.scenes
      .flatMap((sc) => sc.objects)
      .filter((o) => o.prefab === "Coin" && !o.overrides?.["data.value"]);
    ok("instances still resolve from the SAVED definition",
       untouched.every((o) => (resolveObject(store.project, o).data as { value: number }).value === 10));
  }

  // --- propagate -------------------------------------------------------
  const plan = store.planPrefabSave()!;
  ok("saving plans before it writes", !!plan && !plan.unchanged);
  ok("the plan counts what moves", plan.totals.moved === 3, String(plan.totals.moved));
  ok("the plan counts what an instance keeps for itself", plan.totals.kept === 1,
     String(plan.totals.kept));
  ok("every consequence names where it lands",
     plan.rows.every((r) => !!r.where && !!r.what));

  store.pushPrefabSave();
  {
    const instances = store.project.scenes
      .flatMap((sc) => sc.objects)
      .filter((o) => o.prefab === "Coin");
    const values = instances.map(
      (o) => (resolveObject(store.project, o).data as { value: number }).value,
    );
    ok("untouched instances pick up the new definition value",
       values.filter((v) => v === 50).length === 3, JSON.stringify(values));
    ok("the overridden instance keeps its own value", values.filter((v) => v === 25).length === 1);
  }
  ok("the document is clean once pushed", !store.isDirty("prefab:Coin"));

  // --- expose ----------------------------------------------------------
  {
    const held = () =>
      store.project.scenes
        .flatMap((sc) => sc.objects)
        .filter((o) => o.prefab === "Coin" && "data.value" in (o.overrides ?? {})).length;

    ok("an override is held against the exposed field", held() === 1);

    const impact = store.unexposeImpact("data.value");
    ok("unexposing states the cost first", impact.count === 1, String(impact.count));
    ok("and names the scenes it would touch", impact.scenes.length === 1, impact.scenes.join());

    store.toggleExposed("data.value");
    store.planPrefabSave();
    ok("the plan lists the override it would drop", store.ui.prefabPlan!.totals.dropped === 1);
    ok("but nothing is dropped until it is pushed", held() === 1);

    store.pushPrefabSave();
    ok("pushing drops the override that can no longer be shown", held() === 0);

    store.toggleExposed("data.value");
    store.pushPrefabSave();
    ok("re-exposing does not resurrect it — a dropped override is gone", held() === 0);
  }

  // --- skipped scenes ---------------------------------------------------
  {
    store.setObjectProp(store.prefabDoc!.rootId, "scaleY", 1.5, "Set scale");
    const guarded = store.planPrefabSave((key) =>
      key === "Level_01" ? "changed on disk since load" : null,
    )!;
    ok("a scene that cannot be written is marked skipped, with a reason",
       guarded.scenes.some((sc) => sc.key === "Level_01" && !!sc.skipped));
    ok("and the skip is listed as a consequence of its own",
       guarded.rows.some((r) => r.kind === "skipped"));

    const before = store.project.scenes
      .flatMap((sc) => sc.objects)
      .filter((o) => o.prefab === "Coin").length;
    store.pushPrefabSave();
    ok("pushing past a skipped scene leaves its instances alone",
       store.project.scenes.flatMap((sc) => sc.objects).filter((o) => o.prefab === "Coin").length ===
         before);
  }

  // --- variants --------------------------------------------------------
  {
    ok("a variant inherits rather than copying",
       !!store.createVariant("Coin", "Coin_Gold"));
    const variant = store.project.prefabs.find((p) => p.name === "Coin_Gold")!;
    ok("a variant file has no tree of its own", !variant.root && variant.base === "Coin");

    store.openPrefab("Coin_Gold");
    store.setObjectProp(store.prefabDoc!.rootId, "scaleX", 2, "Set scale");
    const def = store.prefabDocDef()!;
    ok("a variant states only what differs",
       Object.keys(def.diff ?? {}).join(",") === "scaleX", JSON.stringify(def.diff));
    store.pushPrefabSave();

    const gold = resolvePrefab(store.project, "Coin_Gold")!;
    ok("the variant resolves its own claim", gold.root.scaleX === 2);
    ok("and inherits everything else",
       (gold.root.data as { value: number }).value === 50);
    ok("the chain reads base first", gold.chain.join(" → ") === "Coin → Coin_Gold");

    // A base change still flows through the fields the variant never claimed.
    store.openPrefab("Coin");
    store.setObjectProp(store.prefabDoc!.rootId, "data", { value: 99 }, "Set value");
    store.pushPrefabSave();
    ok("an unrelated base change reaches the variant",
       (resolvePrefab(store.project, "Coin_Gold")!.root.data as { value: number }).value === 99);
    ok("the variant keeps what it claimed",
       resolvePrefab(store.project, "Coin_Gold")!.root.scaleX === 2);

    ok("a variant of a variant is allowed", canInherit(store.project, "Coin_Gold", "Coin_Deep"));
    store.createVariant("Coin_Gold", "Coin_Deep");
    ok("but a third level is refused", !canInherit(store.project, "Coin_Deep", "Coin_Deeper"));
    store.deletePrefab("Coin_Deep");
  }

  // --- back out --------------------------------------------------------
  ok("leaving a clean document is allowed", store.closePrefab());
  ok("the scene is the active document again", store.scene!.key === "Level_01");

  store.revertOverride(first.id, "data.value");
  ok("reverting an override relinks the field",
     (resolveObject(store.project, store.scene!.objects.find((o) => o.id === first.id)!).data as { value: number }).value === 99);

  store.unpackInstance(first.id);
  ok("unpacking makes it a plain object again", !store.scene!.objects.find((o) => o.id === first.id)!.prefab);
  store.deletePrefab("Coin_Gold");
}

// -------------------------------------------- text, camera and sound as data
group("Text, camera and sound are scene data");
{
  store.activateScene("Level_01");

  // --- text ------------------------------------------------------------
  const hudId = store.addText("SCORE 0")!;
  const hud = store.scene!.objects.find((o) => o.id === hudId)!;
  ok("a text object is an object like any other", hud.type === "text" && !!hud.text);
  store.setObjectProp(hudId, "text.fixed", true);
  store.setObjectProp(hudId, "text.fontSize", 18);
  ok("its settings are scene data",
     store.scene!.objects.find((o) => o.id === hudId)!.text!.fixed === true);

  const withText = generateSceneClass(store.project, store.scene!);
  ok("text is emitted as text, not skipped for having no texture",
     withText.includes('this.add.text('), withText.slice(0, 200));
  ok("a pinned HUD does not scroll with the level",
     withText.includes(".setScrollFactor(0);"));

  // --- camera ----------------------------------------------------------
  const player = store.scene!.objects.find((o) => o.name.startsWith("Player"))!;
  store.transact("Camera", () => {
    store.scene!.settings.camera = {
      follow: player.name,
      lerpX: 0.1,
      lerpY: 0.1,
      zoom: 1,
      clampToBounds: true,
      deadzoneWidth: 200,
      deadzoneHeight: 120,
    };
  });
  const withCam = generateSceneClass(store.project, store.scene!);
  ok("the camera follows what the scene says it follows",
     withCam.includes("this.cameras.main.startFollow("), withCam);
  ok("and its deadzone comes with it", withCam.includes("setDeadzone(200, 120)"));
  ok("the follow call comes after the object it follows exists", (() => {
    const lines = withCam.split("\n");
    const target = lines.findIndex((l) => l.includes(`.setName("${player.name}")`));
    const follow = lines.findIndex((l) => l.includes("startFollow("));
    return target >= 0 && follow > target;
  })());

  store.transact("Camera", () => {
    store.scene!.settings.camera!.follow = "NoSuchObject";
  });
  ok("a camera pointed at nothing is a validation error, not a silent no-op",
     store.validate().some((i) => i.message.includes("NoSuchObject")));
  store.transact("Camera", () => {
    store.scene!.settings.camera!.follow = player.name;
  });

  // --- sound -----------------------------------------------------------
  store.importAssets([
    {
      id: "asset-ping", key: "ping", kind: "audio", path: "assets/ping.wav",
      url: "", width: 0, height: 0,
    },
  ]);
  const chimeId = store.addObject({
    type: "sprite",
    name: "Chime",
    x: 32,
    y: 32,
    texture: shapeTextureKey("circle"),
    data: {},
  })!;
  store.setObjectProp(chimeId, "sounds.spawn", "ping");
  ok("a sound cue is scene data",
     store.scene!.objects.find((o) => o.id === chimeId)!.sounds?.spawn === "ping");
  ok("and an exposed cue on an instance records an override",
     (() => {
       store.setObjectProp(player.id, "sounds.overlap", "ping");
       return (store.scene!.objects.find((o) => o.id === player.id)!.overrides ?? {})[
         "sounds.overlap"
       ] === "ping";
     })());
  ok("audio a scene references is in its loader manifest",
     collectLoaderManifest(store.project, store.scene!).some((e) => e.key === "ping"),
     collectLoaderManifest(store.project, store.scene!).map((e) => e.key).join());

  store.setObjectProp(chimeId, "sounds.spawn", "not_a_clip");
  ok("a cue naming nothing is a validation error",
     store.validate().some((i) => i.message.includes("not_a_clip")));
  store.deleteObjects([hudId, chimeId]);
  store.revertOverride(player.id, "sounds.overlap");
}

// ---------------------------------------------------------------- workflow 6
group("Workflow 6 — animation");
{
  store.upsertAnim({
    key: "hero_run",
    fps: 12,
    repeat: -1,
    frames: [
      { textureKey: "hero", frame: "hero_00" },
      { textureKey: "hero", frame: "hero_01", duration: 250 },
    ],
  });
  ok("animations live in one keyed list", store.project.anims.length === 1);

  const player = store.scene!.objects.find((o) => o.prefab === "Player")!;
  store.setObjectProp(player.id, "playOnSpawn", "hero_run");
  ok("an object names the animation it plays on spawn",
     resolveObject(store.project, store.scene!.objects.find((o) => o.id === player.id)!)
       .playOnSpawn === "hero_run");

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
  const player = store.scene!.objects.find((o) => o.prefab === "Player")!;
  ok("a template player ships with a body", !!resolveObject(store.project, player).body);
  ok("body defaults derive from the object's own art",
     bodyForSize(objectSize(store.project, resolveObject(store.project, player)))!.height === 40,
     JSON.stringify(objectSize(store.project, resolveObject(store.project, player))));

  store.setObjectProp(player.id, "body.width", 22);
  ok("the body is a section of the object",
     resolveObject(store.project, store.scene!.objects.find((o) => o.id === player.id)!)
       .body!.width === 22);

  store.setCollisionRule("player", "pickup", "overlap");
  ok("the matrix is symmetric",
     store.project.collision.player.pickup === "overlap" && store.project.collision.pickup.player === "overlap");

  store.addGroup("scenery");
  ok("a new group starts ignoring everything",
     store.project.groups.includes("scenery") && store.project.collision.scenery.player === "ignore");

  store.renameGroup("scenery", "backdrop");
  ok("renaming a group carries the matrix with it",
     !store.project.collision.scenery && store.project.collision.backdrop.player === "ignore");
  store.removeGroup("backdrop");
  ok("removing one takes its row and its column",
     !store.project.groups.includes("backdrop") &&
       Object.values(store.project.collision).every((row) => !("backdrop" in row)));
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
  editPrefab(prefabName, { scaleX: 3 });
  const scaled = generateSceneClass(store.project, store.scene!);
  const scaledLinked = scaled
    .split("\n")
    .slice(scaled.split("\n").findIndex((l) => l.includes(`const ${linkedVar} = new`)));
  ok("a definition change is not re-emitted per instance (it lives in the class)",
     !scaledLinked.slice(0, 4).some((l) => l.includes("setScale(3")),
     scaledLinked.slice(0, 4).join(" | "));
  const cls = generatePrefabClass(store.project, prefabName);
  ok("the class carries the definition's scale instead", cls.includes("this.setScale(3"), cls);
  editPrefab(prefabName, { scaleX: 1 });

  // Animations: the class must not play before create() registers them.
  store.upsertAnim({ key: "spin", fps: 8, repeat: -1, frames: [{ textureKey: "obj-coin", frame: "__BASE" }] });
  editPrefab(prefabName, { playOnSpawn: "spin" });
  const withAnim = generateSceneClass(store.project, store.scene!);
  const animClass = generatePrefabClass(store.project, prefabName);
  ok("the prefab constructor does not play the animation", !/this\.play\(/.test(animClass));
  ok("the scene plays it after anims.create",
     withAnim.lastIndexOf("this.anims.create") < withAnim.indexOf(".play(\"spin\")"));
  editPrefab(prefabName, { playOnSpawn: undefined });

  // A body-less prefab is not an arcade sprite.
  const plain = store.scene!.objects.find((o) => !o.prefab && !o.body && o.type !== "container");
  if (plain) {
    store.setSelection([plain.id]);
    store.createPrefab({ name: "Marker", objectId: plain.id, exposed: [] });
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
  ok("the optional SAMPLE art can be skipped",
     !noArt.writes.some((f) => f.rel.includes("hero_sheet")));
  ok("but the placeholder textures the manifest declares are always written",
     noArt.writes.some((f) => f.rel === "assets/placeholder-tiles.png") &&
       noArt.writes.some((f) => f.rel === "assets/shape-capsule.png"),
     noArt.writes.filter((f) => f.rel.startsWith("assets/")).map((f) => f.rel).join());

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
  ok("art is planned as binary, not as text", art.length >= 7, String(art.length));
  ok("every texture the exported scene loads exists on disk", (() => {
    const written = new Set(plan.writes.map((f) => f.rel));
    return plan.project.assets
      .filter((a) => a.generated)
      .every((a) => written.has(a.path));
  })(), plan.project.assets.filter((a) => a.generated).map((a) => a.path).join());

  // Script components need three things on disk: the base class, a compiler
  // that accepts the decorator, and something to read.
  ok("the scaffold writes the base class and a worked example",
     rels.includes("src/scripts/ScriptComponent.ts") &&
       rels.includes("src/scripts/PlayerController.ts"));
  ok("and a tsconfig that accepts @property",
     JSON.parse(plan.files.find((f) => f.rel === "tsconfig.json")!.contents).compilerOptions
       .experimentalDecorators === true);
  ok("the template's player prefab opens with behaviour already attached", (() => {
    const player = plan.project.prefabs.find((p) => p.name === "Player");
    return player?.root?.scripts?.[0]?.class === "PlayerController";
  })());
  ok("and every Player placed in the scene resolves it", (() => {
    const placed = plan.project.scenes[0].objects.find((o) => o.prefab === "Player");
    return !!placed && scriptsOf(resolveObject(plan.project, placed))[0]?.class === "PlayerController";
  })());
  ok("the starter prefabs are written as files of their own",
     rels.includes("src/prefabs/Player.prefab.json") &&
       rels.includes("src/prefabs/Pickup.prefab.json"),
     rels.filter((r) => r.startsWith("src/prefabs/")).join());
  ok("the generated scene constructs it",
     plan.files.find((f) => f.rel === "src/scenes/Level_01.ts")!.contents.includes(
       "new PlayerController()",
     ));
  const jsPlan = planScaffold({ ...base, language: "js" });
  ok("a javascript project lists the script files as skipped, not silently absent",
     !jsPlan.writes.some((f) => f.rel.startsWith("src/scripts/")) &&
       jsPlan.files.some((f) => f.rel === "src/scripts/ScriptComponent.ts" && f.skipped));
  const emptyPlan = planScaffold({ ...base, template: "empty" });
  ok("the empty template still gets the base class, with nothing attached",
     emptyPlan.writes.some((f) => f.rel === "src/scripts/ScriptComponent.ts") &&
       !emptyPlan.writes.some((f) => f.rel === "src/scripts/PlayerController.ts"));
}

// ------------------------------------------------------- script components
group("Script components — reading the code behind an object");
{
  const SOURCE = `import { ScriptComponent, property } from "./ScriptComponent";

export class PlayerController extends ScriptComponent {
  @property({ min: 0, max: 600 })
  moveSpeed = 180;

  @property()
  jumpVelocity = -420;

  @property({ label: "coyote time (ms)" })
  coyoteMs = 120;

  @property()
  doubleJump = false;

  @property({ type: "ref" })
  groundLayer = "Terrain";

  @property({ options: ["stone", "grass"] })
  clipSet = "stone";

  @property()
  onDeath = () => {};

  private grounded = false;   // not exposed

  update(dt) {
    this.grounded = this.probe(this.groundLayer, 8);
  }
}

abstract class Base extends ScriptComponent {
  @property()
  shared = 1;
}

export class Derived extends Base {}

class Helper extends ScriptComponent {}
`;

  const parsed = parseScriptFile("src/scripts/PlayerController.ts", SOURCE);
  const player = parsed.classes.find((c) => c.name === "PlayerController")!;
  const names = player.properties.map((p) => p.name);

  ok("only @property fields are exposed",
     names.join() === "moveSpeed,jumpVelocity,coyoteMs,doubleJump,groundLayer,clipSet,onDeath",
     names.join());
  ok("private fields stay private", !names.includes("grounded"));
  ok("methods are not read as fields", !names.includes("update"));

  const byName = (n: string) => player.properties.find((p) => p.name === n)!;
  ok("types are inferred from the initialiser",
     byName("moveSpeed").type === "number" && byName("doubleJump").type === "boolean",
     `${byName("moveSpeed").type}/${byName("doubleJump").type}`);
  ok("defaults come from the class, not from the scene",
     byName("moveSpeed").default === 180 && byName("jumpVelocity").default === -420);
  ok("min/max reach the inspector", byName("moveSpeed").min === 0 && byName("moveSpeed").max === 600);
  ok("a label overrides the field name", byName("coyoteMs").label === "coyote time (ms)");
  ok("an explicit type wins over inference", byName("groundLayer").type === "ref");
  ok("options make it an enum picker",
     byName("clipSet").type === "enum" && byName("clipSet").options?.join() === "stone,grass");
  ok("callbacks render read-only", byName("onDeath").type === "function" && byName("onDeath").codeOnly);

  // The drawer highlights declarations, so the lines have to be real.
  const declLine = SOURCE.split("\n").findIndex((l) => l.includes("@property({ min: 0, max: 600 })")) + 1;
  ok("the decorator's line is recorded for the source drawer",
     byName("moveSpeed").line === declLine && byName("moveSpeed").endLine === declLine + 1,
     `${byName("moveSpeed").line}/${byName("moveSpeed").endLine}`);

  const index = buildIndex([parsed]);
  const offered = attachableClasses(index).map((c) => c.name);
  ok("abstract and non-exported classes are indexed but not offered",
     offered.join() === "Derived,PlayerController", offered.join());
  ok("a subclass inherits its base's properties",
     propertiesOf(index, index.classes.find((c) => c.name === "Derived")!).map((p) => p.name).join() === "shared");

  const broken = parseScriptFile("src/scripts/Broken.ts", "export class Broken extends ScriptComponent {\n");
  ok("a file that does not close is reported, not thrown", !!broken.error, broken.error);

  const nested = parseScriptFile(
    "src/scripts/Nested.ts",
    `export class Nested extends ScriptComponent {\n  private table = { property: 1, min: 2 };\n}\n`,
  );
  ok("object literals inside a class are not read as declarations",
     nested.classes[0].properties.length === 0);

  const adjacent = parseScriptFile(
    "src/scripts/Two.ts",
    `export class First extends ScriptComponent {\n  @property()\n  a = 1;\n}\nexport class Second extends ScriptComponent {\n  @property\n  b = 2;\n\n  tick() {}\n}\n`,
  );
  ok("two classes with no blank line between them stay apart", (() => {
    const [first, second] = adjacent.classes;
    return (
      adjacent.classes.length === 2 &&
      first.properties.map((p) => p.name).join() === "a" &&
      second.properties.map((p) => p.name).join() === "b"
    );
  })(), adjacent.classes.map((c) => `${c.name}:${c.properties.map((p) => p.name)}`).join(" "));

  const notAComponent = buildIndex([
    parseScriptFile("src/util/Vec.ts", "export class Vec {\n  @property()\n  x = 0;\n}\n"),
  ]);
  ok("a class that does not extend ScriptComponent is never offered",
     attachableClasses(notAComponent).length === 0);

  // The Project panel lists script files, and only script files.
  const projectIndex = buildIndex([
    parsed,
    parseScriptFile("src/main.ts", "const game = 1;\nexport default game;\n"),
    parseScriptFile("src/scenes/Level_01.ts", "export class Level_01 extends Phaser.Scene {}\n"),
    parseScriptFile("src/scripts/fx/Shake.ts", "export class Shake extends ScriptComponent {}\n"),
  ]);
  const listed = componentFiles(projectIndex).map((f) => f.src);
  ok("the project's script files are listed, in path order",
     listed.join() === "src/scripts/fx/Shake.ts,src/scripts/PlayerController.ts", listed.join());
  ok("a scene class or a plain module is not a script file",
     !listed.some((f) => f.includes("main.ts") || f.includes("Level_01")), listed.join());
  // Third-party projects are not written in Mosaic's brace style, and the
  // parser used to lose the entire class body when they were not.
  const allman = parseScriptFile(
    "Door.js",
    [
      "export default class Door extends Phaser.GameObjects.Container",
      "{",
      "    constructor (name, scene, x, y)",
      "    {",
      "        super(scene, x, y);",
      "    }",
      "}",
    ].join("\n"),
  );
  ok("a class with its brace on the next line is read, not discarded",
     allman.classes.length === 1 && allman.classes[0].name === "Door",
     JSON.stringify(allman.classes.map((c) => c.name)));
  ok("its constructor signature is read as written, not assumed",
     allman.classes[0]?.ctorParams?.join() === "name,scene,x,y",
     JSON.stringify(allman.classes[0]?.ctorParams));
  ok("and `export default` is recorded, because it changes the import",
     allman.classes[0]?.isDefault === true);

  const wrapped = parseScriptFile(
    "W.ts",
    "export class W {\n  constructor(\n    scene: Phaser.Scene,\n    opts = { a: 1, b: 2 },\n  ) {}\n}\n",
  );
  ok("parameters that wrap lines and carry object defaults still split cleanly",
     wrapped.classes[0]?.ctorParams?.join() === "scene,opts",
     JSON.stringify(wrapped.classes[0]?.ctorParams));

  const noCtor = parseScriptFile("N.ts", "export class N extends Phaser.Scene {}\n");
  ok("a class with no constructor says so, rather than claiming zero parameters",
     noCtor.classes[0]?.ctorParams === null);

  ok("the panel lists every component a file declares, attachable or not", (() => {
    const file = componentFiles(projectIndex).find((f) => f.src.endsWith("PlayerController.ts"))!;
    // PlayerController, Base (abstract), Derived, Helper (not exported) — all
    // four are components; only two of them can be attached.
    return file.classes.length === 4 && file.components.length === 4;
  })());

  ok("the stub and the sample both parse as what they claim to be", (() => {
    const stub = parseScriptFile(scriptFilePath("Enemy"), scriptStub("Enemy"));
    const sample = parseScriptFile(scriptFilePath("PlayerController"), samplePlayerController());
    return (
      stub.classes[0]?.name === "Enemy" &&
      stub.classes[0].properties.length === 2 &&
      sample.classes[0]?.properties.length === 4
    );
  })());
  ok("a typed name becomes a class name", toClassName("player controller") === "PlayerController");
}

group("Script components — the scene stores values, the class stores fields");
{
  store.activateScene("Level_01");
  const objId = store.scene!.objects.find((o) => o.prefab === "Player")!.id;
  // Undo replaces the scene object wholesale, so the object is looked up by id
  // every time rather than held across an edit.
  const live = () => store.scene!.objects.find((o) => o.id === objId)!;
  const classes = () => store.scriptsFor(live()).map((s) => s.class).join();
  const cls = { name: "PlayerController", src: "src/scripts/PlayerController.ts" };
  const other = { name: "HealthComponent", src: "src/scripts/HealthComponent.ts" };

  store.setSelection([objId]);
  store.attachScript([objId], cls);
  ok("attaching writes {class, src, enabled, props}", (() => {
    const ref = store.scriptsFor(live())[0];
    return ref.class === "PlayerController" && ref.src === cls.src && ref.enabled === true;
  })());

  store.attachScript([objId], other);
  store.moveScript(objId, 1, -1);
  ok("order is execution order, and reordering rewrites it",
     classes() === "HealthComponent,PlayerController", classes());

  store.setScriptProp(objId, 1, "moveSpeed", 220);
  ok("a value is written into the scene, not into the class",
     store.scriptsFor(live())[1].props.moveSpeed === 220);

  store.setScriptEnabled(objId, 1, false);
  ok("disabling keeps the values", (() => {
    const ref = store.scriptsFor(live())[1];
    return ref.enabled === false && ref.props.moveSpeed === 220;
  })());

  store.undo();
  ok("each script edit is one undo", store.scriptsFor(live())[1].enabled === true);

  store.clearScriptProp(objId, 1, "moveSpeed");
  ok("clearing a value falls back to the class default",
     !("moveSpeed" in store.scriptsFor(live())[1].props));

  store.attachScript([objId], cls);
  ok("the same class twice is allowed",
     store.scriptsFor(live()).filter((s) => s.class === "PlayerController").length === 2);

  store.detachScript(objId, 2);
  store.detachScript(objId, 0);
  ok("detaching removes exactly one row", classes() === "PlayerController", classes());

  const missing = store.validate().filter((i) => i.message.includes("PlayerController"));
  ok("without an index there is nothing to validate against", missing.length === 0);
}

group("Script components — prefab defines, instance overrides");
{
  const objId = store.scene!.objects.find((o) => o.prefab === "Player")!.id;
  store.unpackInstance(objId);
  store.setSelection([objId]);
  const prefab = store.createPrefab({
    name: "ScriptedPlayer",
    objectId: objId,
    exposed: ["scripts.0.props.moveSpeed"],
  })!;
  ok("the prefab definition carries the scripts", (prefab.root!.scripts ?? []).length === 1);

  const instance = store.scene!.objects.find((o) => o.prefab === "ScriptedPlayer")!;
  ok("the instance resolves its list from the definition", store.scriptsFor(instance).length === 1);
  editPrefab("ScriptedPlayer", { "scripts.0.props.jumpVelocity": -500 });
  ok("editing the definition reaches every instance",
     store.scriptsFor(instance)[0].props.jumpVelocity === -500);

  store.setScriptProp(instance.id, 0, "moveSpeed", 220);
  ok("a value edit on an instance records an override, not an edit to the prefab",
     instance.overrides?.["scripts.0.props.moveSpeed"] === 220 &&
       (prefab.root!.scripts?.[0].props.moveSpeed === undefined),
     JSON.stringify(instance.overrides));
  ok("and resolution puts it back on top of the definition",
     store.scriptsFor(instance)[0].props.moveSpeed === 220);

  store.revertOverride(instance.id, "scripts.0.props.moveSpeed");
  ok("reverting drops the override and the prefab's value shows through",
     store.scriptsFor(instance)[0].props.moveSpeed === undefined);

  store.setScriptEnabled(instance.id, 0, false);
  ok("enabled state is overridable per instance",
     instance.overrides?.["scripts.0.enabled"] === false && store.scriptsFor(instance)[0].enabled === false);

  store.attachScript([instance.id], { name: "FootstepAudio", src: "src/scripts/FootstepAudio.ts" });
  ok("a structural change makes the instance own the whole list",
     Array.isArray(instance.overrides?.scripts) &&
       (instance.overrides!.scripts as unknown[]).length === 2,
     JSON.stringify(Object.keys(instance.overrides ?? {})));
  ok("and the per-value overrides are folded in rather than applied twice",
     !Object.keys(instance.overrides ?? {}).some((k) => k.startsWith("scripts.")),
     Object.keys(instance.overrides ?? {}).join());
  ok("the prefab is untouched by any of it", (prefab.root!.scripts ?? []).length === 1);

  store.applyInstanceToPrefab(instance.id);
  ok("apply pushes the instance's list up into the definition",
     (store.project.prefabs.find((p) => p.name === "ScriptedPlayer")!.root!.scripts ?? []).length === 2);
  store.deletePrefab("ScriptedPlayer");
}

group("Prefabs are files — the folder round trip");
{
  // Everything so far lives only in the store. A prefab is a file, so it has
  // to survive being written out and read back with nothing lost.
  const store2 = new ProjectStore();
  const objId = store2.scene!.objects.find((o) => o.prefab === "Pickup")!.id;
  store2.unpackInstance(objId);
  store2.createPrefab({ name: "Trinket", objectId: objId, exposed: ["data.value"] });
  store2.createVariant("Trinket", "Trinket_Rare");
  store2.openPrefab("Trinket_Rare");
  store2.setObjectProp(store2.prefabDoc!.rootId, "scaleX", 1.5, "Set scale");
  store2.pushPrefabSave();
  store2.closePrefab(true);

  const files = projectToFiles(store2.project);
  const prefabFiles = files.filter((f) => f.rel.startsWith("src/prefabs/"));
  ok("each prefab is written as its own file",
     prefabFiles.length === store2.project.prefabs.length,
     prefabFiles.map((f) => f.rel).join());
  ok("the base file carries the tree",
     !!JSON.parse(prefabFiles.find((f) => f.rel.endsWith("Trinket.prefab.json"))!.contents).root);
  {
    const variant = JSON.parse(
      prefabFiles.find((f) => f.rel.endsWith("Trinket_Rare.prefab.json"))!.contents,
    );
    ok("the variant file carries a base and a diff, not a second tree",
       !variant.root && variant.base === "Trinket" && Object.keys(variant.diff).join() === "scaleX",
       JSON.stringify(variant));
  }

  const manifest = JSON.parse(files.find((f) => f.rel === MANIFEST_PATH)!.contents);
  ok("the manifest records which file each prefab is authored in",
     manifest.prefabs.every((p: { file?: string }) => !!p.file),
     JSON.stringify(manifest.prefabs.map((p: { file?: string }) => p.file)));
  ok("and carries the definitions too, because it is the runtime's payload", (() => {
    // A game importing the manifest has no filesystem to go and read the
    // per-prefab files with; an index of filenames left every instance in the
    // scene unresolvable.
    const base = manifest.prefabs.find((p: { name: string }) => p.name === "Trinket");
    const variant = manifest.prefabs.find((p: { name: string }) => p.name === "Trinket_Rare");
    return !!base?.root && variant?.base === "Trinket" && !!variant?.diff;
  })(), JSON.stringify(manifest.prefabs.map((p: { name: string }) => p.name)));

  const reopened = projectFromSource(
    {
      root: "/smoke",
      manifest: files.find((f) => f.rel === MANIFEST_PATH)!.contents,
      config: files.find((f) => f.rel === CONFIG_PATH)!.contents,
      scenes: files.filter((f) => f.rel.endsWith(".scene.json")),
      prefabs: prefabFiles,
      assets: [],
    },
    "smoke",
    (rel) => rel,
  );
  ok("reopening the folder finds every prefab",
     reopened.project.prefabs.length === store2.project.prefabs.length,
     reopened.project.prefabs.map((p) => p.name).join());
  ok("and the variant still resolves through its base",
     resolvePrefab(reopened.project, "Trinket_Rare")!.root.scaleX === 1.5);
  ok("local ids survive the round trip",
     resolvePrefab(reopened.project, "Trinket")!.root.lid ===
       resolvePrefab(store2.project, "Trinket")!.root.lid);

  // A folder written by an older build kept definitions in the manifest.
  const legacy = projectFromSource(
    {
      root: "/smoke",
      manifest: JSON.stringify({ ...manifest, prefabs: store2.project.prefabs }),
      config: files.find((f) => f.rel === CONFIG_PATH)!.contents,
      scenes: files.filter((f) => f.rel.endsWith(".scene.json")),
      prefabs: [],
      assets: [],
    },
    "smoke",
    (rel) => rel,
  );
  ok("a folder with inlined definitions still opens",
     legacy.project.prefabs.length === store2.project.prefabs.length);
  ok("and says the definitions are being moved into files",
     legacy.issues.some((i) => i.includes("own file")), legacy.issues.join(" | "));

  // Opening a folder that holds art but nothing of ours scaffolds a starter.
  // The art still belongs to the project: it used to be skipped on the way in
  // and only noticed on the NEXT open, which made the first open silently
  // lossy and the manifest it wrote disagree with the disk.
  const dropped = projectFromSource(
    // Art only: no source here, so this folder is still ours to scaffold into.
    { root: "/smoke", manifest: null, config: null, scenes: [], prefabs: [],
      assets: [{ rel: "assets/hero.png", bytes: 128 }], occupied: false },
    "dropped-art",
    (rel) => rel,
  );
  ok("a folder with art but no project of ours is scaffolded", dropped.scaffolded);
  ok("and being art-only, it is still written straight away", dropped.deferWrite === false);

  // Opening somebody's Phaser repo used to drop five files into it and show a
  // starter scene where their game should be. A project Mosaic cannot read is
  // indistinguishable from an empty folder at this point, so the folder itself
  // has to say whether anything is already there.
  const occupied = projectFromSource(
    { root: "/smoke", manifest: null, config: null, scenes: [], prefabs: [], assets: [],
      occupied: true },
    "bank panic",
    (rel) => rel,
  );
  ok("someone else's codebase still gets a starter to look at", occupied.scaffolded === true);
  ok("but every write to it is held back", occupied.deferWrite === true);
  ok("and it says nothing was written, rather than failing silently",
     occupied.issues.some((i) => i.includes("WITHOUT writing anything")), occupied.issues.join(" | "));
  ok("the editor still gets a usable scene rather than opening blank",
     occupied.project.scenes.length > 0 && occupied.project.name === "bank panic");

  ok("and the art on disk comes in with it, on the FIRST open",
     dropped.project.assets.some((a) => a.path === "assets/hero.png" && !a.generated),
     dropped.project.assets.map((a) => a.key).join());
  ok("the placeholders are still there beside it",
     dropped.project.assets.filter((a) => a.generated).length > 0);

  // The scaffold writes a manifest immediately, so reopening must reconcile
  // that art against itself rather than mint a second key for the same file.
  const reopenedScaffold = projectFromSource(
    { root: "/smoke", manifest: JSON.stringify(toManifest(dropped.project)), config: null,
      scenes: projectToFiles(dropped.project).filter((f) => f.rel.endsWith(".scene.json")),
      // The scaffold's save writes the prefab files too, so the reopen has to
      // be handed them — passing none would exercise the legacy inline path
      // instead of the one this is about.
      prefabs: projectToFiles(dropped.project).filter((f) => f.rel.endsWith(".prefab.json")),
      assets: [{ rel: "assets/hero.png", bytes: 128 }] },
    "dropped-art",
    (rel) => rel,
  );
  ok("reopening it keeps one key for the one file, not two",
     reopenedScaffold.project.assets.filter((a) => a.path === "assets/hero.png").length === 1,
     reopenedScaffold.project.assets.map((a) => a.key).join());
  ok("and reports nothing missing from disk", reopenedScaffold.issues.length === 0,
     reopenedScaffold.issues.join(" | "));
}

group("Binding an import to the project's own classes");
{
  const known = [
    { name: "Door", src: "Door.js", isDefault: true, ctorParams: ["name", "scene", "x", "y"] },
    { name: "Snowman", src: "Snowman.js", isDefault: true, ctorParams: ["scene", "track", "size"] },
    { name: "Ghost", src: "Ghost.js", isDefault: false, ctorParams: null },
  ];
  const out = sceneFromRecording(
    {
      sceneKey: "MainGame",
      settings: { canvas: { w: 800, h: 600 } },
      anims: [],
      loads: [],
      objects: [
        obj({ kind: "Door", name: "Door1", x: 144, y: 352 }),
        obj({ kind: "Door", name: "Door2", x: 388, y: 352 }),
        obj({ kind: "Image", parent: "Door1", texture: "assets", frame: "doorBackground" }),
        obj({ kind: "Snowman", x: 80, y: 196, texture: "sprites", frame: "s0" }),
      ],
    },
    known,
  );

  const door = out.prefabCandidates.find((c) => c.className === "Door")!;
  ok("a class whose constructor a snapshot CAN satisfy is bound", !!door.bound, JSON.stringify(door));
  ok("bound to the module it is actually declared in, as a default export",
     door.bound?.module === "Door.js" && door.bound.export === "default");
  ok("and its real signature is carried, not a presumed (scene, x, y)",
     door.bound?.params.join() === "name,scene,x,y", JSON.stringify(door.bound?.params));

  const snowman = out.prefabCandidates.find((c) => c.className === "Snowman")!;
  ok("a constructor wanting things a snapshot cannot know is NOT bound", !snowman.bound);
  ok("and it says which parameters stopped it",
     snowman.blockedBy?.join() === "track,size", JSON.stringify(snowman.blockedBy));
  ok("that refusal is surfaced rather than silently downgraded",
     out.issues.some((i) => i.includes("Snowman takes track, size")), out.issues.join(" | "));

  ok("a prefab is created for the bound class only",
     out.prefabs.map((p) => p.name).join() === "Door", out.prefabs.map((p) => p.name).join());
  ok("its instances point at it", (() => {
    const doors = out.scene.objects.filter((o) => o.prefab === "Door");
    return doors.length === 2;
  })(), JSON.stringify(out.scene.objects.map((o) => `${o.name}:${o.prefab ?? "-"}`)));
  ok("the unbound one stays a plain sprite, still importable",
     out.scene.objects.some((o) => o.texture === "sprites" && !o.prefab));
  ok("children the class builds for itself are not ALSO placed by the scene", (() => {
    // Door's constructor adds its own background; importing it twice would
    // draw it twice and leave an orphan the prefab does not own.
    return !out.scene.objects.some((o) => o.frame === "doorBackground");
  })(), JSON.stringify(out.scene.objects.map((o) => o.name)));
}

group("Export constructs the project's own class");
{
  const proj = createStarterProject();
  proj.prefabs.push({
    name: "Door",
    exposed: [],
    source: { module: "Door.js", export: "default", params: ["name", "scene", "x", "y"] },
    root: { lid: "d1", name: "Door", type: "sprite", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
            originX: 0.5, originY: 0.5, visible: true, data: {}, children: [] },
  });
  const scene = proj.scenes[0];
  const layer = scene.layers.find((l) => l.kind === "object")!;
  scene.objects.push({
    id: "door-1", name: "Door1", type: "container", layerId: layer.id, parentId: null,
    x: 144, y: 352, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
    visible: true, prefab: "Door", data: {},
  });

  const files = generateFiles(proj, scene, "tsSceneClass");
  const sceneFile = files.find((f) => f.path.includes("scenes/"))!.contents;

  ok("the scene imports the project's own module, not a generated lookalike",
     sceneFile.includes('import Door from "../../Door.js";'),
     sceneFile.split("\n").filter((l) => l.startsWith("import")).join(" | "));
  ok("and constructs it with the signature that class actually declares",
     sceneFile.includes('new Door("Door1", this, 144, 352)'),
     sceneFile.split("\n").find((l) => l.includes("new Door")) ?? "(no call)");
  ok("no class file is written over the one the project already owns",
     !files.some((f) => f.path === "src/prefabs/Door.ts"),
     files.map((f) => f.path).join());

  // A bound prefab is frequently a Container with no texture of its own; the
  // guards that ask "is there anything to draw" must not eat it.
  ok("a textureless container instance is still emitted, because its class draws it",
     (sceneFile.match(/new Door\(/g) ?? []).length === 1);

  // An unbound prefab keeps the old behaviour exactly.
  proj.prefabs.push({
    name: "Plain", exposed: [],
    root: { lid: "p1", name: "Plain", type: "sprite", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
            originX: 0.5, originY: 0.5, visible: true, texture: shapeTextureKey("box"), data: {}, children: [] },
  });
  scene.objects.push({
    id: "plain-1", name: "Plain1", type: "sprite", layerId: layer.id, parentId: null,
    x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
    visible: true, prefab: "Plain", data: {},
  });
  const files2 = generateFiles(proj, scene, "tsSceneClass");
  const scene2 = files2.find((f) => f.path.includes("scenes/"))!.contents;
  ok("an unbound prefab is still generated and constructed as (scene, x, y)",
     scene2.includes("new Plain(this, 10, 20)") &&
     files2.some((f) => f.path === "src/prefabs/Plain.ts"),
     scene2.split("\n").find((l) => l.includes("new Plain")) ?? "(no call)");
}

group("The project's source, as the panel sees it");
{
  // A project written before Mosaic has no ScriptComponent anywhere, and the
  // panel that only listed those showed an empty list beside a folder full of
  // code — which read as "the editor found nothing".
  const phaserProject = buildIndex([
    parseScriptFile("Boot.js", "export default class Boot extends Phaser.Scene\n{\n  create () {}\n}\n"),
    parseScriptFile("Door.js", "export default class Door extends Phaser.GameObjects.Container\n{\n  constructor (name, scene, x, y) {}\n}\n"),
  ]);

  ok("the component list is empty for a project with no components",
     componentFiles(phaserProject).length === 0);
  ok("but the source inventory has every file", sourceFiles(phaserProject).length === 2,
     sourceFiles(phaserProject).map((f) => f.src).join());
  ok("with the classes in them, so the panel can say what each one is", (() => {
    const door = sourceFiles(phaserProject).find((f) => f.src === "Door.js")!;
    return door.classes.length === 1 && door.classes[0].name === "Door" &&
      door.classes[0].base === "Phaser.GameObjects.Container";
  })());
  ok("and it reports none of them as attachable, because none are",
     sourceFiles(phaserProject).every((f) => f.components.length === 0));

  // A Mosaic project keeps the old answer exactly.
  const mosaicProject = buildIndex([
    parseScriptFile("src/scripts/Patrol.ts", "export class Patrol extends ScriptComponent {}\n"),
    parseScriptFile("src/main.ts", "const game = 1;\nexport default game;\n"),
  ]);
  ok("a Mosaic project still lists its components as before",
     componentFiles(mosaicProject).map((f) => f.src).join() === "src/scripts/Patrol.ts");
  ok("while the inventory also shows the file that declares nothing at all",
     sourceFiles(mosaicProject).length === 2 &&
     sourceFiles(mosaicProject).some((f) => f.src === "src/main.ts"),
     sourceFiles(mosaicProject).map((f) => f.src).join());
  // The entry point that constructs the game usually declares no class, and it
  // is the file RUN needs most.
  ok("a file with no classes is listed, with none, rather than omitted",
     sourceFiles(mosaicProject).find((f) => f.src === "src/main.ts")?.classes.length === 0);
}

group("Choosing which file starts the game");
{
  // findGameEntries lives in the main process, but the ordering it applies is
  // the thing that decides what RUN does by default, so the rule is pinned
  // here against the shapes real projects have.
  const rank = (rel: string): number => {
    const base = rel.split("/").pop() ?? rel;
    const stem = base.replace(/\.\w+$/, "").toLowerCase();
    if (stem === "main") return 0;
    if (stem === "index") return 1;
    if (stem === "game") return 2;
    return 3;
  };
  const order = (rels: string[]): string[] =>
    [...rels].sort(
      (a, b) => rank(a) - rank(b) || a.split("/").length - b.split("/").length || a.localeCompare(b),
    );

  ok("a conventional entry wins over one that merely sorts earlier",
     order(["built-main.js", "main.js"])[0] === "main.js",
     order(["built-main.js", "main.js"]).join());
  ok("and over one nearer the root, because the name is the stronger signal",
     order(["alt.js", "src/main.js"])[0] === "src/main.js",
     order(["alt.js", "src/main.js"]).join());
  ok("shallower wins when neither name is conventional",
     order(["deep/nested/boot.js", "boot.js"])[0] === "boot.js");
  ok("the order is total, so the default never depends on directory listing order",
     order(["b.js", "a.js"]).join() === "a.js,b.js");
}

group("One binding plan, two consumers");
{
  // The exporter turns a plan into source text; the play-test turns the same
  // plan into values. If those ever disagreed the editor would show one thing
  // and the shipped game would do another, so both go through bindArgs.
  const plan = bindArgs(["name", "scene", "x", "y"])!;
  ok("a satisfiable signature yields a plan", !!plan && plan.length === 4);
  ok("filled in the order the constructor declares", (() => {
    const values = boundArgValues(plan, {
      scene: "SCENE", x: 144, y: 352, name: "Door1", texture: "assets", frame: "door1",
    });
    return JSON.stringify(values) === JSON.stringify(["Door1", "SCENE", 144, 352]);
  })(), JSON.stringify(boundArgValues(plan, {
    scene: "SCENE", x: 144, y: 352, name: "Door1", texture: "assets", frame: "door1",
  })));

  const sheet = bindArgs(["scene", "x", "y", "key", "frame"])!;
  ok("key and frame map to the texture the instance draws with", (() => {
    const values = boundArgValues(sheet, {
      scene: "S", x: 1, y: 2, name: "n", texture: "atlas", frame: "hero",
    });
    return JSON.stringify(values) === JSON.stringify(["S", 1, 2, "atlas", "hero"]);
  })());

  ok("an unsatisfiable signature yields no plan at all", bindArgs(["scene", "track", "size"]) === null);
  ok("and names exactly what it could not fill",
     unbindableParams(["scene", "track", "size"]).join() === "track,size");
}

group("Exporting into a scene the project already owns");
{
  const proj = createStarterProject();
  proj.prefabs.push({
    name: "Door", exposed: [],
    source: { module: "Door.js", export: "default", params: ["name", "scene", "x", "y"] },
    root: { lid: "d2", name: "Door", type: "sprite", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
            originX: 0.5, originY: 0.5, visible: true, data: {}, children: [] },
  });
  const scene = proj.scenes[0];
  const layer = scene.layers.find((l) => l.kind === "object")!;
  scene.objects.push({
    id: "d-1", name: "Door1", type: "container", layerId: layer.id, parentId: null,
    x: 144, y: 352, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
    visible: true, prefab: "Door", data: {},
  });

  const mod = generateFiles(proj, scene, "tsSceneModule").find((f) => f.path.endsWith(".objects.ts"))!;

  ok("the module form does not declare a Phaser.Scene of its own",
     !mod.contents.includes("extends Phaser.Scene"),
     mod.contents.split("\n").find((l) => l.includes("class")) ?? "(no class)");
  ok("it exports a builder the project's own create() can call",
     mod.contents.includes("export function build") && mod.contents.includes("export function preload"));
  ok("the bodies are invoked with the caller's scene as `this`",
     mod.contents.includes("buildBody.call(host)"));
  ok("so the emitted lines are the same ones the class form uses, unrewritten",
     mod.contents.includes('new Door("Door1", this, 144, 352)'),
     mod.contents.split("\n").find((l) => l.includes("new Door")) ?? "(no call)");
  ok("the maps are attached to that scene, so `this.objects` resolves",
     mod.contents.includes("host.objects ??= {}"));
  ok("and there is no update() — the project's scene owns its own loop",
     !mod.contents.includes("update(_time"));

  // The class form must be untouched by all of this.
  const cls = generateFiles(proj, scene, "tsSceneClass").find((f) => f.path.endsWith("Scene.ts"))!;
  ok("the owning form still emits a Scene subclass with its own update()",
     cls.contents.includes("extends Phaser.Scene") && cls.contents.includes("update(_time"));
  ok("and both forms construct the bound class identically",
     cls.contents.includes('new Door("Door1", this, 144, 352)'));

  // An atlas is two files and the generated loader names both.
  const atlasProj = createStarterProject();
  atlasProj.assets.push({
    id: "asset-sheet", key: "sheet", kind: "atlas", path: "assets/sheet.png", url: "",
    width: 128, height: 64,
    frames: [{ name: "hero", x: 0, y: 0, w: 32, h: 32, pivotX: 0.5, pivotY: 0.5 }],
  });
  const atlasScene = atlasProj.scenes[0];
  atlasScene.objects.push({
    id: "a-1", name: "Hero", type: "sprite", layerId: atlasScene.layers.find((l) => l.kind === "object")!.id,
    parentId: null, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
    visible: true, texture: "sheet", frame: "hero", data: {},
  });
  const atlasFiles = generateFiles(atlasProj, atlasScene, "tsSceneClass");
  const sidecar = atlasFiles.find((f) => f.path === "assets/sheet.atlas.json");
  ok("an atlas's sidecar JSON is written, not just referenced", !!sidecar,
     atlasFiles.map((f) => f.path).join());
  ok("in the JSON-hash shape Phaser's loader reads", (() => {
    if (!sidecar) return false;
    const json = JSON.parse(sidecar.contents);
    const f = json.frames?.hero;
    return f?.frame?.w === 32 && json.meta?.size?.w === 128;
  })(), sidecar?.contents.slice(0, 90));
}

group("Importing into a project that already has one");
{
  const base = createStarterProject();
  const imported = sceneFromRecording({
    sceneKey: "MainGame",
    settings: { canvas: { w: 800, h: 600 }, gameBackgroundColor: "#2e91f3" },
    anims: [{ key: "idle", frameRate: 8, repeat: -1, frames: [{ textureKey: "a", frame: "i0" }] }],
    loads: [{ method: "image", args: ["hero", "hero.png"], path: "art/" }],
    textures: [{ key: "hero", width: 32, height: 32, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", frames: [] }],
    objects: [obj({ kind: "Sprite", name: "Hero", x: 10, y: 20, texture: "hero" })],
  });

  const notes = applyImport(base, imported);
  ok("the imported scene is ADDED, never swapped in for what was there",
     base.scenes.length === 2 && base.scenes.some((s) => s.key === "Level_01"),
     base.scenes.map((s) => s.key).join());
  ok("its animations come with it", base.anims.some((a) => a.key === "idle"));
  ok("and its assets do too", base.assets.some((a) => a.key === "hero"), base.assets.map((a) => a.key).join());
  ok("the notes say what was added", notes.some((n) => n.includes("asset reference")), notes.join(" | "));
  ok("the captured art comes along as files to write",
     imported.files.some((f) => f.rel === "assets/imported/hero.png"), imported.files.map((f) => f.rel).join());

  // Importing the same scene twice is a thing people do — usually after
  // editing the game and wanting the new version beside the old one.
  const again = applyImport(base, imported);
  ok("importing the same scene twice keeps both", base.scenes.length === 3,
     base.scenes.map((s) => s.key).join());
  ok("the second gets a fresh key rather than clobbering the first",
     new Set(base.scenes.map((s) => s.key)).size === 3, base.scenes.map((s) => s.key).join());
  ok("and it says so", again.some((n) => n.includes("already taken")), again.join(" | "));
  ok("assets and anims are not duplicated on the way in",
     base.assets.filter((a) => a.key === "hero").length === 1 &&
     base.anims.filter((a) => a.key === "idle").length === 1);
}

group("Script components — export wires them up");
{
  const scene = store.scene!;
  const objId = store.addObject({
    type: "sprite",
    name: "Hero",
    x: 64,
    y: 64,
    texture: shapeTextureKey("capsule"),
    data: {},
  })!;
  const obj = scene.objects.find((o) => o.id === objId)!;
  store.transact("smoke: scripts for codegen", () => {
    obj.scripts = [
      { class: "PlayerController", src: "src/scripts/PlayerController.ts", enabled: true, props: { moveSpeed: 220 } },
      { class: "PlayerController", src: "src/scripts/fx/PlayerController.ts", enabled: true, props: {} },
      { class: "FootstepAudio", src: "src/scripts/FootstepAudio.ts", enabled: false, props: {} },
    ];
  });

  const code = generateSceneClass(store.project, store.scene!);
  ok("the host is constructed once per scene", code.split("new ScriptHost(this)").length === 2);
  ok("the base class is imported from the project's own source",
     code.includes('import { ScriptHost } from "../scripts/ScriptComponent";'), code.slice(0, 400));
  ok("values authored in the editor are passed to the constructor",
     code.includes('this.scripts.add(hero, new PlayerController(), { "moveSpeed": 220 });'), code);
  ok("a disabled script is still constructed, and says so",
     code.includes('new FootstepAudio(), {}, false)'), code);
  ok("two classes of one name are imported under distinct aliases",
     code.includes("PlayerController as PlayerController2") &&
       code.includes("new PlayerController2()"), code);
  ok("a scene without scripts carries no host", (() => {
    const bare = store.project.scenes.find((s) => s.key !== store.activeSceneKey);
    return bare ? !generateSceneClass(store.project, bare).includes("ScriptHost") : true;
  })());

  store.transact("smoke: clear scripts", () => {
    delete obj.scripts;
  });
}

// ---------------------------------------------------------------- app icon
group("Identity — the app icon is the mark");
{
  const size = 512;
  const icon = mosaicIconBitmap(size);
  ok("the icon is square and fully opaque",
     icon.width === size && icon.height === size && icon.data.length === size * size * 4);

  const rgb = (x: number, y: number) => pixelAt(icon, x, y).slice(0, 3).join();
  ok("the field is the one permitted filled field", rgb(4, 4) === FIELD.join(), rgb(4, 4));

  // The mark occupies the middle 47%; unit u of the 26-unit grid maps here.
  const scale = (size * (242 / 512)) / 26;
  const origin = (size - 26 * scale) / 2;
  const at = (u: number) => Math.round(origin + u * scale);

  ok("every set tile is drawn reversed on it",
     SET_TILES.every(([x, y]) => rgb(at(x + 4), at(y + 4)) === REVERSED.join()),
     SET_TILES.map(([x, y]) => rgb(at(x + 4), at(y + 4))).join(" | "));

  // The two open tiles are outlines: mark on the edge, field in the middle.
  const open = openTilesFor(size)!;
  ok("the open tiles are outlined, not filled",
     rgb(at(13), at(13)) === FIELD.join() && rgb(at(13), at(22)) === FIELD.join(),
     `${rgb(at(13), at(13))} / ${rgb(at(13), at(22))}`);
  ok("and their stroke is on the cell boundary the ladder puts it on",
     rgb(at(open.inset), at(13)) === REVERSED.join(), rgb(at(open.inset), at(13)));

  ok("the icon is drawn from the same geometry the UI draws", (() => {
    // A cell the mark leaves empty must be field, or the two have diverged.
    return rgb(at(13), at(13)) === FIELD.join() && SET_TILES.length === 7;
  })());

  const tinted = mosaicIconBitmap(64, { field: REVERSED, mark: FIELD });
  ok("the palette is a parameter, not a constant",
     pixelAt(tinted, 2, 2).slice(0, 3).join() === REVERSED.join());
}

group("Importing a hand-written Phaser scene");
{
  // A genuine excerpt of a recording taken from the Phaser examples' "snowmen
  // attack" — a project written with no thought of this editor. Every value
  // below came off the real snapshot: the pooled snowballs it parks at the
  // origin, the full-screen overlay that legitimately sits there too, the
  // atlas frame names, and a loader that pulls everything from a CDN.
  const rec: Recording = {
    sceneKey: "MainGame",
    settings: {
      // What an untouched camera really reports: valid black, at alpha 0.
      backgroundColor: "#000000",
      backgroundColorAlpha: 0,
      gameBackgroundColor: "rgba(51,102,178,1)",
      canvas: { w: 1024, h: 768 },
      worldBounds: { w: 1024, h: 768 },
      gravityY: 0,
    },
    anims: [
      { key: "idle", frameRate: 8, repeat: -1, yoyo: true,
        frames: [0, 1, 2, 3].map((n) => ({ textureKey: "sprites", frame: `idle00${n}` })) },
      { key: "die", frameRate: 24, repeat: 0,
        frames: [{ textureKey: "sprites", frame: "die000" }] },
    ],
    loads: [
      { method: "image", args: [["background", "overlay", "title"]],
        path: "assets/games/snowmen-attack/", baseURL: "https://cdn.phaserfiles.com/v385" },
      { method: "atlas", args: ["sprites", "sprites.png", "sprites.json"],
        path: "assets/games/snowmen-attack/", baseURL: "https://cdn.phaserfiles.com/v385" },
      { method: "glsl", args: ["snow", "snow.frag"], path: "assets/games/snowmen-attack/" },
      { method: "audio", args: ["music", ["music.ogg", "music.m4a", "music.mp3"]],
        path: "assets/games/snowmen-attack/sounds/" },
    ],
    // What the loader actually resolved. This is the half that survives a CDN
    // base URL — the paths above never existed on this machine.
    textures: [
      { key: "background", width: 1024, height: 768, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", frames: [] },
      { key: "sprites", width: 1007, height: 955, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", frames: [
        { name: "idle000", x: 0, y: 0, w: 48, h: 96, pivotX: 0.5, pivotY: 0.5 },
        { name: "snowman-big-idle0", x: 48, y: 0, w: 64, h: 64, pivotX: 0.5, pivotY: 0.5 },
      ] },
    ],
    objects: [
      obj({ kind: "Image", x: 512, y: 384, texture: "background" }),
      // Visible, and parked exactly where the pool is. It is content.
      obj({ kind: "Image", x: 0, y: 0, texture: "overlay" }),
      obj({ kind: "Snowman", x: -100, y: 196, depth: 1, texture: "sprites",
            frame: "snowman-big-idle0", anim: "snowmanIdleBig",
            body: { w: 64, h: 64, immovable: true, allowGravity: false, collideWorldBounds: false } }),
      obj({ kind: "Snowman", x: 80, y: 196, depth: 1, texture: "sprites", frame: "snowman-small-idle0" }),
      obj({ kind: "Player", x: 900, y: 196, depth: 2, texture: "sprites", frame: "idle000", anim: "idle",
            body: { w: 48, h: 96, immovable: false, allowGravity: false, collideWorldBounds: true, bounceX: 0.2 } }),
      obj({ kind: "Text", x: 140, y: 2, depth: 3, texture: "72cc4a33-uuid-canvas", text: "0" }),
      // The pool: switched off, waiting to be thrown.
      ...Array.from({ length: 6 }, () =>
        obj({ kind: "PlayerSnowball", x: 0, y: 0, visible: false, texture: "sprites", frame: "snowball2" })),
    ],
  };

  const out = sceneFromRecording(rec);
  const names = out.scene.objects.map((o) => o.name);

  ok("the object pool is left out", out.scene.objects.length === 6, names.join());
  ok("and says so rather than dropping them silently",
     out.issues.some((i) => i.includes("6 hidden object")), out.issues.join(" | "));
  ok("a VISIBLE object at the origin is kept — it is an overlay, not a pooled one",
     out.scene.objects.some((o) => o.texture === "overlay"), names.join());

  ok("distinct depths become distinct layers", out.scene.layers.length === 4,
     out.scene.layers.map((l) => l.name).join());
  ok("and each object lands on the layer its depth named", (() => {
    const player = out.scene.objects.find((o) => o.texture === "sprites" && o.frame === "idle000")!;
    const depth2 = out.scene.layers[out.scene.layers.findIndex((l) => l.name === "Depth 2")];
    return player.layerId === depth2.id;
  })());

  // Nothing in this project ever calls setName().
  ok("unnamed objects are named after the class they were built from",
     names.some((n) => n.startsWith("Snowman")) && names.some((n) => n.startsWith("Player")), names.join());
  ok("and the names are unique, because they key the scene's objects map",
     new Set(names).size === names.length, names.join());

  const text = out.scene.objects.find((o) => o.type === "text")!;
  ok("a Text object keeps its content", text.text?.content === "0");
  ok("and NOT the uuid canvas Phaser minted for it", text.texture === undefined, String(text.texture));

  ok("the scene falls back to the game config's colour when the camera has none",
     out.scene.settings.backgroundColor === "#3366b2", out.scene.settings.backgroundColor);

  const player = out.scene.objects.find((o) => o.frame === "idle000")!;
  ok("bodies come across with their real measured size",
     player.body?.width === 48 && player.body?.height === 96, JSON.stringify(player.body));
  ok("and the animation that was playing becomes playOnSpawn", player.playOnSpawn === "idle");

  ok("animations import whole", (() => {
    const idle = out.anims.find((a) => a.key === "idle")!;
    return idle.fps === 8 && idle.repeat === -1 && idle.yoyo === true && idle.frames.length === 4 &&
      idle.frames[0].textureKey === "sprites" && idle.frames[0].frame === "idle000";
  })(), JSON.stringify(out.anims[0]));

  const keys = out.assets.map((a) => a.key);
  ok("only assets whose pixels were captured come across",
     keys.sort().join() === "background,sprites", keys.join());
  ok("their bytes come with them, as files to write",
     out.files.length === 2 && out.files.every((f) => f.rel.startsWith("assets/imported/") && f.base64.length > 0),
     out.files.map((f) => f.rel).join());
  ok("and the asset points at where those bytes will land, not at the CDN path it came from",
     out.assets.find((a) => a.key === "background")?.path === "assets/imported/background.png",
     out.assets.find((a) => a.key === "background")?.path);
  ok("a texture with several frames is an atlas, and keeps them", (() => {
    const sprites = out.assets.find((a) => a.key === "sprites");
    return sprites?.kind === "atlas" && sprites.frames?.length === 2 &&
      sprites.frames[0].name === "idle000" && sprites.width === 1007;
  })(), JSON.stringify(out.assets.find((a) => a.key === "sprites")));
  // Audio has no equivalent of reading a texture back, so it cannot be brought.
  ok("audio is NOT imported as a reference to a file that will never exist",
     !keys.includes("music"), keys.join());
  ok("and that is said out loud rather than left as a broken manifest entry",
     out.issues.some((i) => i.includes("no bytes to bring across")), out.issues.join(" | "));
  ok("a loader call with no Mosaic equivalent is skipped, not faked", !keys.includes("snow"), keys.join());

  // Bank panic's `Door` is a Container subclass holding three children. Typing
  // a container by its class name misses every one of those.
  const nested = sceneFromRecording({
    sceneKey: "MainGame",
    settings: { canvas: { w: 1024, h: 768 } },
    anims: [],
    loads: [],
    objects: [
      obj({ kind: "Door", name: "Door1", x: 144, y: 352 }),
      obj({ kind: "Image", parent: "Door1", texture: "assets", frame: "doorBackground" }),
      obj({ kind: "Sprite", parent: "Door1", texture: "assets", frame: "door1" }),
      obj({ kind: "Container", name: "Empty", x: 10, y: 10 }),
    ],
  });
  ok("a Container SUBCLASS is typed as a container, not a textureless sprite",
     nested.scene.objects.find((o) => o.name === "Door1")?.type === "container",
     nested.scene.objects.find((o) => o.name === "Door1")?.type);
  ok("Phaser's own Container still is too, even with nothing inside it",
     nested.scene.objects.find((o) => o.name === "Empty")?.type === "container");
  ok("and its children hang off it by id", (() => {
    const door = nested.scene.objects.find((o) => o.name === "Door1")!;
    const kids = nested.scene.objects.filter((o) => o.parentId === door.id);
    return kids.length === 2;
  })(), nested.scene.objects.map((o) => `${o.name}:${o.parentId ?? "-"}`).join());

  ok("project classes are offered as prefabs, Phaser's own types are not", (() => {
    const named = out.prefabCandidates.map((c) => `${c.className}:${c.count}`);
    return named.includes("Snowman:2") && named.includes("Player:1") &&
      !out.prefabCandidates.some((c) => c.className === "Image" || c.className === "Text");
  })(), out.prefabCandidates.map((c) => `${c.className}:${c.count}`).join());
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
