import { SCRIPT_BASE_FILE, SCRIPT_EXT, scriptFilePath } from "../../shared/scripts";
import type { ScriptRef } from "../../shared/types";
import { platform } from "../platform";
import {
  attachableClasses,
  buildIndex,
  componentFiles,
  parseScriptFile,
  propertiesOf,
  scriptKey,
  type ComponentFile,
  type ParsedFile,
  type ScriptClass,
  type ScriptIndex,
  type ScriptProperty,
} from "./parse";
import { scriptBaseSource, scriptStub } from "./stub";

/**
 * The project's script index: every class under `src/**` that extends
 * ScriptComponent, with the properties it declares and the source behind them.
 *
 * Built when the project opens and kept warm by the file watcher, so the
 * attach picker offers what the project actually has rather than a free-text
 * class name that may not resolve. The index is derived state — it is never
 * saved, and nothing here writes into the scene.
 */

export type ScriptResolution =
  | { status: "ok"; cls: ScriptClass }
  /** Same class name, different file: the class moved, so offer a relink. */
  | { status: "moved"; cls: ScriptClass }
  | { status: "missing"; cls: null };

export class ScriptRegistry {
  index: ScriptIndex = buildIndex([]);
  /** Whole file contents, for the read-only source drawer. */
  sources = new Map<string, string>();
  root: string | null = null;
  loading = false;
  revision = 0;

  private parsed = new Map<string, ParsedFile>();
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getRevision = (): number => this.revision;

  private emit(): void {
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }

  clear(): void {
    this.root = null;
    this.parsed.clear();
    this.sources.clear();
    this.index = buildIndex([]);
    this.emit();
  }

  /** Full pass over the project's source tree. Called when a project opens. */
  async load(root: string): Promise<void> {
    this.root = root;
    if (!platform.canOpenProjects) {
      this.emit();
      return;
    }
    this.loading = true;
    this.emit();
    const files = await platform.readScripts(root);
    this.parsed.clear();
    this.sources.clear();
    for (const file of files) this.ingest(file.rel, file.contents);
    this.rebuild();
    this.loading = false;
    this.emit();
  }

  /**
   * Re-reads the files the watcher reported. An external save re-indexes and
   * the inspector's field list refreshes in place — the values in the scene
   * are untouched, because the class says what exists and the scene says what
   * it is set to.
   */
  async refresh(rels: string[]): Promise<void> {
    if (!this.root || !platform.canOpenProjects) return;
    const wanted = rels.filter((rel) => SCRIPT_EXT.test(rel) && !rel.endsWith(".scene.json"));
    if (!wanted.length) return;
    for (const rel of wanted) {
      const contents = await platform.readText(this.root, rel);
      if (contents === null) {
        // Deleted: drop it, and let whatever referenced it read as missing.
        this.parsed.delete(rel);
        this.sources.delete(rel);
        continue;
      }
      this.ingest(rel, contents);
    }
    this.rebuild();
    this.emit();
  }

  private ingest(rel: string, contents: string): void {
    const previous = this.parsed.get(rel);
    const next = parseScriptFile(rel, contents);
    this.sources.set(rel, contents);
    // A file caught mid-edit (or one that does not compile) keeps its last
    // good metadata: the inspector greys the fields out rather than emptying.
    if (next.error && previous && previous.classes.length && !next.classes.length) {
      this.parsed.set(rel, { ...previous, error: next.error });
      return;
    }
    this.parsed.set(rel, next);
  }

  private rebuild(): void {
    const files = [...this.parsed.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, parsed]) => parsed);
    this.index = buildIndex(files);
  }

  // ------------------------------------------------------------ reading

  /** Classes the attach picker offers. */
  attachable(): ScriptClass[] {
    return attachableClasses(this.index);
  }

  /** The project's script files, for the Project panel. */
  files(): ComponentFile[] {
    return componentFiles(this.index);
  }

  /**
   * A reference resolves by path first, so two classes of the same name in
   * different folders stay apart. Falling back to the name alone is what lets
   * a moved file be relinked instead of silently reading as missing.
   */
  resolve(ref: Pick<ScriptRef, "class" | "src">): ScriptResolution {
    const exact = this.index.byKey.get(scriptKey(ref.src, ref.class));
    if (exact) return { status: "ok", cls: exact };
    const byName = this.index.classes.filter((c) => c.name === ref.class);
    if (byName.length === 1) return { status: "moved", cls: byName[0] };
    return { status: "missing", cls: null };
  }

  properties(cls: ScriptClass): ScriptProperty[] {
    return propertiesOf(this.index, cls);
  }

  sourceOf(src: string): string | null {
    return this.sources.get(src) ?? null;
  }

  errorFor(src: string): string | undefined {
    return this.parsed.get(src)?.error;
  }

  // ------------------------------------------------------------ writing

  /**
   * Writes `src/scripts/<Name>.ts` (and the base class beside it, the first
   * time), indexes it, and hands the class back so the caller can attach in
   * the same action.
   */
  async create(className: string): Promise<ScriptClass | null> {
    if (!this.root || !platform.canOpenProjects) return null;
    const rel = scriptFilePath(className);
    if (this.sources.has(rel)) return this.index.byKey.get(scriptKey(rel, className)) ?? null;

    const files = [{ rel, contents: scriptStub(className) }];
    if (!this.sources.has(SCRIPT_BASE_FILE)) {
      files.unshift({ rel: SCRIPT_BASE_FILE, contents: scriptBaseSource() });
    }
    const result = await platform.writeFiles(this.root, files);
    if (result.failed.length) return null;

    for (const file of files) this.ingest(file.rel, file.contents);
    this.rebuild();
    this.emit();
    return this.index.byKey.get(scriptKey(rel, className)) ?? null;
  }

  /** Opens the class in the user's real editor, at the line if one is given. */
  async openExternal(src: string, line?: number): Promise<boolean> {
    if (!this.root || !platform.canOpenProjects) return false;
    const result = await platform.openInEditor(this.root, src, line);
    return result.ok;
  }
}
