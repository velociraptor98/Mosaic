import { generateFiles, sceneClassName } from "../export/generate";
import {
  placeholderHeroSheetDataUrl,
  placeholderTilesetDataUrl,
} from "../../shared/tilesetImage";
import { DEFAULT_CONFIG, type ProjectConfig, type ProjectData } from "../../shared/types";
import {
  createSceneFromTemplate,
  placeholderObjectAssets,
  placeholderTilesetAsset,
  type TemplateId,
} from "../store/templates";
import { DEFAULT_GROUPS } from "../../shared/definitions";
import { SCRIPT_BASE_FILE, newScriptRef, scriptFilePath } from "../../shared/scripts";
import { samplePlayerController, scriptBaseSource } from "../scripts/stub";
import { CONFIG_PATH } from "./serialize";

/**
 * Plans a new project without touching the disk.
 *
 * The Review screen renders exactly what this returns, and the Creating step
 * commits exactly the same list — engineers own the folder, so the editor must
 * never write a file they did not see coming.
 */

export type Language = "ts" | "js";
export type Bundler = "vite" | "webpack" | "none";

export interface NewProjectOptions {
  name: string;
  /** Parent directory; the project folder is <location>/<slug>. */
  location: string;
  template: TemplateId;
  language: Language;
  bundler: Bundler;
  git: boolean;
  sampleArt: boolean;
  config: ProjectConfig;
}

export interface ScaffoldFile {
  rel: string;
  contents: string;
  encoding: "utf8" | "base64";
  /** Shown beside the path in the review tree. */
  note: string;
  /** Listed but struck through: the current options exclude it. */
  skipped: boolean;
}

export interface ScaffoldPlan {
  slug: string;
  root: string;
  files: ScaffoldFile[];
  project: ProjectData;
  /** Files that will actually be written. */
  writes: ScaffoldFile[];
}

export const DEFAULT_OPTIONS: NewProjectOptions = {
  name: "untitled",
  location: "",
  template: "platformer",
  language: "ts",
  bundler: "vite",
  git: true,
  sampleArt: true,
  config: DEFAULT_CONFIG,
};

/** npm package names: lowercase, url-safe, no leading or trailing dash. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "untitled"
  );
}

export function isValidNpmName(name: string): boolean {
  return slugify(name) === name.trim().toLowerCase() && name.trim().length > 0;
}

export function joinPath(parent: string, child: string): string {
  if (!parent) return child;
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return parent.endsWith(sep) ? `${parent}${child}` : `${parent}${sep}${child}`;
}

const PHASER_VERSION = "^4.2.1";

export function planScaffold(opts: NewProjectOptions): ScaffoldPlan {
  const slug = slugify(opts.name);
  const root = joinPath(opts.location, slug);
  // Script components are a TypeScript story: the @property decorator is what
  // the editor reads, and a JS project has no compiler configured to accept
  // one. A JS scaffold lists them as skipped rather than writing code that
  // will not build.
  const typed = opts.language === "ts";
  const e = typed ? "ts" : "js";
  const scene = createSceneFromTemplate("Level_01", "Level 01", opts.template, opts.config);

  const sampleScript = typed && (opts.template === "platformer" || opts.template === "runner");
  if (sampleScript) {
    // The template's player comes with behaviour attached, so a new project
    // opens on a worked example of the whole loop: class -> inspector -> file.
    const player = scene.objects.find((o) => o.type === "player");
    if (player) {
      player.scripts = [newScriptRef("PlayerController", scriptFilePath("PlayerController"))];
    }
  }

  const project: ProjectData = {
    name: opts.name.trim() || slug,
    config: opts.config,
    scenes: [scene],
    prefabs: [],
    assets: [placeholderTilesetAsset(), ...placeholderObjectAssets()],
    anims: [],
    groups: [...DEFAULT_GROUPS],
    collision: defaultMatrix(),
  };

  const generated = generateFiles(project, scene, "both");
  const sceneClass = generated.find((f) => f.path.endsWith(".ts") && f.path.includes("/scenes/"));
  const sceneJson = generated.find((f) => f.path.endsWith(".scene.json"));
  const manifest = generated.find((f) => f.path === "phaser.editor.json");

  const bundled = opts.bundler !== "none";
  const hasPlayer = opts.template !== "empty";
  const files: ScaffoldFile[] = [];

  const add = (
    rel: string,
    contents: string,
    note = "",
    skipped = false,
    encoding: "utf8" | "base64" = "utf8",
  ) => files.push({ rel, contents, note, skipped, encoding });

  add("package.json", packageJson(slug, opts), `name: ${slug}`);
  add(CONFIG_PATH, JSON.stringify(opts.config, null, 2) + "\n", "editor + scene defaults");
  add("phaser.editor.json", manifest?.contents ?? "{}\n", "editor manifest");
  add("index.html", indexHtml(opts.name, e), "");
  add(
    `vite.config.${e}`,
    bundled ? viteConfig(opts) : "",
    bundled ? "" : "skipped",
    !bundled || opts.bundler !== "vite",
  );
  add(
    `webpack.config.${e}`,
    opts.bundler === "webpack" ? webpackConfig(e) : "",
    opts.bundler === "webpack" ? "" : "skipped",
    opts.bundler !== "webpack",
  );
  add(`src/main.${e}`, mainFile(opts, e), "game config");
  add(
    `src/scenes/Level_01.${e}`,
    renameScene(sceneClass?.contents ?? "", e),
    "generated",
  );
  add("src/scenes/Level_01.scene.json", sceneJson?.contents ?? "{}\n", "editor source of truth");
  add(
    `src/prefabs/Player.${e}`,
    hasPlayer ? playerPrefab(e, opts) : "",
    hasPlayer ? "" : "skipped",
    !hasPlayer,
  );
  add(
    "assets/wire_32.png",
    opts.sampleArt ? stripDataUrl(placeholderTilesetDataUrl()) : "",
    opts.sampleArt ? "placeholder art" : "skipped",
    !opts.sampleArt,
    "base64",
  );
  add(
    "assets/hero_sheet.png",
    opts.sampleArt ? stripDataUrl(placeholderHeroSheetDataUrl()) : "",
    opts.sampleArt ? "placeholder art" : "skipped",
    !opts.sampleArt,
    "base64",
  );
  add(
    "tsconfig.json",
    typed ? tsconfigJson() : "",
    typed ? "decorators, for @property" : "skipped",
    !typed,
  );
  add(
    SCRIPT_BASE_FILE,
    typed ? scriptBaseSource() : "",
    typed ? "ScriptComponent + @property" : "skipped",
    !typed,
  );
  add(
    scriptFilePath("PlayerController"),
    sampleScript ? samplePlayerController() : "",
    sampleScript ? "attached to the player" : "skipped",
    !sampleScript,
  );
  add("anims.json", "[]\n", "");
  add(".gitignore", opts.git ? gitignore() : "", opts.git ? "" : "skipped", !opts.git);
  add("README.md", readme(opts, slug, e), "");

  return { slug, root, files, project, writes: files.filter((f) => !f.skipped) };
}

function stripDataUrl(url: string): string {
  const comma = url.indexOf(",");
  return comma === -1 ? "" : url.slice(comma + 1);
}

/** The generator names the class <Key>Scene; the scaffold file is Level_01.<ext>. */
function renameScene(contents: string, ext: string): string {
  return contents
    .replace(`export class ${sceneClassName("Level_01")}`, "export class Level_01")
    .replace(/from "\.\/Level_01\.scene\.json"/, `from "./Level_01.scene.json"${ext === "js" ? " with { type: \"json\" }" : ""}`);
}

function defaultMatrix() {
  const matrix: Record<string, Record<string, "collide" | "overlap" | "ignore">> = {};
  for (const a of DEFAULT_GROUPS) {
    matrix[a] = {};
    for (const b of DEFAULT_GROUPS) matrix[a][b] = "ignore";
  }
  const set = (a: string, b: string, rule: "collide" | "overlap") => {
    matrix[a][b] = rule;
    matrix[b][a] = rule;
  };
  set("player", "solid", "collide");
  set("player", "enemy", "overlap");
  set("player", "pickup", "overlap");
  set("player", "trigger", "overlap");
  set("enemy", "solid", "collide");
  return matrix;
}

function packageJson(slug: string, opts: NewProjectOptions): string {
  const scripts: Record<string, string> =
    opts.bundler === "vite"
      ? { dev: "vite", build: "vite build", preview: "vite preview" }
      : opts.bundler === "webpack"
        ? { dev: "webpack serve --mode development", build: "webpack --mode production" }
        : { dev: "echo \"serve index.html with any static server\"" };

  const devDeps: Record<string, string> = {};
  if (opts.bundler === "vite") devDeps.vite = "^8.2.0";
  if (opts.bundler === "webpack") {
    devDeps.webpack = "^5.97.0";
    devDeps["webpack-cli"] = "^5.1.4";
    devDeps["webpack-dev-server"] = "^5.2.0";
  }
  if (opts.language === "ts") devDeps.typescript = "~5.7.0";

  return (
    JSON.stringify(
      {
        name: slug,
        private: true,
        version: "0.0.0",
        type: "module",
        scripts,
        dependencies: { phaser: PHASER_VERSION },
        devDependencies: devDeps,
      },
      null,
      2,
    ) + "\n"
  );
}

function indexHtml(name: string, ext: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
    <style>
      html, body { margin: 0; height: 100%; background: #1d2d3d; }
      body { display: grid; place-items: center; }
      canvas { display: block; }
    </style>
  </head>
  <body>
    <script type="module" src="/src/main.${ext}"></script>
  </body>
</html>
`;
}

function viteConfig(opts: NewProjectOptions): string {
  return `import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { port: 5180 },
  build: { target: "es2022" },
});
${opts.config.pixelArt ? "\n// Pixel art: Phaser handles filtering; nothing extra is needed here.\n" : ""}`;
}

function webpackConfig(ext: string): string {
  return `import path from "node:path";

export default {
  entry: "./src/main.${ext}",
  output: { path: path.resolve("dist"), filename: "bundle.js" },
  devServer: { static: ".", port: 5180 },
  resolve: { extensions: [".${ext}", ".js"] },
};
`;
}

/** The game config mirrors mosaic.config.json, so the editor and the game agree. */
function mainFile(opts: NewProjectOptions, ext: string): string {
  const { canvas, scale, physics, pixelArt } = opts.config;
  const typed = ext === "ts";
  const physicsBlock =
    physics === "none"
      ? ""
      : physics === "matter"
        ? `  physics: { default: "matter", matter: { gravity: { y: 1 }, debug: false } },\n`
        : `  physics: { default: "arcade", arcade: { gravity: { x: 0, y: ${opts.template === "platformer" || opts.template === "runner" ? 900 : 0} }, debug: false } },\n`;

  return `// Mirrors mosaic.config.json — keep the two in step, or let the editor
// rewrite this file when the project defaults change.
import Phaser from "phaser";
import { Level_01 } from "./scenes/Level_01";

const config${typed ? ": Phaser.Types.Core.GameConfig" : ""} = {
  type: Phaser.AUTO,
  width: ${canvas.width},
  height: ${canvas.height},
  backgroundColor: "#1d2d3d",
  pixelArt: ${pixelArt},
  roundPixels: ${pixelArt},
  scale: { mode: Phaser.Scale.${scale === "NONE" ? "NONE" : scale}, autoCenter: Phaser.Scale.CENTER_BOTH },
${physicsBlock}  scene: [Level_01],
};

new Phaser.Game(config);
`;
}

function playerPrefab(ext: string, opts: NewProjectOptions): string {
  const typed = ext === "ts";
  const t = (s: string) => (typed ? s : "");
  return `import Phaser from "phaser";

/**
 * Generated by Mosaic. Property assignments come from the prefab definition;
 * anything you write between the keep markers survives a regeneration.
 */
export class Player extends Phaser.Physics.Arcade.Sprite {
  ${t("private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;\n  ")}constructor(scene${t(": Phaser.Scene")}, x${t(": number")}, y${t(": number")}) {
    super(scene, x, y, "obj-player");
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setCollideWorldBounds(true);
    this.cursors = scene.input.keyboard!.createCursorKeys();
    // <keep id="ctor">
    // </keep>
  }

  ${t("override ")}preUpdate(time${t(": number")}, delta${t(": number")})${t(": void")} {
    super.preUpdate(time, delta);
    const speed = 220;
    this.setVelocityX(
      this.cursors.left.isDown ? -speed : this.cursors.right.isDown ? speed : 0,
    );
${
  opts.template === "topdown"
    ? `    this.setVelocityY(
      this.cursors.up.isDown ? -speed : this.cursors.down.isDown ? speed : 0,
    );`
    : `    if (this.cursors.up.isDown && this.body${t("!")}.blocked.down) this.setVelocityY(-420);`
}
    // <keep id="update">
    // </keep>
  }

  // <keep id="body">
  // </keep>
}
`;
}

/**
 * Decorators are the one compiler setting a Mosaic project needs: `@property`
 * is what the editor reads out of a class, so a project that cannot compile
 * one cannot use script components.
 */
function tsconfigJson(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          experimentalDecorators: true,
          useDefineForClassFields: false,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n"
  );
}

function gitignore(): string {
  return `node_modules
dist
.DS_Store
*.local
`;
}

function readme(opts: NewProjectOptions, slug: string, ext: string): string {
  const run =
    opts.bundler === "none"
      ? "Serve `index.html` with any static server."
      : "```\nnpm install\nnpm run dev\n```";
  return `# ${opts.name}

A Phaser game, scaffolded by [Mosaic](https://example.invalid/mosaic).

${run}

## Layout

\`\`\`
src/scenes/Level_01.scene.json   the editor's source of truth
src/scenes/Level_01.${ext}${" ".repeat(Math.max(0, 12 - ext.length))}generated from it — edit inside // <keep> markers
src/prefabs/                     one class per prefab
src/scripts/                     ScriptComponent + the behaviour you attach
assets/                          art and audio, copied in by the editor
mosaic.config.json               canvas, tile size, scale mode, physics
\`\`\`

Open this folder in Mosaic to edit the scenes. Regenerating rewrites the
generated files around your keep regions; \`${slug}\`'s hand-written code is safe.
`;
}
