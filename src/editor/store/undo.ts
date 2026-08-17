/**
 * Undo is slice-based rather than whole-project: a transaction records only
 * the slices it actually changed, so undoing an edit in one scene can never
 * clobber an edit made later in another. Each scene owns its own stack.
 */

export interface SliceChange {
  slice: string;
  before: unknown;
  after: unknown;
}

export interface UndoEntry {
  label: string;
  changes: SliceChange[];
}

export class UndoStack {
  private entries: UndoEntry[] = [];
  private cursor = 0;
  private limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  push(entry: UndoEntry): void {
    if (!entry.changes.length) return;
    this.entries.length = this.cursor;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.cursor = this.entries.length;
  }

  /** Coalesce into the previous entry — used to fold a drag into one undo. */
  mergeIntoPrevious(entry: UndoEntry): boolean {
    if (this.cursor === 0) return false;
    const prev = this.entries[this.cursor - 1];
    if (prev.label !== entry.label) return false;
    for (const change of entry.changes) {
      const existing = prev.changes.find((c) => c.slice === change.slice);
      if (existing) existing.after = change.after;
      else prev.changes.push(change);
    }
    return true;
  }

  undo(): UndoEntry | null {
    if (this.cursor === 0) return null;
    this.cursor -= 1;
    return this.entries[this.cursor];
  }

  redo(): UndoEntry | null {
    if (this.cursor >= this.entries.length) return null;
    const entry = this.entries[this.cursor];
    this.cursor += 1;
    return entry;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  get undoLabel(): string | null {
    return this.cursor > 0 ? this.entries[this.cursor - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.cursor < this.entries.length ? this.entries[this.cursor].label : null;
  }

  get depth(): number {
    return this.cursor;
  }
}
