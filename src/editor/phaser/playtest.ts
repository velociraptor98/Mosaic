import { className } from "../export/generate";
import { platform } from "../platform";
import type { DevServerResult } from "../platform/types";
import type { Workspace } from "../project/workspace";
import type { ProjectStore } from "../store/project";

/**
 * The project's own game, served by its own dev server.
 *
 * `starting` while the server boots, `running` once it has an address, and
 * `failed` with a code the UI can act on — "not installed" offers the install,
 * rather than only reporting that something went wrong.
 */
export interface GameRun {
  status: "starting" | "running" | "failed";
  root: string;
  url: string | null;
  error?: string;
  code?: DevServerResult["code"];
  log: string;
  /** Bumped to reload the page without restarting the server. */
  nonce: number;
}

/**
 * RUN: the project's real game, from its real dev server, beside the canvas.
 *
 * Mosaic does not have a runtime of its own. It runs the code the developer
 * wrote, through the bundler they chose, exactly as `npm run dev` would —
 * because it IS `npm run dev`. The editor stays live next to it: every save
 * rewrites the layout files, and the dev server reloads.
 */
export class Playtest {
  run: GameRun | null = null;
  revision = 0;

  private store: ProjectStore;
  private workspace: Workspace;
  private listeners = new Set<() => void>();

  constructor(store: ProjectStore, workspace: Workspace) {
    this.store = store;
    this.workspace = workspace;
    workspace.onClosing = (root) => this.shutdown(root);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getRevision = (): number => this.revision;

  private set(next: GameRun | null): void {
    this.run = next;
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }

  /** True when there is a game to run: a project folder that is Mosaic's to write. */
  get canRun(): boolean {
    return platform.canRunGame && !!this.workspace.location && !this.workspace.deferredWrite;
  }

  /** The page RUN shows: the server's address, opened on the scene being edited. */
  url(): string | null {
    if (!this.run?.url) return null;
    try {
      const url = new URL(this.run.url);
      const key = this.store.activeSceneKey;
      if (key) url.searchParams.set("scene", className(key));
      return url.toString();
    } catch {
      return this.run.url;
    }
  }

  async start(): Promise<void> {
    const root = this.workspace.location?.root;
    if (!root) return;
    this.set({ status: "starting", root, url: null, log: "", nonce: 0 });
    this.store.setStatus("Starting the game…");

    // The game reads what is on disk, so what is on disk has to be current.
    await this.workspace.saveNow();
    const result = await platform.startDevServer(root);
    // STOP, or a different project, while the server was booting.
    if (this.run?.root !== root) return;

    if (!result.ok || !result.url) {
      this.set({
        status: "failed",
        root,
        url: null,
        error: result.error ?? "The dev server did not start.",
        code: result.code,
        log: result.log,
        nonce: 0,
      });
      this.store.setStatus(`Could not run the game — ${result.error ?? "the dev server did not start"}`);
      return;
    }
    this.set({ status: "running", root, url: result.url, log: result.log, nonce: 0 });
    this.store.setStatus(`Running the game from ${result.url} — edits reload it as you save`);
  }

  /** Reloads the page. The server, and whatever it has cached, stays up. */
  reload(): void {
    if (this.run?.status !== "running") return;
    this.set({ ...this.run, nonce: this.run.nonce + 1 });
  }

  /**
   * Closes the game. The server is left running: starting one costs seconds,
   * and the next RUN should not pay for it again. It stops with the project.
   */
  stop(): void {
    if (!this.run) return;
    this.set(null);
    this.store.setStatus("Stopped — the dev server is still up for the next run");
  }

  /** Ends the server too. Called when the project closes. */
  private shutdown(root: string): void {
    if (this.run?.root === root) this.set(null);
    void platform.stopDevServer(root);
  }
}
