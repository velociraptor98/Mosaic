import { SCRIPT_EXT } from "../../shared/scripts";
import { platform } from "../platform";
import {
  buildIndex,
  parseScriptFile,
  propertiesOf,
  type ParsedFile,
  type ScriptClass,
  type ScriptIndex,
  type ScriptProperty,
} from "./parse";

/**
 * The project's source index: every class under `src/**`, with the editable
 * fields it declares and the source behind them.
 *
 * Built when the project opens and kept warm by the file watcher, so the
 * inspector shows the fields a class has right now. The index is derived state:
 * it is never saved, and nothing here writes into the scene or the code.
 */

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

  properties(cls: ScriptClass): ScriptProperty[] {
    return propertiesOf(this.index, cls);
  }

  sourceOf(src: string): string | null {
    return this.sources.get(src) ?? null;
  }

  errorFor(src: string): string | undefined {
    return this.parsed.get(src)?.error;
  }

  /** Opens the class in the user's real editor, at the line if one is given. */
  async openExternal(src: string, line?: number): Promise<boolean> {
    if (!this.root || !platform.canOpenProjects) return false;
    const result = await platform.openInEditor(this.root, src, line);
    return result.ok;
  }
}
