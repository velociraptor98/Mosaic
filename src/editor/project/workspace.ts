import type { ProjectData } from "../../shared/types";
import {
  generateProjectFiles,
  prefabLayoutPath,
  sceneLayoutPath,
  type GeneratedFile,
  type Language,
} from "../export/generate";
import { setProjectRoot } from "../export/write";
import { propertiesOf } from "../scripts/parse";
import { platform } from "../platform";
import type { DiskFile, ProjectChange, ProjectLocation, RecentEntry } from "../platform/types";
import { ScriptRegistry } from "../scripts/registry";
import { SCRIPT_EXT } from "../../shared/scripts";
import type { ProjectStore } from "../store/project";
import { MAP_EXT, describeTiledMap, parseTiledMap, type TiledMap } from "../../shared/tiled";
import { uid, uniqueKey } from "../store/ids";
import { migratePaintedTileLayers } from "./tiledMigration";
import {
  CONFIG_PATH,
  MANIFEST_PATH,
  pendingTilemaps,
  projectFromSource,
  prefabPath,
  projectToFiles,
  scenePath,
} from "./serialize";

/**
 * Assets discovered on disk arrive without dimensions — the main process only
 * stats them. The tileset palette and the atlas slicer both need real pixel
 * sizes, so they are measured in the renderer before the project is handed to
 * the store.
 */
async function measureAssets(project: ProjectData): Promise<void> {
  await Promise.all(
    project.assets.map(
      (asset) =>
        new Promise<void>((resolve) => {
          if (asset.kind === "audio" || asset.kind === "tilemap" || !asset.url || asset.width > 0) {
            return resolve();
          }
          const img = new Image();
          img.onload = () => {
            asset.width = img.naturalWidth;
            asset.height = img.naturalHeight;
            resolve();
          };
          img.onerror = () => resolve();
          img.src = asset.url;
        }),
    ),
  );
}

/**
 * Owns the project's relationship with the disk: opening a folder, saving into
 * it, watching it for edits made elsewhere, and reading git status.
 *
 * The browser build never constructs one of these with a real location — the
 * platform reports `canOpenProjects: false` and the store keeps persisting to
 * localStorage exactly as before.
 */
export class Workspace {
  location: ProjectLocation | null = null;
  git: Record<string, string> = {};
  issues: string[] = [];
  lastSavedAt = 0;
  saving = false;
  /** Background dependency install, when the New Project flow started one. */
  install: { running: boolean; log: string; code: number | null; error?: string } | null = null;
  /**
   * Files in this folder that construct a `Phaser.Game`.
   *
   * Detected on open so Export game… can offer them without a scan at click
   * time. The first is the best-ranked.
   */
  gameEntries: string[] = [];
  /**
   * The language layout files are written in: the project's own setting, or
   * what the folder implies when it has not said.
   */
  language: Language = "ts";
  /**
   * `yours` files already looked at this session. Each is checked against the
   * disk once — written if it is missing, left alone forever if it is not —
   * and never read again, because a file that is yours is not Mosaic's to keep
   * inspecting.
   */
  private settled = new Set<string>();
  /**
   * The files Mosaic owns for the project as it last stood: scene and prefab
   * data, and the layouts generated from them. A path that was here and is not
   * in the next save belongs to something that was deleted, and goes with it.
   */
  private owned = new Set<string>();

  /** Bumped on every change, so React can subscribe with useSyncExternalStore. */
  revision = 0;
  /**
   * The project's script index. It lives here because it is a property of the
   * folder, like git status: opening a project builds it, and the same watcher
   * that reloads a scene keeps it warm.
   */
  scripts = new ScriptRegistry();
  /** Set by the game runner, so a closing project takes its dev server with it. */
  onClosing: ((root: string) => void) | null = null;
  /**
   * Scene files that changed on disk under unsaved edits of ours. Writing one
   * would throw away whatever the other change was, so a prefab push marks
   * them SKIPPED instead of overwriting them behind someone's back.
   */
  conflicts = new Set<string>();

  /**
   * Nothing is written to this folder until the user asks. Set when a starter
   * was opened over a project Mosaic could not read; cleared by the first
   * explicit save, which is the moment the user says the folder is theirs to
   * use.
   */
  deferredWrite = false;

  private store: ProjectStore;
  private stopWatch: (() => void) | null = null;
  /**
   * The exact bytes we last wrote per path. A save fires the same watcher
   * events an external edit does, so the echo is filtered by COMPARING
   * CONTENT rather than by a time window — a window races any edit made
   * shortly after a save, and silently swallows it.
   */
  private selfWrites = new Map<string, string[]>();
  private listeners = new Set<() => void>();

  constructor(store: ProjectStore) {
    this.store = store;
    store.setScriptIndex(this.scripts);
    // Install output streams to the status bar; failure is a banner, not a
    // blocker — the project is usable either way.
    platform.onInstallProgress((p) => {
      if (!this.location || p.root !== this.location.root) return;
      const current = this.install ?? { running: true, log: "", code: null };
      this.install = {
        running: !p.done,
        log: (current.log + (p.chunk ?? "")).slice(-4000),
        code: p.code ?? current.code,
        error: p.error ?? current.error,
      };
      if (p.done) {
        this.store.setStatus(
          p.code === 0 ? "npm install finished" : `npm install failed (${p.error ?? p.code})`,
        );
      }
      this.emit();
    });
  }

  /** Called by the New Project flow once it has spawned an install. */
  markInstalling(): void {
    this.install = { running: true, log: "", code: null };
    this.emit();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }

  get isOpen(): boolean {
    return this.location !== null;
  }

  // ------------------------------------------------------------- opening

  async pickAndOpen(): Promise<boolean> {
    const location = await platform.pickProject();
    if (!location) return false;
    return this.open(location);
  }

  async createAndOpen(): Promise<boolean> {
    const location = await platform.createProject();
    if (!location) return false;
    return this.open(location);
  }

  async open(location: ProjectLocation): Promise<boolean> {
    const source = await platform.readProject(location.root);
    if (!source) {
      this.store.setStatus(`Could not read ${location.root}`);
      return false;
    }

    const { project, issues, scaffolded, deferWrite } = projectFromSource(source, location.name, (rel) =>
      platform.assetUrl(location.root, rel),
    );
    await measureAssets(project);
    const maps = await this.readTilemaps(location.root, project, source.assets);
    const converted = migratePaintedTileLayers(project);

    this.close({ keepStore: true });
    this.location = location;
    setProjectRoot(location.root);
    this.issues = [...issues, ...converted];
    this.language = project.config.language ?? (await inferLanguage(location.root));
    this.store.loadProject(project);
    this.applyTilemaps(maps);
    this.owned = this.ownedPaths(project);

    // Autosave is what makes the editor feel like it edits a folder rather
    // than a document — but it is also a write, and a starter shown over
    // somebody else's repo must not put one on their disk. Skipping the
    // scaffold's save is not enough on its own: the persister fires on the
    // very first edit, and the folder fills up anyway.
    this.deferredWrite = deferWrite;
    if (!deferWrite) {
      this.store.setPersister((next) => this.scheduleSave(next));
      // A folder with nothing in it gets its scaffold written immediately, so
      // what is on disk always matches what the editor is showing. The same
      // goes for a conversion: the scene now points at maps, so the maps have
      // to exist.
      if (scaffolded || converted.length) await this.saveNow(project);
    }

    // The index is built in the background: the scene is on screen either
    // way, and a project with hundreds of source files should not hold it up.
    void this.scripts.load(location.root);
    void this.detectGameEntries(location.root);

    this.startWatching();
    void this.refreshGit();
    void platform.remember(location);
    platform.setWindowTitle(`${project.name} — Mosaic`);
    this.store.setStatus(
      issues.length
        ? `Opened ${location.name} with ${issues.length} issue(s)`
        : `Opened ${location.name}`,
    );
    this.emit();
    return true;
  }

  close(opts: { keepStore?: boolean } = {}): void {
    if (this.location) this.onClosing?.(this.location.root);
    this.stopWatch?.();
    this.stopWatch = null;
    this.location = null;
    this.git = {};
    this.issues = [];
    this.scripts.clear();
    this.gameEntries = [];
    this.settled.clear();
    this.selfWrites.clear();
    this.owned.clear();
    setProjectRoot(null);
    if (!opts.keepStore) {
      this.store.setPersister(null);
      platform.setWindowTitle("Mosaic");
    }
    this.emit();
  }

  private async detectGameEntries(root: string): Promise<void> {
    if (!platform.canImportPhaser) return;
    const found = await platform.findGameEntries(root).catch(() => []);
    if (this.location?.root !== root) return;
    this.gameEntries = found;
    this.emit();
  }

  recents(): Promise<RecentEntry[]> {
    return platform.recents();
  }

  forget(root: string): Promise<void> {
    return platform.forget(root);
  }

  reveal(rel?: string): void {
    if (this.location) void platform.reveal(this.location.root, rel);
  }

  // -------------------------------------------------------------- saving

  /**
   * The store already debounces before it calls its persister, so this does
   * not debounce again. It used to, which made every save wait out two 400ms
   * timers in series before a single byte was written — the two were unaware
   * of each other, and the second one bought nothing the first had not.
   */
  private scheduleSave(project: ProjectData): void {
    if (!this.location) return;
    void this.saveNow(project);
  }

  async saveNow(project = this.store.project): Promise<void> {
    if (!this.location) return;
    if (this.deferredWrite) {
      // Asked for by hand, so the folder is fair game from here on.
      this.deferredWrite = false;
      this.store.setPersister((next) => this.scheduleSave(next));
      this.issues = this.issues.filter((i) => !i.includes("WITHOUT writing anything"));
    }
    this.saving = true;
    this.emit();
    // The layout is not a separate export: it is part of what saving a scene
    // means, so the game on disk is never a step behind the editor.
    const files = [...projectToFiles(project), ...(await this.codeFiles(project))];
    // Remember the last few payloads per path, not just the newest. Two saves
    // in quick succession race their own watcher events: the event for the
    // first arrives after the second has been recorded but before its bytes
    // have landed, and comparing against one payload reads that as somebody
    // else's edit.
    for (const file of files) {
      const seen = this.selfWrites.get(file.rel) ?? [];
      this.selfWrites.set(file.rel, [file.contents, ...seen].slice(0, 4));
    }

    const result = await platform.writeFiles(this.location.root, files);
    // A map Mosaic made is a file from here on. Pointing the asset at it is
    // what stops the next save writing it again — over whatever Tiled has
    // done to it in the meantime.
    for (const { asset } of pendingTilemaps(project)) {
      if (result.written.includes(asset.path)) {
        asset.url = platform.assetUrl(this.location.root, asset.path);
      }
    }
    await this.removeOrphans(project);
    this.saving = false;
    this.lastSavedAt = Date.now();
    if (result.failed.length) {
      this.store.setStatus(
        `Could not write ${result.failed[0].rel}: ${result.failed[0].error}`,
      );
    }
    for (const key of this.store.project.scenes.map((s) => s.key)) this.store.markSaved(key);
    void this.refreshGit();
    this.emit();
  }

  /**
   * The code a save writes beside the scene data.
   *
   * Two rules, one per kind of file. A generated file is rewritten — but only
   * when its bytes changed, because a dev server reloads on every write and
   * moving one sprite should not reload fifty scenes. A file that is yours is
   * written when it does not exist, and otherwise not at all.
   */
  private async codeFiles(project: ProjectData): Promise<DiskFile[]> {
    const root = this.location?.root;
    if (!root) return [];
    const generated = generateProjectFiles(project, {
      language: this.language,
      declared: this.declaredProps,
    });
    const out: DiskFile[] = [];
    const created: string[] = [];

    for (const file of generated) {
      if (file.owner === "generated") {
        const last = this.selfWrites.get(file.path);
        if (last?.[0] === file.contents) continue;
        if (!last && (await platform.readText(root, file.path)) === file.contents) {
          this.selfWrites.set(file.path, [file.contents]);
          continue;
        }
        out.push({ rel: file.path, contents: file.contents });
        continue;
      }

      if (this.settled.has(file.path)) continue;
      this.settled.add(file.path);
      if (this.alreadyWired(file)) continue;
      const onDisk = await platform.readText(root, file.path);
      if (onDisk === null || isUntouchedLegacy(onDisk)) {
        out.push({ rel: file.path, contents: file.contents });
        created.push(file.path);
      } else if (isLegacyGenerated(onDisk)) {
        this.issues.push(
          `${file.path} was generated by an older Mosaic and holds code you wrote inside its keep markers. It is yours now and will not be rewritten — import from ./${file.path.split("/").pop()!.replace(/\.(ts|js)$/, ".layout")} to pick up what the editor authors.`,
        );
      }
    }

    if (created.length) {
      // A scene class is only half-made until the game knows about it, and
      // the game's scene list is a file Mosaic does not write to.
      const scene = created.find((rel) => rel.startsWith("src/scenes/"));
      const cls = scene?.split("/").pop()!.replace(/\.(ts|js)$/, "");
      this.store.setStatus(
        scene && this.lastSavedAt
          ? `Wrote ${scene} — yours from here on. Add ${cls} to your game's scene list to run it.`
          : created.length === 1
            ? `Wrote ${created[0]} — yours from here on`
            : `Wrote ${created.length} starter files — yours from here on`,
      );
    }
    return out;
  }

  // ------------------------------------------------------------ tilemaps

  /**
   * Finds the Tiled maps in the folder and describes each one.
   *
   * A map is recognised by what is in it, not by its name: `.tmj` is what
   * Tiled writes now, `.json` is what it wrote for years and what most Phaser
   * projects have, and a `.json` in an art folder is as likely to be an atlas.
   * So every candidate is opened, and the ones that are maps become assets.
   */
  private async readTilemaps(
    root: string,
    project: ProjectData,
    onDisk: { rel: string }[],
  ): Promise<Map<string, TiledMap>> {
    const out = new Map<string, TiledMap>();
    const candidates = new Set<string>();
    for (const asset of project.assets) {
      if (asset.kind === "tilemap" && !asset.url.startsWith("data:")) candidates.add(asset.path);
    }
    for (const file of onDisk) {
      if (MAP_EXT.test(file.rel) && !/\.atlas\.json$/i.test(file.rel)) candidates.add(file.rel);
    }

    const keys = project.assets.map((a) => a.key);
    for (const rel of [...candidates].sort()) {
      const text = await platform.readText(root, rel);
      const map = text ? parseTiledMap(text) : null;
      let asset = project.assets.find((a) => a.path === rel);
      if (!map) {
        // Declared, and now unreadable or gone: keep the asset so the scene's
        // layers still say what they wanted, and let validation report it.
        if (asset?.kind === "tilemap") delete asset.tilemap;
        continue;
      }
      if (!asset) {
        const stem = rel.split("/").pop()!.replace(/\.\w+$/, "");
        const key = uniqueKey(stem, keys);
        keys.push(key);
        asset = { id: uid("asset"), key, kind: "tilemap", path: rel, url: "", width: 0, height: 0 };
        project.assets.push(asset);
      }
      asset.kind = "tilemap";
      asset.url = platform.assetUrl(root, rel);
      asset.width = map.width * map.tilewidth;
      asset.height = map.height * map.tileheight;
      out.set(asset.key, map);
    }
    // Described last, once every image the project has is known — a tileset
    // names its image, and the image may be an asset discovered in this pass.
    for (const asset of project.assets) {
      const map = out.get(asset.key);
      if (map) asset.tilemap = describeTiledMap(map, asset.path, project.assets);
    }
    return out;
  }

  /** Hands the parsed maps to the store and lets every scene catch up with them. */
  private applyTilemaps(maps: Map<string, TiledMap>): void {
    for (const [key, map] of maps) this.store.setTilemap(key, map);
    const notes = this.store.reconcileTilemaps();
    if (notes.length) this.store.setStatus(notes[0]);
  }

  /**
   * Re-reads the folder's maps without reloading the project — after a save
   * in Tiled, or after art was imported that a map may have been waiting for.
   */
  async rescanTilemaps(): Promise<void> {
    if (!this.location) return;
    const root = this.location.root;
    const source = await platform.readProject(root);
    if (!source || this.location?.root !== root) return;
    const maps = await this.readTilemaps(root, this.store.project, source.assets);
    this.applyTilemaps(maps);
    this.emit();
  }

  /** Scene and prefab data, plus the layout generated from each. */
  private ownedPaths(project: ProjectData): Set<string> {
    const out = new Set<string>();
    for (const scene of project.scenes) {
      out.add(scenePath(scene.key));
      out.add(sceneLayoutPath(scene.key, this.language));
    }
    for (const prefab of project.prefabs) {
      out.add(prefabPath(prefab.name));
      out.add(prefabLayoutPath(prefab.name, this.language));
    }
    return out;
  }

  /**
   * Deleting a scene or a prefab deletes its files.
   *
   * Without this the data file stayed behind and the thing came back the next
   * time the folder was opened. Only what Mosaic owns goes: the class beside
   * it is the developer's, and is left exactly where it is.
   */
  private async removeOrphans(project: ProjectData): Promise<void> {
    if (!this.location) return;
    const now = this.ownedPaths(project);
    const gone = [...this.owned].filter((rel) => !now.has(rel));
    this.owned = now;
    if (!gone.length) return;
    for (const rel of gone) this.selfWrites.delete(rel);
    this.expectedRemovals = new Set(gone);
    await platform.removeFiles(this.location.root, gone);
  }

  /** Removals we asked for, so the watcher does not read them as someone else's. */
  private expectedRemovals = new Set<string>();

  /**
   * True when the project already has its own class for this file's job.
   *
   * An imported project keeps its scenes wherever it kept them, and dropping a
   * second `MainGame` into src/scenes because the first one is not where
   * Mosaic would have put it is the editor arguing with the codebase. So a
   * starter is skipped when something already imports the layout, or a class
   * of that name already exists somewhere else.
   */
  private alreadyWired(file: GeneratedFile): boolean {
    const stem = file.path.split("/").pop()!.replace(/\.(ts|js)$/, "");
    for (const [src, contents] of this.scripts.sources) {
      if (src === file.path) continue;
      if (contents.includes(`${stem}.layout`)) return true;
    }
    // Only scenes, and only a class that IS a scene: a prefab called Brick
    // and a script component called Brick are two different things that
    // happen to share the obvious name.
    if (!file.path.startsWith("src/scenes/")) return false;
    return this.scripts.index.classes.some(
      (c) =>
        c.name === stem &&
        c.src !== file.path &&
        !/\.layout\.(ts|js)$/.test(c.src) &&
        /Scene$/.test(c.base ?? ""),
    );
  }

  /** The `@property` fields a class declares right now, bases included. */
  private declaredProps = (src: string, className: string): Set<string> | null => {
    const index = this.scripts.index;
    const cls =
      index.byKey.get(`${src}::${className}`) ?? index.classes.find((c) => c.name === className);
    if (!cls) return null;
    return new Set(propertiesOf(index, cls).map((p) => p.name));
  };

  // ------------------------------------------------------------ watching

  private startWatching(): void {
    if (!this.location || !platform.canWatch) return;
    const root = this.location.root;
    this.stopWatch = platform.watch(root, (changes) => void this.onExternalChange(changes));
  }

  /**
   * Edits made outside Mosaic are picked up. Our own writes are filtered out
   * first: a save fires the same watcher events an external edit does.
   */
  private async onExternalChange(changes: ProjectChange[]): Promise<void> {
    if (!this.location) return;
    const root = this.location.root;

    const external: ProjectChange[] = [];
    for (const change of changes) {
      if (change.kind === "unlink" && this.expectedRemovals.delete(change.rel)) continue;
      const written = this.selfWrites.get(change.rel);
      if (written === undefined) {
        external.push(change);
        continue;
      }
      // We wrote this path. If what is there now is something WE wrote, the
      // event is our own echo; if it is anything else, someone else changed it.
      const current = await platform.readText(root, change.rel);
      if (current !== null && written.includes(current)) continue;
      this.selfWrites.delete(change.rel);
      external.push(change);
    }
    if (!external.length) return;

    const touchedProject = external.some(
      (c) =>
        c.rel === MANIFEST_PATH ||
        c.rel === CONFIG_PATH ||
        c.rel.endsWith(".scene.json") ||
        c.rel.endsWith(".prefab.json"),
    );
    const touchedAssets = external.some((c) => c.rel.startsWith("assets/"));

    // Source edits re-index and refresh the inspector's field list in place.
    // They never reload the scene: the class says what a script exposes, the
    // scene says what it is set to, and only the class changed.
    const touchedScripts = external
      .filter((c) => SCRIPT_EXT.test(c.rel) && !c.rel.endsWith(".scene.json"))
      .map((c) => c.rel);
    if (touchedScripts.length) {
      await this.scripts.refresh(touchedScripts);
    }

    if (this.store.stack().canUndo && touchedProject && this.store.isDirty(this.store.docKey)) {
      // Do not silently overwrite unsaved work with what is on disk. Record
      // which scenes are in that state: a prefab push has to be able to say
      // "skipped, and why" rather than clobbering one of the two edits.
      for (const change of external) {
        if (change.rel.endsWith(".scene.json")) this.conflicts.add(change.rel);
      }
      this.store.setStatus(
        `${external[0].rel} changed on disk — save or undo your edits, then reopen the project to pick it up`,
      );
      this.emit();
      return;
    }

    const assetChanges = external.filter((c) => c.rel.startsWith("assets/"));
    const onlyMaps = assetChanges.length > 0 && assetChanges.every((c) => MAP_EXT.test(c.rel));

    if (touchedProject) {
      await this.reload();
      this.store.setStatus(`Reloaded — ${external[0].rel} changed on disk`);
    } else if (onlyMaps) {
      // A save in Tiled. Re-read the maps where they stand: a full reload
      // would throw away the undo history and the selection every time, and
      // saving in Tiled is something that happens every few seconds.
      await this.rescanTilemaps();
      this.store.setStatus(`${assetChanges[0].rel} changed in Tiled — map updated`);
    } else if (touchedAssets) {
      await this.reload();
      this.store.setStatus("Assets changed on disk — textures reloaded");
    }
    void this.refreshGit();
  }

  /**
   * Why a scene cannot be written right now, or null when it can. The prefab
   * propagation panel asks this before it plans a push.
   */
  writeBlockedReason = (sceneKey: string): string | null => {
    return this.conflicts.has(scenePath(sceneKey)) ? "changed on disk since load" : null;
  };

  /** Re-read the folder without touching the watcher or window title. */
  async reload(): Promise<void> {
    if (!this.location) return;
    this.conflicts.clear();
    void this.scripts.load(this.location.root);
    const source = await platform.readProject(this.location.root);
    if (!source) return;
    const { project, issues, deferWrite } = projectFromSource(source, this.location.name, (rel) =>
      platform.assetUrl(this.location!.root, rel),
    );
    await measureAssets(project);
    const maps = await this.readTilemaps(this.location.root, project, source.assets);
    const converted = migratePaintedTileLayers(project);
    this.issues = [...issues, ...converted];
    const activeKey = this.store.activeSceneKey;
    // An open prefab is a document like a scene is, and reopening the folder
    // must put you back in the one you were in. Unsaved definition work never
    // reaches here — the guard above refuses to reload over it.
    const openPrefab = this.store.prefabDoc?.name;
    this.store.loadProject(project);
    this.applyTilemaps(maps);
    this.owned = this.ownedPaths(project);
    if (project.scenes.some((s) => s.key === activeKey)) this.store.activateScene(activeKey);
    if (openPrefab && project.prefabs.some((p) => p.name === openPrefab)) {
      this.store.openPrefab(openPrefab);
    }
    // A reload re-reads the folder, so it re-answers the question too: still
    // somebody else's repo means autosave stays off, and re-installing it here
    // would undo the whole guard on the first external edit.
    this.deferredWrite = deferWrite;
    if (!deferWrite) this.store.setPersister((next) => this.scheduleSave(next));
    this.emit();
  }

  // ----------------------------------------------------------------- git

  async refreshGit(): Promise<void> {
    if (!this.location || !platform.canGit) return;
    this.git = await platform.gitStatus(this.location.root);
    this.emit();
  }

}


/**
 * TypeScript when the folder says so, JavaScript when it is a JS project, and
 * TypeScript again when it is nothing yet — which is what a new Mosaic project
 * is scaffolded as.
 */
async function inferLanguage(root: string): Promise<Language> {
  if ((await platform.readText(root, "tsconfig.json")) !== null) return "ts";
  if ((await platform.readText(root, "package.json")) !== null) return "js";
  return "ts";
}

/** A scene or prefab class written by the generator Mosaic used to have. */
function isLegacyGenerated(source: string): boolean {
  return /^\/\/ GENERATED by Mosaic from /.test(source) && source.includes("// <keep id=");
}

/**
 * The same, with nothing of the user's in it — so it can be replaced by the
 * new starting point without losing anything.
 */
function isUntouchedLegacy(source: string): boolean {
  if (!isLegacyGenerated(source)) return false;
  const region = /^[ \t]*\/\/[ \t]*<keep[ \t]+id="[^"]+">[ \t]*\n([\s\S]*?)^[ \t]*\/\/[ \t]*<\/keep>[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = region.exec(source))) {
    const body = match[1]
      .split("\n")
      .filter((line) => line.trim() && !line.includes("it survives regeneration"));
    if (body.length) return false;
  }
  return true;
}
