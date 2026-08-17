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

  console.log(failures === 0 ? "\nDesktop end-to-end passed" : `\n${failures} desktop check(s) failed`);
  app.exit(failures === 0 ? 0 : 1);
}
