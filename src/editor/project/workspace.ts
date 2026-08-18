import type { ProjectData } from "../../shared/types";
import { setProjectRoot } from "../export/write";
import { platform } from "../platform";
import type { ProjectChange, ProjectLocation, RecentEntry } from "../platform/types";
import type { ProjectStore } from "../store/project";
import { CONFIG_PATH, MANIFEST_PATH, projectFromSource, projectToFiles, scenePath } from "./serialize";

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

  private store: ProjectStore;
  private stopWatch: (() => void) | null = null;
  private saveTimer: number | null = null;
  /**
   * The exact bytes we last wrote per path. A save fires the same watcher
   * events an external edit does, so the echo is filtered by COMPARING
   * CONTENT rather than by a time window — a window races any edit made
   * shortly after a save, and silently swallows it.
   */
  private selfWrites = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(store: ProjectStore) {
    this.store = store;
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

  private scheduleSave(project: ProjectData): void {
    if (!this.location) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow(project);
    }, 400);
  }

  async saveNow(project = this.store.project): Promise<void> {
    if (!this.location) return;
    this.saving = true;
    this.emit();
    const files = projectToFiles(project);
    for (const file of files) this.selfWrites.set(file.rel, file.contents);

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
      // We wrote this path. If what is there now is byte-identical, the event
      // is our own echo; if it differs, someone else changed it.
      const current = await platform.readText(root, change.rel);
      if (current === written) continue;
      this.selfWrites.delete(change.rel);
      external.push(change);
    }
    if (!external.length) return;

    const touchedProject = external.some(
      (c) => c.rel === MANIFEST_PATH || c.rel === CONFIG_PATH || c.rel.endsWith(".scene.json"),
    );
    const touchedAssets = external.some((c) => c.rel.startsWith("assets/"));

    if (this.store.stack().canUndo && touchedProject && this.store.isDirty(this.store.activeSceneKey)) {
      // Do not silently overwrite unsaved work with what is on disk.
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

  /** Re-read the folder without touching the watcher or window title. */
  async reload(): Promise<void> {
    if (!this.location) return;
    const source = await platform.readProject(this.location.root);
    if (!source) return;
    const { project, issues } = projectFromSource(source, this.location.name, (rel) =>
      platform.assetUrl(this.location!.root, rel),
    );
    await measureAssets(project);
    this.issues = issues;
    const activeKey = this.store.activeSceneKey;
    this.store.loadProject(project);
    if (project.scenes.some((s) => s.key === activeKey)) this.store.activateScene(activeKey);
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
