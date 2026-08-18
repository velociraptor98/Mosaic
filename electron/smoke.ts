import { BrowserWindow, app } from "electron";
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

    const png = await fs.readFile(path.join(root, "assets/wire_32.png")).catch(() => null);
    ok("placeholder art is written as real PNG bytes",
       !!png && png.subarray(1, 4).toString() === "PNG", png ? png.subarray(0, 8).toString("hex") : "missing");

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
