import type { ProjectData } from "../../shared/types";
import { setProjectRoot } from "../export/write";
import { platform } from "../platform";
import type { ProjectChange, ProjectLocation, RecentEntry } from "../platform/types";
import { ScriptRegistry } from "../scripts/registry";
import { ScriptRuntime } from "../scripts/runtime";
import { SCRIPT_EXT } from "../../shared/scripts";
import type { ProjectStore } from "../store/project";
import {
  CONFIG_PATH,
  MANIFEST_PATH,
  projectFromSource,
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
          if (asset.kind === "audio" || !asset.url || asset.width > 0) return resolve();
          const img = new Image();
          img.onload = () => {
            asset.width = img.naturalWidth;
            asset.height = img.naturalHeight;
            if (asset.kind === "tileset" && !asset.frameWidth) {
              asset.frameWidth = 32;
              asset.frameHeight = 32;
            }
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
  /** Bumped on every change, so React can subscribe with useSyncExternalStore. */
  revision = 0;
  /**
   * The project's script index. It lives here because it is a property of the
   * folder, like git status: opening a project builds it, and the same watcher
   * that reloads a scene keeps it warm.
   */
  scripts = new ScriptRegistry();
  /**
   * The compiled half of the same thing: the classes the play-test constructs.
   * Built on RUN, rebuilt when the source behind it changes.
   */
  scriptRuntime = new ScriptRuntime();
  /** Set by the play-test, so a source edit can reach a running scene. */
  onScriptsChanged: ((rels: string[]) => void) | null = null;
  /**
   * Scene files that changed on disk under unsaved edits of ours. Writing one
   * would throw away whatever the other change was, so a prefab push marks
   * them SKIPPED instead of overwriting them behind someone's back.
   */
  conflicts = new Set<string>();

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

    const { project, issues, scaffolded } = projectFromSource(source, location.name, (rel) =>
      platform.assetUrl(location.root, rel),
    );
    await measureAssets(project);

    this.close({ keepStore: true });
    this.location = location;
    setProjectRoot(location.root);
    this.issues = issues;
    this.store.loadProject(project);
    this.store.setPersister((next) => this.scheduleSave(next));

    // A folder with nothing in it gets its scaffold written immediately, so
    // what is on disk always matches what the editor is showing.
    if (scaffolded) await this.saveNow(project);

    // The index is built in the background: the scene is on screen either
    // way, and a project with hundreds of source files should not hold it up.
    void this.scripts.load(location.root);

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
    this.stopWatch?.();
    this.stopWatch = null;
    this.location = null;
    this.git = {};
    this.issues = [];
    this.scripts.clear();
    this.scriptRuntime.reset();
    setProjectRoot(null);
    if (!opts.keepStore) {
      this.store.setPersister(null);
      platform.setWindowTitle("Mosaic");
    }
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
    this.saving = true;
    this.emit();
    const files = projectToFiles(project);
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
      this.onScriptsChanged?.(touchedScripts);
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

    if (touchedProject) {
      await this.reload();
      this.store.setStatus(`Reloaded — ${external[0].rel} changed on disk`);
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
    const { project, issues } = projectFromSource(source, this.location.name, (rel) =>
      platform.assetUrl(this.location!.root, rel),
    );
    await measureAssets(project);
    this.issues = issues;
    const activeKey = this.store.activeSceneKey;
    // An open prefab is a document like a scene is, and reopening the folder
    // must put you back in the one you were in. Unsaved definition work never
    // reaches here — the guard above refuses to reload over it.
    const openPrefab = this.store.prefabDoc?.name;
    this.store.loadProject(project);
    if (project.scenes.some((s) => s.key === activeKey)) this.store.activateScene(activeKey);
    if (openPrefab && project.prefabs.some((p) => p.name === openPrefab)) {
      this.store.openPrefab(openPrefab);
    }
    this.store.setPersister((next) => this.scheduleSave(next));
    this.emit();
  }

  // ----------------------------------------------------------------- git

  async refreshGit(): Promise<void> {
    if (!this.location || !platform.canGit) return;
    this.git = await platform.gitStatus(this.location.root);
    this.emit();
  }

  /** Git status for a scene, for the badge in the Project panel. */
  statusForScene(key: string): string | undefined {
    return this.git[scenePath(key)];
  }

  statusForPath(rel: string): string | undefined {
    return this.git[rel];
  }
}
