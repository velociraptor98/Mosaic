import { BrowserWindow, app } from "electron";
import { mosaicIcon } from "./appIcon";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The desktop end-to-end check behind `npm run smoke:app`.
 *
 * Boots the real shell, drives the real renderer, and asserts against the real
 * filesystem: open a folder, scaffold it, save, then edit a scene file from
 * outside and confirm the watcher brings the change in. Exits non-zero on the
 * first failure so it can gate CI.
 */

let failures = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evaluate<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>;
}

export async function runSmoke(win: BrowserWindow): Promise<void> {
  const root = await fs.mkdtemp(path.join(app.getPath("temp"), "mosaic-smoke-"));
  console.log(`\nDesktop end-to-end (${root})`);

  try {
    ok("the shell exposes the preload bridge", await evaluate(win, "!!window.mosaic?.isElectron"));
    ok("it opens on the launcher, not the editor", await evaluate(win, '!!document.querySelector(".launcher")'));

    // --- open an empty folder: it should scaffold and write itself out ---
    const opened = await evaluate<boolean>(
      win,
      `window.mosaicDebug.workspace.open({ root: ${JSON.stringify(root)}, name: "smoke" })`,
    );
    ok("an empty folder opens", opened);
    await wait(600);

    const manifestRaw = await fs.readFile(path.join(root, "phaser.editor.json"), "utf8").catch(() => null);
    ok("it scaffolds phaser.editor.json on disk", manifestRaw !== null);

    const sceneFiles = await fs.readdir(path.join(root, "src/scenes")).catch(() => []);
    ok("it writes the scene files", sceneFiles.some((f) => f.endsWith(".scene.json")), sceneFiles.join());
    ok("the editor replaced the launcher", await evaluate(win, '!!document.querySelector(".app-body")'));

    const sceneFile = sceneFiles.find((f) => f.endsWith(".scene.json"))!;
    const scenePath = path.join(root, "src/scenes", sceneFile);

    // --- an edit in the renderer must land on disk ---
    await evaluate(
      win,
      `(() => { const s = window.mosaicDebug.store;
        s.transact("smoke rename", () => { s.scene.name = "Renamed By Test"; }); })()`,
    );
    await wait(900);
    const afterEdit = JSON.parse(await fs.readFile(scenePath, "utf8"));
    ok("an editor change is saved to the scene file", afterEdit.name === "Renamed By Test", afterEdit.name);

    // --- an edit on disk must come back into the editor ---
    afterEdit.name = "Renamed On Disk";
    afterEdit.settings.gravityY = 1234;
    await fs.writeFile(scenePath, JSON.stringify(afterEdit, null, 2));
    await wait(2600); // watcher debounce + read

    const reloaded = await evaluate<string>(win, "window.mosaicDebug.store.scene.name");
    ok("an external edit is picked up by the watcher", reloaded === "Renamed On Disk", reloaded);
    const gravity = await evaluate<number>(win, "window.mosaicDebug.store.scene.settings.gravityY");
    ok("the reloaded scene carries the external values", gravity === 1234, String(gravity));

    // --- assets are served over mosaic:// rather than inlined ---
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(path.join(root, "assets", "probe.png"), png);
    await wait(2600);
    const probe = await evaluate<string | null>(
      win,
      `(window.mosaicDebug.store.project.assets.find(a => a.path === "assets/probe.png")?.url ?? null)`,
    );
    ok("art dropped into assets/ appears in the project", !!probe, String(probe));
    ok("assets resolve to mosaic://, not data:", !!probe && probe.startsWith("mosaic://asset/"), String(probe));

    const fetched = await evaluate<number>(
      win,
      `fetch(${JSON.stringify("")} + window.mosaicDebug.store.project.assets.find(a => a.path === "assets/probe.png").url)
         .then(r => r.status).catch(() => -1)`,
    );
    ok("the asset protocol serves the bytes", fetched === 200, `status ${fetched}`);

    // Percent-encoded so the traversal survives URL normalisation and actually
    // reaches the containment check in the protocol handler.
    const sampleUrl = await evaluate<string>(
      win,
      `window.mosaicDebug.platform.assetUrl(${JSON.stringify(root)}, "x")`,
    );
    const encodedRoot = sampleUrl.split("/")[3];
    const escapeUrl = `mosaic://asset/${encodedRoot}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`;
    const escaped = await evaluate<number>(
      win,
      `fetch(${JSON.stringify(escapeUrl)}).then(r => r.status).catch(() => -1)`,
    );
    ok("a path escaping the project root is refused", escaped === 403, `status ${escaped}`);

    // --- script components: the index, the watcher, and Create script… ---
    await fs.mkdir(path.join(root, "src/scripts"), { recursive: true });
    const patrolPath = path.join(root, "src/scripts/Patrol.ts");
    await fs.writeFile(
      patrolPath,
      `import { ScriptComponent, property } from "./ScriptComponent";

export class Patrol extends ScriptComponent {
  @property({ min: 0, max: 400 })
  speed = 60;

  @property()
  pingPong = true;
}
`,
    );
    await wait(2600); // watcher debounce + re-index

    const indexed = await evaluate<{ name: string; props: number } | null>(
      win,
      `(() => {
         const cls = window.mosaicDebug.workspace.scripts.attachable().find(c => c.name === "Patrol");
         return cls ? { name: cls.name, props: cls.properties.length } : null;
       })()`,
    );
    ok("a class written into src/ is indexed by the watcher", indexed?.name === "Patrol", JSON.stringify(indexed));
    ok("its @property declarations come with it", indexed?.props === 2, JSON.stringify(indexed));

    // A PLAIN object: attaching to a prefab instance is a different path —
    // the reference lands in the instance's overrides — and that is covered by
    // the headless suite. This is the "script on an ordinary object" case.
    const attachedRef = await evaluate<{
      id: string;
      class: string;
      src: string;
      enabled: boolean;
    } | null>(
      win,
      `(() => {
         const s = window.mosaicDebug.store;
         const id = s.addObject({
           type: "sprite", name: "Patroller", x: 64, y: 64,
           texture: s.project.assets.find(a => a.generated && a.key.startsWith("shape-")).key,
           data: {},
         });
         const cls = s.scriptIndex.attachable().find(c => c.name === "Patrol");
         s.attachScript([id], cls);
         s.setScriptProp(id, 0, "speed", 120);
         const ref = s.scriptsFor(s.scene.objects.find(o => o.id === id))[0];
         return { id, class: ref.class, src: ref.src, enabled: ref.enabled };
       })()`,
    );
    ok("attaching records the class and the file it was found in",
       attachedRef?.class === "Patrol" && attachedRef.src === "src/scripts/Patrol.ts",
       JSON.stringify(attachedRef));

    await wait(1200);
    const savedScene = JSON.parse(await fs.readFile(scenePath, "utf8"));
    const savedPatroller = savedScene.objects?.find(
      (o: { id: string }) => o.id === attachedRef?.id,
    );
    ok("the reference and its value are saved into the scene file", (() => {
      const script = savedPatroller?.scripts?.[0];
      return script?.class === "Patrol" && script.props.speed === 120;
    })(), JSON.stringify(savedPatroller?.scripts));

    // An external edit to the class re-indexes; it must not touch the values.
    await fs.writeFile(
      patrolPath,
      `import { ScriptComponent, property } from "./ScriptComponent";

export class Patrol extends ScriptComponent {
  @property({ min: 0, max: 400 })
  speed = 60;

  @property()
  pingPong = true;

  @property({ label: "wait at the end (ms)" })
  dwellMs = 250;
}
`,
    );
    await wait(2600);
    const afterReindex = await evaluate<{ props: number; speed: unknown; label: string | null }>(
      win,
      `(() => {
         const w = window.mosaicDebug.workspace;
         const cls = w.scripts.attachable().find(c => c.name === "Patrol");
         const props = w.scripts.properties(cls);
         const s = window.mosaicDebug.store;
         return {
           props: props.length,
           speed: s.scriptsFor(s.scene.objects.find(o => o.name === "Patroller"))[0].props.speed,
           label: props.find(p => p.name === "dwellMs")?.label ?? null,
         };
       })()`,
    );
    ok("editing the class refreshes the field list in place", afterReindex.props === 3, JSON.stringify(afterReindex));
    ok("and leaves the values the scene authored alone", afterReindex.speed === 120, JSON.stringify(afterReindex));
    ok("a label written in the decorator survives the round trip",
       afterReindex.label === "wait at the end (ms)", String(afterReindex.label));

    const created = await evaluate<string | null>(
      win,
      `window.mosaicDebug.workspace.scripts.create("Chaser").then(c => c ? c.src : null)`,
    );
    ok("Create script… writes a file and indexes it", created === "src/scripts/Chaser.ts", String(created));
    const chaserSource = await fs.readFile(path.join(root, "src/scripts/Chaser.ts"), "utf8").catch(() => "");
    ok("the stub it writes extends ScriptComponent",
       chaserSource.includes("export class Chaser extends ScriptComponent"), chaserSource.slice(0, 80));
    ok("and the base class is written beside it the first time",
       await exists(path.join(root, "src/scripts/ScriptComponent.ts")));
    const offersChaser = await evaluate<boolean>(
      win,
      `window.mosaicDebug.workspace.scripts.attachable().some(c => c.name === "Chaser")`,
    );
    ok("the new class is immediately attachable", offersChaser);

    // --- the play-test actually runs the project's code ---
    const observable = (version: number) => `import { ScriptComponent, property } from "./ScriptComponent";

export class Patrol extends ScriptComponent {
  @property({ min: 0, max: 400 })
  speed = 60;

  create(): void {
    const probe = (globalThis as Record<string, unknown>).__mosaicSmoke = { version: ${version}, ticks: 0, speed: 0, created: true } as Record<string, unknown>;
    probe.speed = this.speed;
  }

  update(dt: number): void {
    void dt;
    const probe = (globalThis as Record<string, unknown>).__mosaicSmoke as Record<string, number>;
    if (probe) probe.ticks += 1;
  }
}
`;
    await fs.writeFile(patrolPath, observable(1));
    await wait(2600);

    const trust = await evaluate<{ before: boolean; after: boolean }>(
      win,
      `(() => {
         const d = window.mosaicDebug;
         const root = d.workspace.location.root;
         const before = d.playtest.needsTrust();
         d.scriptTrust.trustRoot(root);
         return { before, after: d.playtest.needsTrust() };
       })()`,
    );
    ok("a scene with behaviour asks before running someone's code", trust.before);
    ok("and stops asking once the project is trusted", !trust.after);

    await evaluate(win, "window.mosaicDebug.playtest.start()");
    await wait(2500); // compile + a few frames

    const ran = await evaluate<{ created: boolean; ticks: number; speed: number; playing: boolean }>(
      win,
      `(() => {
         const probe = globalThis.__mosaicSmoke ?? {};
         return {
           created: !!probe.created,
           ticks: probe.ticks ?? 0,
           speed: probe.speed ?? 0,
           playing: window.mosaicDebug.playtest.playing,
         };
       })()`,
    );
    ok("the project's script compiles and its create() runs", ran.created, JSON.stringify(ran));
    ok("and update() is driven every frame", ran.ticks > 0, JSON.stringify(ran));
    ok("the value authored in the editor reaches the live instance, not the class default",
       ran.speed === 120, JSON.stringify(ran));
    ok("the scene is still playing", ran.playing);

    // Editing the source under a running scene restarts it on the new code.
    await fs.writeFile(patrolPath, observable(2));
    await wait(4000);
    const hotReloaded = await evaluate<{ version: number; ticks: number; playing: boolean }>(
      win,
      `(() => {
         const probe = globalThis.__mosaicSmoke ?? {};
         return {
           version: probe.version ?? 0,
           ticks: probe.ticks ?? 0,
           playing: window.mosaicDebug.playtest.playing,
         };
       })()`,
    );
    ok("editing a script while playing recompiles and restarts it", hotReloaded.version === 2,
       JSON.stringify(hotReloaded));
    ok("the restarted scene is running the new code", hotReloaded.ticks > 0, JSON.stringify(hotReloaded));
    ok("and the transport never stopped", hotReloaded.playing);

    // A file that does not compile keeps the run alive on the last good build.
    await fs.writeFile(patrolPath, observable(3).replace("update(dt: number): void {", "update(dt: number): void {{{"));
    await wait(4000);
    const broken = await evaluate<{ status: string; error: string; version: number; playing: boolean; classes: number }>(
      win,
      `(() => {
         const r = window.mosaicDebug.workspace.scriptRuntime;
         return {
           status: r.status,
           error: (r.error ?? "").slice(0, 80),
           version: globalThis.__mosaicSmoke?.version ?? 0,
           playing: window.mosaicDebug.playtest.playing,
           classes: Object.keys(r.classes).length,
         };
       })()`,
    );
    ok("a script that does not compile is reported", broken.status === "error" && !!broken.error,
       JSON.stringify(broken));
    ok("the running scene is left alone on the last good build",
       broken.playing && broken.version === 2, JSON.stringify(broken));
    ok("and the last good classes are kept, not emptied", broken.classes > 0, JSON.stringify(broken));

    await evaluate(win, "window.mosaicDebug.playtest.stop()");
    await fs.writeFile(patrolPath, observable(4));
    await wait(2600);

    // The panel itself has to render what all of that produced.
    const panel = await evaluate<{ rows: number; head: string; badge: string | null }>(
      win,
      `(async () => {
         const s = window.mosaicDebug.store;
         s.setSelection([s.scene.objects.find(o => o.name === "Patroller").id]);
         s.setUi({ inspectorTab: "scripts", leftTab: "outliner" });
         await new Promise(r => setTimeout(r, 150));
         const row = document.querySelector(".script-row");
         return {
           rows: document.querySelectorAll(".script-row").length,
           head: row ? row.querySelector(".cls").textContent : "",
           badge: document.querySelector(".outliner-row .script-badge")?.textContent ?? null,
         };
       })()`,
    );
    ok("the Scripts panel renders a row per attached script", panel.rows === 1, JSON.stringify(panel));
    ok("the row names the class", panel.head === "Patrol", panel.head);
    ok("the outliner badges the object with its script count", panel.badge === "1", String(panel.badge));

    const tree = await evaluate<{ rows: string[]; badge: string | null; opened: string | null }>(
      win,
      `(async () => {
         const s = window.mosaicDebug.store;
         s.setUi({ leftTab: "project" });
         await new Promise(r => setTimeout(r, 150));
         const rows = [...document.querySelectorAll(".tree-row")]
           .map(r => r.textContent)
           .filter(t => t.includes("scripts/"));
         const row = [...document.querySelectorAll(".tree-row")]
           .find(r => r.textContent.includes("Patrol.ts"));
         const badge = row?.querySelector(".git-badge")?.textContent ?? null;
         row?.click();
         await new Promise(r => setTimeout(r, 150));
         const opened = s.ui.sourceView?.src ?? null;
         return { rows, badge, opened };
       })()`,
    );
    ok("the Project panel lists the project's script files",
       tree.rows.some((r) => r.includes("scripts/Patrol.ts")), JSON.stringify(tree.rows));
    ok("each row names the classes it declares",
       tree.rows.some((r) => r.includes("Patrol")), JSON.stringify(tree.rows));
    ok("and reports how many objects run them", tree.rows.some((r) => r.includes("1×")), JSON.stringify(tree.rows));
    ok("clicking one opens it read-only", tree.opened === "src/scripts/Patrol.ts", String(tree.opened));

    const drawer = await evaluate<{ lines: number; highlighted: number }>(
      win,
      `(async () => {
         window.mosaicDebug.store.setUi({ sourceView: { src: "src/scripts/Patrol.ts", className: "Patrol" } });
         await new Promise(r => setTimeout(r, 150));
         return {
           lines: document.querySelectorAll(".source-drawer .source-line").length,
           highlighted: document.querySelectorAll(".source-drawer .source-line.hl").length,
         };
       })()`,
    );
    ok("View source opens the file read-only", drawer.lines > 5, JSON.stringify(drawer));
    // Patrol.ts is the observable build by now: one @property, so two lines —
    // the decorator and the field it annotates.
    ok("and highlights the @property declarations it is rendering",
       drawer.highlighted === 2, JSON.stringify(drawer));

    const picker = await evaluate<{ open: boolean; offers: number }>(
      win,
      `(async () => {
         document.querySelector(".scripts-panel .section-title .add").click();
         await new Promise(r => setTimeout(r, 150));
         const rows = document.querySelectorAll(".script-palette li").length;
         document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
         const open = !!document.querySelector(".script-palette");
         window.mosaicDebug.store.setUi({ sourceView: null });
         return { open, offers: rows };
       })()`,
    );
    ok("+ Add opens the attach picker", picker.open, JSON.stringify(picker));
    ok("and it offers the classes the project actually has", picker.offers >= 2, JSON.stringify(picker));

    // --- prefabs: promote, isolate, expose, propagate ---
    // The whole point of this flow is that it reaches files nobody is looking
    // at, so it is checked against the FOLDER as well as against the store.
    const promoted = await evaluate<{
      wrote: boolean;
      instances: number;
      barText: string;
      docTab: string | null;
      onDisk: string | null;
    }>(
      win,
      `(async () => {
         const s = window.mosaicDebug.store;
         // Promotion starts from a PLAIN object, so this makes one rather than
         // reaching for whatever the template happened to place.
         const id = s.addObject({
           type: "sprite", name: "TurretSeed", x: 128, y: 128,
           texture: s.project.assets.find(a => a.generated && a.key.startsWith("shape-")).key,
           data: {},
         });
         const obj = s.scene.objects.find(o => o.id === id);
         s.setSelection([obj.id]);
         const made = s.createPrefab({
           name: "Turret",
           objectId: obj.id,
           exposed: ["data.value", "scaleX"],
         });
         s.openPrefab("Turret");
         await new Promise(r => setTimeout(r, 200));
         await window.mosaicDebug.workspace.saveNow();
         return {
           wrote: !!made,
           instances: window.mosaicDebug.store.project.scenes
             .flatMap(sc => sc.objects).filter(o => o.prefab === "Turret").length,
           barText: document.querySelector(".prefab-bar")?.textContent ?? "",
           docTab: document.querySelector(".doc-tab")?.textContent ?? null,
           onDisk: await window.mosaic.readText(
             window.mosaicDebug.workspace.location.root,
             "src/prefabs/Turret.prefab.json",
           ),
         };
       })()`,
    );
    ok("promoting a selection writes a definition", promoted.wrote);
    ok("and the object it was made from becomes its instance", promoted.instances === 1,
       String(promoted.instances));
    ok("the prefab is a real file in src/prefabs/", !!promoted.onDisk, String(promoted.onDisk));
    ok("the definition on disk carries the tree and the contract", (() => {
      if (!promoted.onDisk) return false;
      const def = JSON.parse(promoted.onDisk) as { root?: unknown; exposed?: string[]; };
      return !!def.root && (def.exposed ?? []).includes("data.value");
    })(), String(promoted.onDisk));
    ok("prefab edit mode says which document you are in",
       promoted.barText.includes("prefab edit mode") && promoted.barText.includes("Turret"),
       promoted.barText);
    ok("and the scene it was opened from is still a tab beside it",
       (promoted.docTab ?? "").includes("Turret.prefab"), String(promoted.docTab));

    const isolated = await evaluate<{ parts: number; exposed: number; locked: number }>(
      win,
      `(async () => {
         const s = window.mosaicDebug.store;
         s.setUi({ inspectorTab: "prefab" });
         await new Promise(r => setTimeout(r, 200));
         const seg = [...document.querySelectorAll(".segmented button")];
         const parts = document.querySelectorAll(".part-row").length;
         seg.find(b => b.textContent.startsWith("Expose"))?.click();
         await new Promise(r => setTimeout(r, 200));
         const exposed = document.querySelectorAll(".expose-row.on").length;
         s.closePrefab(true);
         s.setSelection([s.scene.objects.find(o => o.prefab === "Turret").id]);
         s.setUi({ inspectorTab: "object" });
         await new Promise(r => setTimeout(r, 200));
         return { parts, exposed, locked: document.querySelectorAll(".field.locked").length };
       })()`,
    );
    ok("the isolated stage holds the prefab and nothing else", isolated.parts >= 1,
       String(isolated.parts));
    ok("the Expose list shows the published fields as checked", isolated.exposed >= 2,
       String(isolated.exposed));
    ok("and a field the definition owns is locked on the instance, not hidden",
       isolated.locked > 0, String(isolated.locked));

    const pushed = await evaluate<{
      planned: boolean;
      rows: number;
      moved: number;
      kept: number;
      resolvedBefore: number;
      resolvedAfter: number;
      instanceValue: number;
    }>(
      win,
      `(async () => {
         const s = window.mosaicDebug.store;
         const inst = s.scene.objects.find(o => o.prefab === "Turret");
         s.setObjectProp(inst.id, "data.value", 7);

         s.openPrefab("Turret");
         s.setObjectProp(s.prefabDoc.rootId, "scaleX", 2.5, "Set scale");
         // Change the very field the instance claimed, so the panel has to
         // decide between the definition's value and the instance's.
         s.setObjectProp(s.prefabDoc.rootId, "data.value", 99, "Set value");
         const read = () => {
           const o = window.mosaicDebug.store.project.scenes
             .flatMap(sc => sc.objects).find(x => x.prefab === "Turret");
           return window.mosaicDebug.store.resolvePrefab("Turret") ? o.scaleX : -1;
         };
         const resolvedBefore = s.resolvePrefab("Turret").root.scaleX;

         s.planPrefabSave(window.mosaicDebug.workspace.writeBlockedReason);
         await new Promise(r => setTimeout(r, 200));
         const planned = !!document.querySelector(".propagate-rows");
         const rows = document.querySelectorAll(".propagate-row").length;
         const moved = s.ui.prefabPlan.totals.moved;
         const kept = s.ui.prefabPlan.totals.kept;

         [...document.querySelectorAll(".dialog footer button")]
           .find(b => b.textContent.trim() === "Push").click();
         await new Promise(r => setTimeout(r, 200));
         const resolvedAfter = s.resolvePrefab("Turret").root.scaleX;
         s.closePrefab(true);
         const after = s.scene.objects.find(o => o.prefab === "Turret");
         void read;
         return {
           planned, rows, moved, kept, resolvedBefore, resolvedAfter,
           instanceValue: after.overrides["data.value"],
         };
       })()`,
    );
    ok("saving a prefab shows what it costs before it writes", pushed.planned);
    ok("the panel lists every consequence", pushed.rows > 0, String(pushed.rows));
    ok("a value with no override moves", pushed.moved >= 1, String(pushed.moved));
    ok("and an override the instance set for itself is listed as kept, not overwritten",
       pushed.kept >= 1, String(pushed.kept));
    ok("the kept override still stands after the push", pushed.instanceValue === 7,
       String(pushed.instanceValue));
    ok("nothing moved until Push", pushed.resolvedBefore !== pushed.resolvedAfter,
       `${pushed.resolvedBefore} -> ${pushed.resolvedAfter}`);
    ok("and the definition holds the new value afterwards", pushed.resolvedAfter === 2.5,
       String(pushed.resolvedAfter));

    const variant = await evaluate<{ made: boolean; file: string | null; inherits: number }>(
      win,
      `(async () => {
         const s = window.mosaicDebug.store;
         const made = !!s.createVariant("Turret", "Turret_Heavy");
         s.openPrefab("Turret_Heavy");
         s.setObjectProp(s.prefabDoc.rootId, "scaleY", 3, "Set scale");
         s.pushPrefabSave();
         s.closePrefab(true);
         await window.mosaicDebug.workspace.saveNow();
         return {
           made,
           file: await window.mosaic.readText(
             window.mosaicDebug.workspace.location.root,
             "src/prefabs/Turret_Heavy.prefab.json",
           ),
           inherits: s.resolvePrefab("Turret_Heavy").root.scaleX,
         };
       })()`,
    );
    ok("a variant is created as its own file", variant.made && !!variant.file);
    ok("and it stores a base and a diff rather than a second copy", (() => {
      if (!variant.file) return false;
      const def = JSON.parse(variant.file) as { root?: unknown; base?: string; diff?: Record<string, unknown> };
      return !def.root && def.base === "Turret" && Object.keys(def.diff ?? {}).join() === "scaleY";
    })(), String(variant.file));
    ok("everything it did not claim still comes from the base", variant.inherits === 2.5,
       String(variant.inherits));

    // --- the stage keeps its shape whether or not a bar is showing ---
    // The prefab bar appears above the toolbar and disappears again. The dock
    // is a fixed height and the canvas takes the rest; a bar coming and going
    // must not resize either of them.
    const shape = await evaluate<{
      scene: Record<string, number>;
      doc: Record<string, number>;
      back: Record<string, number>;
      barInDoc: boolean;
      barInScene: boolean;
      docSurvivedReload: string | null;
    }>(
      win,
      `(async () => {
         const s = window.mosaicDebug.store;
         const h = (sel) => {
           const el = document.querySelector(sel);
           return el ? Math.round(el.getBoundingClientRect().height) : 0;
         };
         const probe = () => ({ toolbar: h(".toolbar"), canvas: h(".canvas-frame"), dock: h(".dock"), dockBody: h(".dock .panel-body") });

         const scene = probe();
         const barInScene = !!document.querySelector(".prefab-bar");

         s.openPrefab("Turret");
         await new Promise(r => setTimeout(r, 300));
         const doc = probe();
         const barInDoc = !!document.querySelector(".prefab-bar");

         // An external reload must put you back in the document you were in.
         await window.mosaicDebug.workspace.reload();
         await new Promise(r => setTimeout(r, 300));
         const docSurvivedReload = s.prefabDoc ? s.prefabDoc.name : null;

         s.closePrefab(true);
         await new Promise(r => setTimeout(r, 300));
         const back = probe();
         return { scene, doc, back, barInDoc, barInScene, docSurvivedReload };
       })()`,
    );
    ok("no prefab bar while a scene is the document", !shape.barInScene);
    ok("and one appears in prefab edit mode", shape.barInDoc);
    ok("the asset dock keeps its full height in a scene", shape.scene.dock === 232,
       JSON.stringify(shape.scene));
    ok("and the same height with the prefab bar showing", shape.doc.dock === 232,
       JSON.stringify(shape.doc));
    ok("the dock's body is the dock, minus its tabs — not collapsed",
       shape.scene.dockBody > 150, JSON.stringify(shape.scene));
    ok("the canvas takes the space the bar does not",
       shape.doc.canvas < shape.scene.canvas && shape.doc.canvas > 300,
       `${shape.scene.canvas} -> ${shape.doc.canvas}`);
    ok("and the stage returns to its original shape on the way out",
       shape.back.canvas === shape.scene.canvas && shape.back.dock === shape.scene.dock,
       JSON.stringify(shape.back));
    ok("reopening the folder puts you back in the prefab you were editing",
       shape.docSurvivedReload === "Turret", String(shape.docSurvivedReload));

    // --- window chrome: traffic lights and dragging ---
    const chrome = await evaluate<{
      isDesktop: boolean;
      isMac: boolean;
      menubarPadLeft: number;
      menubarHeight: number;
      menubarRegion: string;
      buttonRegion: string;
      lockupLeft: number;
    }>(
      win,
      `(() => {
         const bar = document.querySelector(".menubar");
         const btn = bar.querySelector("button");
         const lockup = bar.querySelector(".lockup");
         const cs = getComputedStyle(bar);
         return {
           isDesktop: document.documentElement.classList.contains("is-desktop"),
           isMac: document.documentElement.classList.contains("is-mac"),
           menubarPadLeft: parseFloat(cs.paddingLeft),
           menubarHeight: bar.getBoundingClientRect().height,
           menubarRegion: cs.getPropertyValue("-webkit-app-region") || cs.webkitAppRegion || "",
           buttonRegion: getComputedStyle(btn).getPropertyValue("-webkit-app-region") || "",
           lockupLeft: lockup.getBoundingClientRect().left,
         };
       })()`,
    );
    ok("the document is marked as desktop", chrome.isDesktop);
    ok("and as macOS, so the inset applies", chrome.isMac === (process.platform === "darwin"));
    ok("the menu bar is a drag region", chrome.menubarRegion.trim() === "drag", chrome.menubarRegion);
    ok("its buttons opt out, so they still click",
       chrome.buttonRegion.trim() === "no-drag", chrome.buttonRegion);
    if (process.platform === "darwin") {
      // Traffic lights sit at x=16 and span roughly 52px for three buttons.
      ok("the lockup clears the traffic lights", chrome.lockupLeft >= 80, `left ${chrome.lockupLeft}`);
      ok("the reserved inset is on the menu bar", chrome.menubarPadLeft >= 80, String(chrome.menubarPadLeft));
      ok("traffic lights are centred against the bar",
         Math.abs((chrome.menubarHeight - 12) / 2 - 14) < 6, `bar ${chrome.menubarHeight}px`);
    }

    // --- identity: the shell wears the mark, not Electron's default ---
    const icon = mosaicIcon(512);
    const iconSize = icon.getSize();
    ok("the app icon rasterises to a real image", !icon.isEmpty());
    ok("at the size the dock asks for", iconSize.width === 512 && iconSize.height === 512,
       JSON.stringify(iconSize));
    ok("and it round-trips as a PNG Electron can decode",
       icon.toPNG().length > 0 && icon.toPNG().subarray(1, 4).toString("ascii") === "PNG");

    // --- git status: quiet outside a repo, real inside one ---
    const git = await evaluate<Record<string, string>>(
      win,
      "window.mosaicDebug.platform.gitStatus(window.mosaicDebug.workspace.location.root)",
    );
    ok("git status returns cleanly on a non-repo folder", typeof git === "object" && Object.keys(git).length === 0);

    let repoReady = true;
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      await execFileAsync("git", ["add", "-A"], { cwd: root });
    } catch {
      repoReady = false;
    }
    if (repoReady) {
      await evaluate(win, "window.mosaicDebug.workspace.refreshGit()");
      await wait(400);
      const repoStatus = await evaluate<Record<string, string>>(win, "window.mosaicDebug.workspace.git");
      const sceneRel = `src/scenes/${sceneFile}`;
      ok("git status reports the project's files inside a repo", Object.keys(repoStatus).length > 0);
      ok("the scene file carries a status code", !!repoStatus[sceneRel], JSON.stringify(Object.keys(repoStatus).slice(0, 3)));
      const badge = await evaluate<string | null>(
        win,
        `(window.mosaicDebug.workspace.statusForScene(${JSON.stringify(sceneFile.replace(".scene.json", ""))}) ?? null)`,
      );
      ok("the Project panel can resolve a badge for that scene", !!badge, String(badge));
    } else {
      console.log("  · git unavailable, skipped repo checks");
    }

    // --- reopening the folder must reproduce the project ---
    await evaluate(win, "window.mosaicDebug.workspace.close()");
    await wait(200);
    const reopened = await evaluate<boolean>(
      win,
      `window.mosaicDebug.workspace.open({ root: ${JSON.stringify(root)}, name: "smoke" })`,
    );
    ok("the folder reopens", reopened);
    await wait(500);
    const roundTripped = await evaluate<string>(win, "window.mosaicDebug.store.scene.name");
    ok("export/import is a true round trip", roundTripped === "Renamed On Disk", roundTripped);
    const assetCount = await evaluate<number>(
      win,
      `window.mosaicDebug.store.project.assets.filter(a => a.path === "assets/probe.png").length`,
    );
    ok("the reopened project keeps its assets exactly once", assetCount === 1, String(assetCount));
  } catch (err) {
    failures += 1;
    console.log(`  ✗ threw: ${(err as Error).stack ?? err}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  await newProjectFlow(win);

  console.log(failures === 0 ? "\nDesktop end-to-end passed" : `\n${failures} desktop check(s) failed`);
  app.exit(failures === 0 ? 0 : 1);
}

/**
 * The New Project flow, driven against the real filesystem: plan a scaffold,
 * write it transactionally, open the result, and prove the rollback works.
 */
async function newProjectFlow(win: BrowserWindow): Promise<void> {
  const parent = await fs.mkdtemp(path.join(app.getPath("temp"), "mosaic-new-"));
  console.log(`\nNew project flow (${parent})`);

  try {
    await evaluate(win, "window.mosaicDebug.workspace.close()");
    await wait(200);

    // --- validation happens before anything is written ---
    const free = await evaluate<{ exists: boolean; writable: boolean; isEmpty: boolean }>(
      win,
      `window.mosaicDebug.platform.validateTarget(${JSON.stringify(parent)}, "skyward")`,
    );
    ok("a free target validates as writable and non-existent",
       free.writable && !free.exists, JSON.stringify(free));

    await fs.mkdir(path.join(parent, "taken"), { recursive: true });
    await fs.writeFile(path.join(parent, "taken", "something.txt"), "hi");
    const occupied = await evaluate<{ exists: boolean; isEmpty: boolean }>(
      win,
      `window.mosaicDebug.platform.validateTarget(${JSON.stringify(parent)}, "taken")`,
    );
    ok("a non-empty target is reported as such",
       occupied.exists && !occupied.isEmpty, JSON.stringify(occupied));

    const tools = await evaluate<{ node: string | null }>(
      win,
      "window.mosaicDebug.platform.toolchain()",
    );
    ok("the toolchain is detected", typeof tools === "object" && "node" in tools);

    // --- plan, then create ---
    const root = path.join(parent, "skyward");
    const created = await evaluate<{ ok: boolean; written: string[]; error?: string }>(
      win,
      `(async () => {
         const plan = window.mosaicDebug.planScaffold({
           ...window.mosaicDebug.DEFAULT_OPTIONS,
           name: "skyward",
           location: ${JSON.stringify(parent)},
         });
         return window.mosaicDebug.platform.scaffoldProject(
           plan.root,
           plan.writes.map(f => ({ rel: f.rel, contents: f.contents, encoding: f.encoding })),
         );
       })()`,
    );
    ok("the scaffold writes", created.ok, created.error ?? "");
    ok("it writes the whole plan", created.written.length >= 12, String(created.written.length));

    for (const rel of ["package.json", "mosaic.config.json", "src/scenes/Level_01.scene.json", "src/main.ts"]) {
      ok(`${rel} exists on disk`, await exists(path.join(root, rel)));
    }
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    ok("package.json is real JSON with the slug", pkg.name === "skyward");

    // Every texture the manifest declares has to exist on disk, or the
    // exported game loads nothing and renders a blank screen.
    const declared = JSON.parse(
      await fs.readFile(path.join(root, "phaser.editor.json"), "utf8"),
    ).assets.filter((a: { generated?: boolean }) => a.generated);
    const art: { path: string; png: Buffer | null }[] = [];
    for (const asset of declared) {
      art.push({
        path: asset.path,
        png: await fs.readFile(path.join(root, asset.path)).catch(() => null),
      });
    }
    ok("every placeholder the manifest declares exists on disk",
       art.length > 0 && art.every((a) => !!a.png),
       art.filter((a) => !a.png).map((a) => a.path).join() || "none missing");
    ok("and each is real PNG bytes",
       art.every((a) => a.png && a.png.subarray(1, 4).toString() === "PNG"),
       art.map((a) => `${a.path}:${a.png ? a.png.subarray(1, 4).toString() : "?"}`).join(" "));

    // --- transactional: a second create over the same folder rolls back ---
    const again = await evaluate<{ ok: boolean; error?: string }>(
      win,
      `window.mosaicDebug.platform.scaffoldProject(${JSON.stringify(root)}, [
         { rel: "package.json", contents: "{}" },
         { rel: "brand-new.txt", contents: "should not survive" },
       ])`,
    );
    ok("creating over existing files is refused", !again.ok, again.error ?? "");
    ok("and the refused write left nothing behind",
       !(await exists(path.join(root, "brand-new.txt"))));
    ok("the original file is untouched",
       JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).name === "skyward");

    // --- the created folder opens as a project ---
    const opened = await evaluate<boolean>(
      win,
      `window.mosaicDebug.workspace.open({ root: ${JSON.stringify(root)}, name: "skyward" })`,
    );
    ok("the created project opens", opened);
    await wait(500);
    const sceneKey = await evaluate<string>(win, "window.mosaicDebug.store.scene.key");
    ok("it opens on the template scene", sceneKey === "Level_01", sceneKey);
    const cfg = await evaluate<{ tile: number; scale: string }>(
      win,
      "window.mosaicDebug.store.project.config",
    );
    ok("mosaic.config.json round-trips into the store",
       cfg.tile === 32 && cfg.scale === "FIT", JSON.stringify(cfg));
    const layers = await evaluate<number>(win, "window.mosaicDebug.store.scene.layers.length");
    ok("the template scene is runnable — it has layers", layers >= 2, String(layers));

    // --- recents pick up the metadata the launcher shows ---
    const recents = await evaluate<{ name: string; scenes?: number; missing?: boolean }[]>(
      win,
      "window.mosaicDebug.platform.recents()",
    );
    ok("recents report scene counts", recents.some((r) => (r.scenes ?? 0) > 0), JSON.stringify(recents.slice(0, 2)));

    // --- the flow's UI mounts and steps ---
    await evaluate(win, "window.mosaicDebug.workspace.close()");
    await wait(300);
    ok("closing returns to the launcher", await evaluate(win, '!!document.querySelector(".launcher")'));
    ok("the launcher has a drag strip, so the window can still be moved",
       await evaluate(win, `(() => {
         const s = document.querySelector(".launcher-dragstrip");
         return !!s && getComputedStyle(s).getPropertyValue("-webkit-app-region").trim() === "drag";
       })()`));
    ok("the launcher shows recents with metadata",
       await evaluate(win, '!!document.querySelector(".recent-tags .tag-outline")'));

    // --- a long recents list scrolls; the window does not stretch ---
    // Someone who has opened forty folders should get the same launcher as
    // someone who has opened two.
    const longList = await evaluate<{
      added: number;
      cards: number;
      viewport: number;
      windowH: number;
      listH: number;
      listScrolls: boolean;
      overflowsViewport: boolean;
      actionsVisible: boolean;
      footnoteVisible: boolean;
    }>(
      win,
      `(async () => {
         // Stretch the list without touching the recents store: what is under
         // test is the layout under many cards, not how they got there.
         const list = document.querySelector(".recent-list");
         const seed = list.querySelector(".recent-card");
         const before = list.querySelectorAll(".recent-card").length;
         const clones = [];
         for (let i = 0; i < 39; i++) {
           const c = seed.cloneNode(true);
           c.dataset.clone = "1";
           list.appendChild(c);
           clones.push(c);
         }
         await new Promise(r => setTimeout(r, 200));

         const win_ = document.querySelector(".launcher-window");
         const actions = document.querySelector(".launcher-actions");
         const foot = document.querySelector(".launcher-recents .hint.mono");
         const winRect = win_.getBoundingClientRect();
         const listRect = list.getBoundingClientRect();
         const result = {
           added: document.querySelectorAll(".recent-card").length - before,
           cards: document.querySelectorAll(".recent-card").length,
           viewport: window.innerHeight,
           windowH: Math.round(winRect.height),
           listH: Math.round(listRect.height),
           listScrolls: list.scrollHeight > list.clientHeight + 1,
           overflowsViewport: Math.round(winRect.bottom) > window.innerHeight + 1,
           // The things that must stay reachable however long the list is.
           actionsVisible: actions.getBoundingClientRect().bottom <= window.innerHeight,
           footnoteVisible: foot.getBoundingClientRect().bottom <= window.innerHeight + 1,
         };
         for (const c of clones) c.remove();
         return result;
       })()`,
    );
    ok("a long recents list renders in full", longList.added === 39 && longList.cards >= 40,
       JSON.stringify(longList));
    ok("the list is taller than the space it has, so scrolling is what is being tested",
       longList.listH < longList.viewport, JSON.stringify(longList));
    ok("the launcher window still fits the viewport", !longList.overflowsViewport,
       JSON.stringify(longList));
    ok("the recents list is what scrolls", longList.listScrolls, JSON.stringify(longList));
    ok("New project… stays on screen", longList.actionsVisible, JSON.stringify(longList));
    ok("and so does the footnote under the list", longList.footnoteVisible,
       JSON.stringify(longList));

    await evaluate(win, 'document.querySelector(".launcher-actions button.primary").click()');
    await wait(300);
    ok("New project… opens the wizard", await evaluate(win, '!!document.querySelector(".wizard-window")'));
    ok("the wizard title bar is draggable",
       await evaluate(win, `getComputedStyle(document.querySelector(".wizard-titlebar")).getPropertyValue("-webkit-app-region").trim() === "drag"`));
    ok("it starts on the template step",
       await evaluate<number>(win, 'document.querySelectorAll(".tpl-card").length') === 4);
    ok("the step counter reads 1 of 4",
       (await evaluate<string>(win, 'document.querySelector(".wizard-meta").textContent')) === "step 1 of 4");

    const stepTo = async (label: string) => {
      await evaluate(
        win,
        `[...document.querySelectorAll(".wizard-window button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`,
      );
      await wait(250);
    };
    await stepTo("Continue");
    ok("continue reaches the details step",
       await evaluate(win, '!!document.querySelector(".wizard-rail .resolve")'));
    ok("validation renders while typing",
       await evaluate<number>(win, 'document.querySelectorAll(".check-row").length') === 4);

    /** React-controlled inputs need the native setter plus an input event. */
    const setInput = async (selector: string, value: string) => {
      await evaluate(
        win,
        `(() => {
           const el = document.querySelector(${JSON.stringify(selector)});
           const setter = Object.getOwnPropertyDescriptor(
             window.HTMLInputElement.prototype, "value",
           ).set;
           setter.call(el, ${JSON.stringify(value)});
           el.dispatchEvent(new Event("input", { bubbles: true }));
         })()`,
      );
      await wait(350);
    };

    const continueDisabled = () =>
      evaluate<boolean>(
        win,
        `[...document.querySelectorAll(".wizard-window button")]
           .find(b => b.textContent.trim() === "Continue").disabled`,
      );

    // Point at our temp parent so the flow never touches the user's folders.
    await setInput(".wizard-pane .field input", "smoke-target");
    await evaluate(
      win,
      `(() => {
         const inputs = document.querySelectorAll(".wizard-pane .field input");
         const setter = Object.getOwnPropertyDescriptor(
           window.HTMLInputElement.prototype, "value",
         ).set;
         setter.call(inputs[1], ${JSON.stringify(parent)});
         inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
       })()`,
    );
    await wait(400);
    ok("a free target enables Continue", !(await continueDisabled()));

    // A target that already holds something must block, not overwrite.
    await setInput(".wizard-pane .field input", "taken");
    ok("an occupied target disables Continue", await continueDisabled());
    ok("and says why", await evaluate(win, `!!document.querySelector(".check-row.warn")`));

    await setInput(".wizard-pane .field input", "smoke-target");
    ok("fixing the name re-enables it", !(await continueDisabled()));

    await stepTo("Continue");
    ok("then the scene defaults step",
       await evaluate(win, '!!document.querySelector(".canvas-preview")'));

    await stepTo("Continue");
    ok("then the review step, with the whole diff",
       await evaluate<number>(win, 'document.querySelectorAll(".file-row").length') > 12);
    ok("skipped files are listed struck through, not hidden",
       await evaluate(win, '!!document.querySelector(".file-row.skipped")'));
    ok("the generated scene is previewed",
       await evaluate<string>(win, 'document.querySelector(".code-preview").textContent').then((t) =>
         t.includes("class Level_01"),
       ));

    await evaluate(
      win,
      '[...document.querySelectorAll(".wizard-window button")].find(b => b.textContent.trim() === "Cancel" || b.textContent.trim() === "Back").click()',
    );
    await wait(200);

    await fs.rm(root, { recursive: true, force: true });
    const afterDelete = await evaluate<{ name: string; missing?: boolean }[]>(
      win,
      "window.mosaicDebug.platform.recents()",
    );
    ok("a deleted project greys out instead of vanishing",
       afterDelete.some((r) => r.missing), JSON.stringify(afterDelete.slice(0, 2)));
  } catch (err) {
    failures += 1;
    console.log(`  ✗ threw: ${(err as Error).stack ?? err}`);
  } finally {
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  }
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}
