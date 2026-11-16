import { resolve } from "node:path";

import { buildCoinRun } from "./build";
import { buildHoldout } from "./holdout/build";

/**
 * `npm run sample [-- <folder>] [-- <name>…]` builds the samples into
 * samples/: Coin Run and Holdout, or only the ones named.
 */
const builders = { "coin-run": buildCoinRun, holdout: buildHoldout } as const;

const [target = resolve(process.cwd(), "samples"), ...only] = process.argv.slice(2);
for (const [name, build] of Object.entries(builders)) {
  if (only.length && !only.includes(name)) continue;
  const result = build(target);
  console.log(`Built ${result.root}`);
  console.log(
    `  ${result.files} files · ${result.objects} objects · ${result.prefabs} prefabs · ${result.edits} undoable edits`,
  );
  const issues = "issues" in result ? result.issues : [];
  for (const issue of issues) console.log(`  ${issue.level}: ${issue.message}`);
}
