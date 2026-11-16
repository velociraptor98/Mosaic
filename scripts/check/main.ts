// Must come first: it makes the editor load as the desktop app.
import { recorded } from "./desktop";

import { readFileSync } from "node:fs";
import path from "node:path";

import { Workspace } from "../../src/editor/project/workspace";
import { ProjectStore } from "../../src/editor/store/project";
import { platform } from "../../src/editor/platform";

// The one thing on the open path that reaches for the DOM rather than the
// bridge. There is no document here, on purpose: code that draws placeholder
// art checks for one, and does the right thing in Node without it.
platform.setWindowTitle = () => {};

/**
 * `npm run check` — opening a project must not change it.
 *
 * Each folder is opened the way the desktop app opens it, its source indexed,
 * and then saved. Every file that save would write is compared with what is on
 * disk, and any difference fails the check: a file the editor rewrites just
 * because it was opened is a diff in git nobody made, and has more than once
 * been a scene quietly losing what its author did.
 *
 * Nothing is written. The bridge only records.
 */

async function check(root: string): Promise<string[]> {
  recorded.writes.length = 0;
  recorded.removed.length = 0;
  const problems: string[] = [];

  const store = new ProjectStore();
  const workspace = new Workspace(store);
  if (!(await workspace.open({ root, name: path.basename(root) }))) return [`could not open ${root}`];
  // The index decides which class fields a layout assigns, so it has to be in
  // before the save, as it is a moment after opening in the app.
  await workspace.scripts.load(root);
  await workspace.saveNow();
  workspace.close();

  for (const file of recorded.writes) {
    let onDisk: string | null = null;
    try {
      onDisk = readFileSync(path.join(root, file.rel), file.encoding === "base64" ? "base64" : "utf8");
    } catch {
      onDisk = null;
    }
    if (onDisk === null) problems.push(`would create ${file.rel}`);
    else if (onDisk !== file.contents) problems.push(`would rewrite ${file.rel}${firstDifference(onDisk, file.contents)}`);
  }
  for (const rel of recorded.removed) problems.push(`would delete ${rel}`);
  for (const issue of workspace.issues) problems.push(`issue on open: ${issue}`);
  for (const issue of store.validate()) {
    if (issue.level === "error") problems.push(`invalid: ${issue.message}`);
  }
  return problems;
}

/** Where two versions of a file first part ways, as a line number and both lines. */
function firstDifference(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return `\n      line ${i + 1}\n      - ${(a[i] ?? "").trim().slice(0, 100)}\n      + ${(b[i] ?? "").trim().slice(0, 100)}`;
  }
  return "";
}

const folders = process.argv.slice(2);
if (!folders.length) {
  console.error("usage: check <project folder>…");
  process.exit(2);
}

let failed = false;
for (const folder of folders) {
  const root = path.resolve(folder);
  const problems = await check(root);
  failed ||= problems.length > 0;
  console.log(`${problems.length ? "FAIL" : "ok  "}  ${folder}${problems.length ? "" : " — opens without changing a byte"}`);
  for (const problem of problems) console.log(`      ${problem}`);
}
// The workspace leaves a debounce or two behind; there is nothing left to wait for.
process.exit(failed ? 1 : 0);
