import { generateProjectFiles, prefabClassPath } from "../export/generate";
import { placeholderHeroSheetDataUrl } from "../../shared/tilesetImage";
import { encodePngBase64 } from "../../shared/png";
import { placeholderImages } from "../../shared/rasterise";
import { DEFAULT_CONFIG, type ProjectConfig, type ProjectData } from "../../shared/types";
import {
  createSceneFromTemplate,
  defaultMatrix,
  placeholderObjectAssets,
  placeholderTilesetAsset,
  type TemplateId,
} from "../store/templates";
import { DEFAULT_GROUPS } from "../../shared/definitions";
import { SCRIPT_BASE_FILE } from "../../shared/scripts";
import { scriptBaseSource } from "../scripts/stub";
import { CONFIG_PATH, MANIFEST_PATH, prefabPath, scenePath, toManifest } from "./serialize";

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
  // `@property` is a decorator, and a JS project has no compiler configured
  // to accept one. A JS scaffold gets the same layout and the same classes,
  // minus the decorated fields.
  const typed = opts.language === "ts";
  const e = typed ? "ts" : "js";
  const { scene, prefabs } = createSceneFromTemplate(
    "Level_01",
    "Level 01",
    opts.template,
    opts.config,
  );

  const config: ProjectConfig = { ...opts.config, language: opts.language };
  const project: ProjectData = {
    name: opts.name.trim() || slug,
    config,
    scenes: [scene],
    prefabs,
    assets: [placeholderTilesetAsset(), ...placeholderObjectAssets()],
    anims: [],
    groups: [...DEFAULT_GROUPS],
    collision: defaultMatrix(),
  };

  // The same files a save writes, so a project is in step with the editor
  // from the first byte rather than from the first edit.
  const code = generateProjectFiles(project, { language: opts.language });

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
  add(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "editor + scene defaults");
  add(MANIFEST_PATH, JSON.stringify(toManifest(project), null, 2) + "\n", "editor manifest");
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
  add(scenePath(scene.key), JSON.stringify(scene, null, 2) + "\n", "what the editor edits");
  for (const prefab of prefabs) {
    add(
      prefabPath(prefab.name),
      JSON.stringify(prefab, null, 2) + "\n",
      "starter prefab — yours to rename or delete",
    );
  }
  const playerPath = prefabClassPath("Player", opts.language);
  for (const file of code) {
    if (file.language === "json") continue;
    // The one class with something in it: a new project should move when you
    // press a key, and the place that lives is the player's own class.
    const contents = file.path === playerPath && hasPlayer ? playerClass(e, opts) : file.contents;
    add(
      file.path,
      contents,
      file.owner === "generated" ? "generated — rewritten on every save" : "yours — written once",
    );
  }
  // The placeholder art the manifest declares, at the paths it declares. These
  // used to be drawn by the editor and never written, so an exported game
  // asked for five textures that did not exist and rendered nothing.
  for (const image of placeholderImages()) {
    add(image.path, encodePngBase64(image.bitmap), "placeholder art", false, "base64");
  }
  // The hero sheet still needs a DOM to draw, so a headless caller gets none
  // rather than a zero-byte PNG that every image decoder then rejects.
  const heroSheet = opts.sampleArt ? stripDataUrl(placeholderHeroSheetDataUrl()) : "";
  add(
    "assets/hero_sheet.png",
    heroSheet,
    heroSheet ? "sample spritesheet" : "skipped",
    !heroSheet,
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
    typed ? "@property, and optional script components" : "skipped",
    !typed,
  );
  add("anims.json", "[]\n", "");
  add(".gitignore", opts.git ? gitignore() : "", opts.git ? "" : "skipped", !opts.git);
  add("README.md", readme(opts, e), "");

  return { slug, root, files, project, writes: files.filter((f) => !f.skipped) };
}

function stripDataUrl(url: string): string {
  const comma = url.indexOf(",");
  return comma === -1 ? "" : url.slice(comma + 1);
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

  return `import Phaser from "phaser";
import { Level_01 } from "./scenes/Level_01${typed ? "" : ".js"}";

// Every scene the game has. A scene made in Mosaic gets a class of its own in
// src/scenes/ — add it here, the way you would any other.
const scenes = [Level_01];

// Mosaic's RUN opens the game at ?scene=<ClassName>, so it starts on the scene
// you are editing rather than wherever the game normally boots.
const first = new URLSearchParams(window.location.search).get("scene");
scenes.sort((a, b) => Number(b.name === first) - Number(a.name === first));

const config${typed ? ": Phaser.Types.Core.GameConfig" : ""} = {
  type: Phaser.AUTO,
  width: ${canvas.width},
  height: ${canvas.height},
  backgroundColor: "#1d2d3d",
  pixelArt: ${pixelArt},
  roundPixels: ${pixelArt},
  scale: { mode: Phaser.Scale.${scale === "NONE" ? "NONE" : scale}, autoCenter: Phaser.Scale.CENTER_BOTH },
${physicsBlock}  scene: scenes,
};

new Phaser.Game(config);
`;
}

/**
 * The player's class, as a Phaser developer would write it: a sprite subclass
 * that reads the keyboard in preUpdate. The numbers are @property fields, so
 * they can be tuned from the editor without the behaviour leaving the code.
 */
function playerClass(ext: string, opts: NewProjectOptions): string {
  const typed = ext === "ts";
  const t = (s: string) => (typed ? s : "");
  const topdown = opts.template === "topdown";
  const prop = (options: string) => (typed ? `@property(${options})\n  ` : "");
  return `import Phaser from "phaser";
${typed ? `import { property } from "../scripts/ScriptComponent";\n` : ""}import { PlayerBase } from "./Player.layout${typed ? "" : ".js"}";

/**
 * Player — this file is yours.
 *
 * The art and the body come from PlayerBase (./Player.layout.${ext}, regenerated
 * by Mosaic on every save). What the player DOES is here.${typed ? `
 *
 * A field marked @property shows up in Mosaic's inspector, and the value set
 * there is assigned after the constructor runs.` : ""}
 */
export class Player extends PlayerBase {
  ${prop("{ min: 0, max: 600 }")}speed = 220;
${
  topdown
    ? ""
    : `
  ${prop(`{ label: "jump velocity", min: -1200, max: 0 }`)}jumpVelocity = -420;
`
}
  ${t("private ")}cursors${t(": Phaser.Types.Input.Keyboard.CursorKeys")};

  constructor(scene${t(": Phaser.Scene")}, x${t(": number")}, y${t(": number")}) {
    super(scene, x, y);
    this.cursors = scene.input.keyboard${t("!")}.createCursorKeys();
  }

  ${t("override ")}preUpdate(time${t(": number")}, delta${t(": number")})${t(": void")} {
    super.preUpdate(time, delta);
    const { left, right, up, down } = this.cursors;
    this.setVelocityX(left.isDown ? -this.speed : right.isDown ? this.speed : 0);
${
  topdown
    ? `    this.setVelocityY(up.isDown ? -this.speed : down.isDown ? this.speed : 0);`
    : `    void down;
    if (up.isDown && this.body.blocked.down) this.setVelocityY(this.jumpVelocity);`
}
  }
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
  // `build/` is where Export game… writes. A shipped build is 1.6MB of
  // regenerated bytes, and the first one should not arrive as untracked noise.
  return `node_modules
dist
build
.DS_Store
*.local
`;
}

function readme(opts: NewProjectOptions, ext: string): string {
  const run =
    opts.bundler === "none"
      ? "Serve `index.html` with any static server."
      : "```\nnpm install\nnpm run dev\n```";
  return `# ${opts.name}

A Phaser game, scaffolded by [Mosaic](https://example.invalid/mosaic).

${run}

## Layout

\`\`\`
src/main.${ext}                      the game config and the scene list — yours
src/scenes/Level_01.${ext}           the scene class — yours
src/scenes/Level_01.layout.${ext}    what the editor placed — generated
src/scenes/Level_01.scene.json   the data the editor edits
src/prefabs/Player.${ext}            a prefab's class — yours
src/prefabs/Player.layout.${ext}     its art and body — generated
assets/                          art and audio, copied in by the editor
mosaic.config.json               canvas, tile size, scale mode, physics
\`\`\`

One rule covers all of it: **\`*.layout.${ext}\` is generated, everything else is
yours.** Open this folder in Mosaic to lay scenes out. Every save rewrites the
layout files and nothing else, so \`npm run dev\` reloads with what you just
placed, and Mosaic never opens a file you wrote.

A scene's \`create()\` gets its objects from the layout, by name:

\`\`\`${ext}
create() {
  const { player, terrain } = createLevel_01(this);
}
\`\`\`
`;
}
