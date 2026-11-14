import { platform } from "../platform";
import type { GeneratedFile } from "./generate";

/**
 * Putting generated code somewhere.
 *
 * On desktop this is not a step: the project is a folder, and every save
 * writes the layout files into it (see Workspace.saveNow). What is left here is
 * the browser build, which has no folder — it writes through the File System
 * Access API when the browser has one and downloads otherwise — and the diff
 * the "Generated code" panel shows on either.
 *
 * The rule is the same everywhere: a `generated` file is overwritten, a
 * `yours` file is written only when it does not exist.
 */

export type DiffStatus = "new" | "changed" | "unchanged" | "kept";

export interface FileDiff {
  path: string;
  status: DiffStatus;
  contents: string;
  previous: string | null;
  addedLines: number;
  removedLines: number;
  language: GeneratedFile["language"];
  owner: GeneratedFile["owner"];
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

/** The open project's folder on desktop. Set by the Workspace on open. */
let projectRoot: string | null = null;

export function setProjectRoot(root: string | null): void {
  projectRoot = root;
}

export function canWriteToDisk(): boolean {
  if (projectRoot) return true;
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/** True when saving already writes these files, so there is nothing to press. */
export function writesGoToProject(): boolean {
  return projectRoot !== null;
}

export function connectedFolder(): string | null {
  return projectRoot ?? rootHandle?.name ?? null;
}

export async function chooseFolder(): Promise<string | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> })
    .showDirectoryPicker;
  if (!picker) return null;
  rootHandle = await picker({ mode: "readwrite" });
  return rootHandle?.name ?? null;
}

async function readExisting(path: string): Promise<string | null> {
  if (projectRoot) return platform.readText(projectRoot, path);
  if (!rootHandle) return null;
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
  const out: FileDiff[] = [];
  for (const file of generated) {
    const onDisk = await readExisting(file.path);
    let status: DiffStatus;
    if (onDisk === null) status = "new";
    else if (file.owner === "yours") status = "kept";
    else if (onDisk === file.contents) status = "unchanged";
    else status = "changed";

    // A file that is yours is shown as it is on disk: that is what the game
    // runs, and the starting point it was written from no longer matters.
    const contents = status === "kept" ? onDisk! : file.contents;
    const { added, removed } =
      status === "kept" ? { added: 0, removed: 0 } : lineDelta(onDisk ?? "", contents);
    out.push({
      path: file.path,
      status,
      contents,
      previous: onDisk,
      addedLines: added,
      removedLines: removed,
      language: file.language,
      owner: file.owner,
    });
  }
  return out;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
  failed: string[];
  mode: "disk" | "download";
}

export async function writeFiles(diffs: FileDiff[]): Promise<WriteResult> {
  const result: WriteResult = {
    written: [],
    skipped: [],
    failed: [],
    mode: projectRoot || rootHandle ? "disk" : "download",
  };

  const toWrite: FileDiff[] = [];
  for (const diff of diffs) {
    if (diff.status === "unchanged" || diff.status === "kept") result.skipped.push(diff.path);
    else toWrite.push(diff);
  }

  if (projectRoot) {
    const outcome = await platform.writeFiles(
      projectRoot,
      toWrite.map((d) => ({ rel: d.path, contents: d.contents })),
    );
    result.written.push(...outcome.written);
    for (const failure of outcome.failed) result.failed.push(`${failure.rel} (${failure.error})`);
  } else if (rootHandle) {
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
