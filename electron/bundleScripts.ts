import path from "node:path";
import { rolldown } from "rolldown";
import type { ScriptBundle, ScriptEntry } from "./contract";

/**
 * Bundles the project's script classes so the play-test can actually run them.
 *
 * The main process stays dumb about what a script *is*: the renderer owns the
 * index and hands over the exact classes it wants, by path and name. All this
 * does is compile and link them.
 *
 * Three decisions worth knowing about:
 *
 * - **Phaser stays external.** The editor already has a Phaser instance and the
 *   objects the scene builds belong to it; bundling a second copy would break
 *   every `instanceof` a script does. It is passed into the bundle as a global
 *   instead.
 * - **IIFE, not ESM.** The renderer evaluates the result directly, so there is
 *   no module URL to resolve bare specifiers against — and an IIFE's externals
 *   are plain runtime property lookups, which is exactly what handing it a
 *   Phaser instance needs.
 * - **Legacy decorators.** `@property` is the whole point of the format, and it
 *   is what the scaffold's tsconfig configures.
 */

const VIRTUAL_ENTRY = "\0mosaic:scripts";

export async function bundleScripts(
  root: string,
  entries: ScriptEntry[],
): Promise<ScriptBundle> {
  if (!entries.length) return { code: null, warnings: [], modules: [] };

  const warnings: string[] = [];
  try {
    const build = await rolldown({
      input: { scripts: VIRTUAL_ENTRY },
      cwd: root,
      platform: "browser",
      external: ["phaser"],
      transform: { decorator: { legacy: true } },
      // A script that fails to compile is a message in the editor, not a crash
      // and not a wall of text on someone's terminal.
      onLog(level, log) {
        if (level === "warn") warnings.push(log.message);
      },
      plugins: [
        {
          name: "mosaic:script-entry",
          resolveId(source: string, importer: string | undefined) {
            if (source === VIRTUAL_ENTRY) return source;
            // The virtual entry addresses the project by relative path, so
            // resolution stays inside the folder the user opened.
            if (importer === VIRTUAL_ENTRY) return path.resolve(root, source);
            return null;
          },
          load(id: string) {
            return id === VIRTUAL_ENTRY ? entryModule(entries) : null;
          },
        },
      ],
    });

    const { output } = await build.generate({
      format: "iife",
      name: "MosaicScripts",
      globals: { phaser: "__mosaicPhaser" },
      sourcemap: false,
    });
    await build.close();

    const chunk = output.find((o) => o.type === "chunk");
    if (!chunk || chunk.type !== "chunk") {
      return { code: null, error: "the bundler produced no output", warnings, modules: [] };
    }

    // Every file that went in, so the renderer knows which edits invalidate the
    // build — including helpers that are not script classes themselves.
    const modules = Object.keys(chunk.modules ?? {})
      .filter((id) => !id.startsWith("\0"))
      .map((id) => path.relative(root, id).split(path.sep).join("/"))
      .filter((rel) => !rel.startsWith(".."));

    return { code: chunk.code, warnings, modules };
  } catch (err) {
    return { code: null, error: message(err), warnings, modules: [] };
  }
}

/**
 * The virtual entry: import every class the renderer asked for, and export them
 * under `<src>::<class>` so two classes of one name in different folders stay
 * apart — the same key the editor's index uses.
 */
function entryModule(entries: ScriptEntry[]): string {
  const imports: string[] = [];
  const pairs: string[] = [];
  entries.forEach((entry, i) => {
    imports.push(`import { ${entry.className} as C${i} } from ${JSON.stringify(entry.src)};`);
    pairs.push(`  ${JSON.stringify(`${entry.src}::${entry.className}`)}: C${i},`);
  });
  return `${imports.join("\n")}\nexport default {\n${pairs.join("\n")}\n};\n`;
}

function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Rolldown's diagnostics carry ANSI colour and the full frame; the editor
  // shows one readable line and keeps the rest for the console.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\[[0-9;]*m/g, "").split("\n").slice(0, 6).join("\n").trim();
}
