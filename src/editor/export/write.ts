import { hasUnmarkedEdits, mergeKeepRegions } from "./keep";
import type { GeneratedFile } from "./generate";

/**
 * Writing goes to a real directory when the browser can (File System Access
 * API), and falls back to downloads otherwise. Either way the user sees a diff
 * first, generated code is merged over its keep regions, and a file with
 * un-marked manual edits is refused rather than clobbered.
 */

const LAST_WRITE_KEY = "mosaic:last-write:v1";
const LEGACY_WRITE_KEY = "phaser-scene-editor:last-write:v1";

export type DiffStatus = "new" | "changed" | "unchanged" | "conflict";

export interface FileDiff {
  path: string;
  status: DiffStatus;
  /** What will actually be written (generated, merged over keep regions). */
  contents: string;
  previous: string | null;
  addedLines: number;
  removedLines: number;
  language: GeneratedFile["language"];
}

type DirHandle = {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  name: string;
};
type FileHandle = {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};

let rootHandle: DirHandle | null = null;

export function canWriteToDisk(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export function connectedFolder(): string | null {
  return rootHandle?.name ?? null;
}

export async function chooseFolder(): Promise<string | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> })
    .showDirectoryPicker;
  if (!picker) return null;
  rootHandle = await picker({ mode: "readwrite" });
  return rootHandle?.name ?? null;
}

function lastWrites(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(LAST_WRITE_KEY);
    if (raw) return JSON.parse(raw);
    // Carry the pre-rename log forward, so a first export after the rename
    // still diffs against what was actually written last.
    const legacy = window.localStorage.getItem(LEGACY_WRITE_KEY);
    if (!legacy) return {};
    window.localStorage.setItem(LAST_WRITE_KEY, legacy);
    window.localStorage.removeItem(LEGACY_WRITE_KEY);
    return JSON.parse(legacy);
  } catch {
    return {};
  }
}

function rememberWrites(files: { path: string; contents: string }[]): void {
  const log = lastWrites();
  for (const f of files) log[f.path] = f.contents;
  try {
    window.localStorage.setItem(LAST_WRITE_KEY, JSON.stringify(log));
  } catch {
    /* the diff degrades to "new"; writing still works */
  }
}

async function readExisting(path: string): Promise<string | null> {
  if (!rootHandle) return lastWrites()[path] ?? null;
  const parts = path.split("/");
  const name = parts.pop()!;
  let dir = rootHandle;
  try {
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch {
    return null;
  }
}

export async function diffFiles(generated: GeneratedFile[]): Promise<FileDiff[]> {
  const log = lastWrites();
  const out: FileDiff[] = [];
  for (const file of generated) {
    const onDisk = await readExisting(file.path);
    const merged =
      file.language === "ts" ? mergeKeepRegions(file.contents, onDisk) : file.contents;
    let status: DiffStatus;
    if (onDisk === null) status = "new";
    else if (onDisk === merged) status = "unchanged";
    else if (file.language === "ts" && hasUnmarkedEdits(onDisk, log[file.path] ?? null))
      status = "conflict";
    else status = "changed";

    const { added, removed } = lineDelta(onDisk ?? "", merged);
    out.push({
      path: file.path,
      status,
      contents: merged,
      previous: onDisk,
      addedLines: added,
      removedLines: removed,
      language: file.language,
    });
  }
  return out;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
  refused: string[];
  mode: "disk" | "download";
}

export async function writeFiles(
  diffs: FileDiff[],
  opts: { force?: boolean } = {},
): Promise<WriteResult> {
  const result: WriteResult = {
    written: [],
    skipped: [],
    refused: [],
    mode: rootHandle ? "disk" : "download",
  };

  const toWrite: FileDiff[] = [];
  for (const diff of diffs) {
    if (diff.status === "unchanged") {
      result.skipped.push(diff.path);
      continue;
    }
    if (diff.status === "conflict" && !opts.force) {
      result.refused.push(diff.path);
      continue;
    }
    toWrite.push(diff);
  }

  if (rootHandle) {
    for (const diff of toWrite) {
      const parts = diff.path.split("/");
      const name = parts.pop()!;
      let dir = rootHandle;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(diff.contents);
      await writable.close();
      result.written.push(diff.path);
    }
  } else {
    for (const diff of toWrite) {
      downloadText(diff.path.split("/").pop()!, diff.contents);
      result.written.push(diff.path);
    }
  }

  rememberWrites(toWrite);
  return result;
}

export function downloadText(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = before ? before.split("\n") : [];
  const b = after.split("\n");
  const setA = new Map<string, number>();
  for (const line of a) setA.set(line, (setA.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const n = setA.get(line) ?? 0;
    if (n > 0) setA.set(line, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of setA.values()) removed += n;
  return { added, removed };
}
