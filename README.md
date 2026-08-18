# Mosaic

**Scene editor for Phaser.** A WYSIWYG editor for Phaser games. The canvas is a real `Phaser.Scene`
rendering the real scene data; the surrounding UI is React. Scenes are plain
JSON that the editor, the play-test and a shipped game all read — there is no
import step to lose data in.

Built to the design documents that specify it — the editor workflows, the new
project flow, the logo sheet, and `Mosaic Script Inspector Flow.html`, the one
still in the tree, which specifies workflow 10 below.

Mosaic is a **desktop app**. It opens a project *folder*, treats the scene
files in it as the source of truth, watches them for edits made elsewhere, and
shows git status per file. The same renderer also builds for the browser, as a
zero-install demo with no folder access.

## Run it

```
npm install

npm run dev:app     # the desktop app (Electron + Vite dev server)
npm run dev         # the browser demo at the printed URL

npm run smoke:all   # both test suites
npm run smoke       # headless pass over the editor's logic (180 checks)
npm run smoke:app   # boots the real shell against a real folder (106 checks)

npm run build:app   # renderer + main/preload bundles
npm run lint

npm run pack        # an unsigned .app in release/ (electron-builder --dir)
npm run dist        # installers: dmg / nsis / AppImage for the host platform
npm run smoke:packed  # runs the desktop suite against the PACKAGED app (macOS arm64)
```

## The ten workflows, and where they live

### 1. Project & scenes — `project/workspace.ts`, `project/serialize.ts`, `store/project.ts`
The editor opens a *folder*, not a file — `readProject(dir)` parses
`phaser.editor.json`, and chokidar watches the tree and re-reads on change. The
Project tab lists every scene, prefab, script, asset and animation, with an
unsaved marker and **the git status of each**. New scenes come from templates (Empty /
Platformer / Top-down) that write a runnable scene — camera, tile layer, a
player with a body. Keys are derived and collision-free before write.

Switching scenes keeps each scene's **selection, camera and undo stack** alive:
`ProjectStore.views` and `ProjectStore.stacks` are keyed by scene.

`⌘K` opens the command palette — fuzzy search over commands ∪ scenes ∪ assets ∪
prefabs, scoped by the `scene:`, `asset:`, `prefab:` and `>` prefixes. Every
command shows its binding, and every binding runs the same command object.

### 2. Scene composition — `phaser/EditorScene.ts`, `phaser/snapping.ts`
Selecting an asset in the dock arms the place tool; clicking the canvas
instantiates it on the active object layer, snapped, already selected.

Dragging emits transient preview frames and commits **one** transaction on
mouse-up (`store.beginStroke` / `endStroke`), so a 40-frame drag costs one undo.
The Inspector writes the same values and commits on blur or ⏎.

Snap targets are the tile grid ∪ the edges of on-screen objects, with a 6px
*screen-space* threshold divided by zoom so it holds at any magnification.
Holding **Alt** suspends snapping for a single drag instead of toggling it.

Outliner rows drag to reparent. World position is preserved
(`local = parentInverse × world`) and cycles are rejected. Containers carry
their own transform, and clicking a child picks the container until the
container is selected, at which point the click drills in.

### 3. Tilemap & layers — `LeftDock.tsx` (Layers), `Inspector.tsx` (Tiles)
Tile layers and object layers share **one** ordered list, because draw order
must be one ordering and not two. Layer order is render order and becomes the
Phaser depth on export.

Tile layers use Phaser's native `Tilemap` API — a generated tileset *image*,
`addTilesetImage`, `createLayer`, `putTileAt` — so what the editor paints is
what Phaser renders. Painting only pushes the cells that actually changed.

A stroke is one transaction, not one per tile. Rect fill and the eraser
(`putTile(-1)`) use the same shape. Collision flags live on the *tileset*, so
terrain is authored once. Visibility and lock are scene data, not editor
preferences: a locked layer ignores every pointer event and hit-testing walks
visible ∧ unlocked layers top-down.

### 4. Asset import & atlas slicing — `assets/slice.ts`, `dialogs/ImportDialog`, `dialogs/AtlasDialog`
Type is inferred per file and shown for correction *before* the copy. Files are
copied into the project (as data URLs), never referenced from outside it.

The slicer does grid slicing with margin and spacing, or auto-detect by
transparency (flood-filled islands, tight bounding boxes). The overlay draws
real frame boundaries over the art before you commit. Names come from a
`{i}` pattern with optional zero padding; pivots are per sheet, and both the
place tool and the body editor read them.

### 5. Prefabs & instancing — `shared/prefabs.ts`
Creating a prefab replaces each selected object with `{prefab, transform,
overrides}` and writes the definition. You choose which property paths
instances may override; fields that already differ across the selection become
overrides automatically rather than being flattened.

Resolution is `definition ← overrides`, shallow per property path. Overridden
fields are marked in the Inspector and revertible; editing an unexposed field
is refused with a message rather than silently written. Editing the definition
propagates to every instance in every scene *except* the fields an instance
overrides.

### 6. Animation timeline — `ui/BottomDock.tsx`, `ui/AnimPreview.tsx`
The timeline takes over the asset dock so the canvas stays full size. Frames
are picked from a spritesheet or a sliced atlas, dragged to reorder, and can
carry a per-frame duration that overrides the global fps.

The preview runs the **real Phaser animation manager** on the real texture
bytes, so approved timing is shipped timing. An object names the animation it
plays on spawn; a missing key is a validation error, not a silent no-op.

### 7. Physics & collision — `Inspector.tsx` (Physics), `dialogs/CollisionDialog`
Bodies are a *section of the object*, not a separate editor: box or circle,
size, offset, immovable, gravity, bounce. With BODIES on, the body draws over
the sprite with its own drag handles on a layer above the transform handles,
and the numbers stay live in the Inspector during the drag.

Pair rules are authored once per project in the collision matrix
(`collide | overlap | ignore`, symmetric) instead of being scattered through
`create()`. Export emits deduplicated `addCollider` / `addOverlap` calls, with
a handler argument for overlap pairs.

### 8. Play-test in editor — `phaser/playtest.ts`, `phaser/PlayScene.ts`
RUN snapshots the editor state (it does not mutate it), then boots the scene
**into the same canvas** through `runtime/loadScene.ts` — the same builder a
shipped game calls. Arcade debug draw is on, so a body that is four pixels
wrong is obvious.

While it runs, the Inspector binds to the live instance: writes apply
immediately and are marked *volatile*, and velocity / onFloor are read back.
Pause freezes the loop; step advances exactly one physics update. STOP restores
the pre-play snapshot exactly and offers to promote the runtime tweaks worth
keeping — promotion is one undoable transaction; the restore itself is not.

### 9. Export to Phaser — `export/generate.ts`, `export/write.ts`, `export/keep.ts`
Targets: scene JSON, a typed `Scene` class, or both. The generator is **pure** —
same scene in, same bytes out — so diffs stay small enough to read in review.

Emit order is `preload` → `create` (layers bottom-up) → colliders →
animations, with play-on-spawn calls emitted after the animations they need.
Prefabs become classes **and the scene constructs them** — `new Coin(this, x, y)`
— so behaviour you write on a prefab actually runs. The definition's properties
live in the class constructor; an instance emits only what it overrides, which
is what keeps propagation working after export. Tile data stays in the
`.scene.json`, which the class imports, so the source carries no walls of
literal numbers.

Writing shows a diff first. Where the browser supports the File System Access
API you can point the editor at your real source tree and it writes there;
otherwise it downloads. Code between `// <keep id="…">` markers is carried
across every regeneration, and a file with edits *outside* a keep region is
refused rather than clobbered (`overwrite anyway` is an explicit choice).
Watch re-emits on every change so a running dev server stays in step.

Export changes nothing in the scene: the editor and the generated code read the
same `scene.json`.

### 10. Script components — `scripts/parse.ts`, `scripts/registry.ts`, `ui/ScriptsTab.tsx`
The scene shows what a script does; **the file stays the source of truth**. A
class in your own `src/` marks fields with `@property`, and Mosaic renders
those fields in the Scripts tab. The class says what exists; the scene says
what it is set to. Editing a value writes into `scene.json`, never into
your `.ts`.

Scene data is `scripts: [{ class, src, enabled, props }]` per object. The
editor resolves class → file through an index built on project open and kept
warm by the same watcher that reloads scenes: `readScripts` hands the renderer
every source file under `src/`, and `parse.ts` reads the declarations out of
them **statically** — Mosaic never executes your game code to find out what it
exposes, which is also why the index survives a file that does not compile
(the fields grey out and the last good metadata stays).

- **Order is execution order.** Rows run top to bottom, drag or ↑↓ to reorder,
  and the order is written back to the file. The checkbox is *enabled* state,
  not deletion: a disabled script keeps its values and is still constructed at
  runtime, so re-enabling it mid-game just works.
- **Only declared fields are editable.** `@property` carries type, label,
  min/max and enum options; objects and callbacks render read-only with a *code
  only* tag. A field removed from the class keeps its value in the scene file,
  flagged rather than deleted; a field whose type changed offers a conversion
  instead of coercing silently.
- **Attach from what the project has.** The picker lists real exported classes
  extending `ScriptComponent` — no free-text class names, because an attach
  that cannot resolve is not worth offering. Abstract and non-exported classes
  are indexed (a subclass needs them) but not offered. Nothing matches?
  *Create script…* writes `src/scripts/<Name>.ts` from the stub, indexes it and
  attaches it in one action. A class already attached asks before duplicating,
  and duplicates are numbered `#2`.
- **The Project tab lists them.** Every file under `src/` that declares a
  component shows in the folder view beside the scenes, prefabs and assets,
  with its classes, its git status, how many objects across the project run it,
  and ↗ to open it in your editor. Clicking one opens it read-only.
- **View source** opens the file in a read-only drawer with the declarations
  the inspector is rendering highlighted, so the mapping from field to code is
  obvious. External saves re-index and refresh the field list in place; the
  text you are reading gets a *reload* banner rather than moving underneath
  you. *Open in editor* hands the file to `$MOSAIC_EDITOR`, then `code`,
  `cursor`, `subl`, then the OS handler — at the property's line where it can.
- **Prefab vs instance.** Scripts live on the prefab; an instance stores only
  the diff. A value edit records `scripts.<i>.props.<field>`; a structural edit
  (attach, detach, reorder) makes the instance own the whole list and folds the
  per-value overrides in, so nothing is applied twice. *Apply to prefab* pushes
  the diff up, *Revert* drops it.
- **Play-test runs them.** RUN compiles the project's classes with rolldown in
  the main process — Phaser stays external and is handed the editor's own
  instance, so a script's `instanceof` is asked against the same Phaser that
  built the sprite — and the result is evaluated in the renderer and passed to
  `buildScene`. Editing a script while the scene is playing recompiles and
  restarts it on the new code; a file that does not compile leaves the run
  alive on the last good build and says so. A script that throws is switched
  off rather than allowed to take the frame loop with it.
- **Running project code is asked for, once.** Everywhere else Mosaic reads
  source; play-test executes it. So a project with behaviour asks before its
  first run, and the answer is remembered **by the editor, per folder** — never
  in the project, where the project could grant itself the permission.
- **Export wires it up.** The generated scene constructs one `ScriptHost`, then
  `this.scripts.add(player, new PlayerController(), { moveSpeed: 220 })` in list
  order, with `, false` for a disabled script. Two classes of one name in
  different folders are imported under distinct aliases. `runtime/scripts.ts`
  is the base class, the `@property` decorator and the host — one file, type
  checked here, copied verbatim into your project as
  `src/scripts/ScriptComponent.ts`, so what the editor parses and what your
  game runs cannot drift apart.

## The New Project flow

Implements `Mosaic New Project Flow.html` — seven screens from launcher to
first tile. Every choice writes a real file; nothing is remembered only in the
editor.

| Screen | Where |
|---|---|
| 1. Launcher | `ui/Launcher.tsx` |
| 2. Template | `ui/newproject/NewProjectFlow.tsx` |
| 3. Details | ” |
| 4. Scene defaults | ” |
| 5. Review | ” |
| 6. Creating | ” |
| 7. First run | `ui/FirstRunChecklist.tsx` |

- **Launcher** — recents carry scene count, Phaser version and last-opened, so
  the right project can be picked without opening it. A folder that has moved
  greys out with a Locate… action; it is never silently dropped.
- **Templates** are runnable, not stubs: Empty, Platformer, Top-down and
  Endless runner each produce a real scene with a camera, a tilemap layer and a
  controllable object already wired.
- **Details** validates while you type — parent writable, target free, npm-name
  validity, node/npm present — so a bad target is caught before the create
  button rather than after it. The folder is created on confirm, not here.
- **Scene defaults** are project config, not per-scene settings: they land in
  `mosaic.config.json` and are mirrored into the generated Phaser game config,
  so the tenth scene matches the first.
- **Review** shows the whole diff, skipped files included and struck through.
  Engineers own the folder; the editor should never surprise them with a file
  they did not see coming.
- **Creating** is transactional — any failure part-way rolls the folder back,
  so cancelling leaves nothing on disk. Dependency install is spawned in the
  background and the editor opens as soon as the scene file exists; install
  failure is a status-bar banner, not a blocker.
- **First run** shows a five-item checklist bound to real state — it ticks from
  *doing* the thing, so it ticks itself if you get there before reading it.
  Dismissal is stored per project and never returns.

`project/scaffold.ts` plans the whole thing as pure data: the Review screen
renders exactly what it returns, and Creating commits exactly the same list.

## Desktop vs browser

One renderer, two targets, with a single seam between them: `src/editor/platform`.

| | Desktop (Electron) | Browser |
|---|---|---|
| Project | a folder on disk | localStorage |
| Assets | files, served over `mosaic://` | inlined data: URLs |
| Saving | debounced write into the folder | debounced write to localStorage |
| External edits | watched (chokidar), reloaded | n/a |
| Scripts | indexed from `src/**`, attachable | unavailable — no source tree |
| Git status | per file in the Project panel | n/a |
| Export | straight into the project | File System Access API, else download |
| Storage ceiling | none | ~5MB, warned about in the status bar |

`platform.canOpenProjects` is the flag every folder-aware feature checks.
Nothing above that seam — the store, the canvas, any panel — knows which
target it is running on.

### How the desktop build is put together

```
electron/
  main.ts        window + app lifecycle; registers the asset protocol and IPC
  appIcon.ts     the mark, rasterised into the window and dock icon
  bundleScripts.ts  compiles the project's script classes for the play-test
  preload.ts     the ONLY bridge: contextBridge -> window.mosaic
  contract.ts    channel names + payload types, shared by main and renderer
  ipc.ts         fs, native dialogs, chokidar watcher, git status
  assets.ts      mosaic:// protocol serving files out of the project folder
  smoke.ts       the desktop end-to-end suite
```

`contextIsolation` is on and `nodeIntegration` is off; the renderer never sees
Node. Every path crossing IPC — and every URL the asset protocol serves — is
resolved against the project root and refused if it escapes, which the desktop
suite asserts with an encoded traversal.

Assets are served over `mosaic://asset/<root>/<path>` rather than inlined.
That is what removes the storage ceiling: a 4MB spritesheet stays a file and is
streamed, where the browser build has to carry its bytes inside the project
JSON.

### Saving, watching, and not clobbering

Edits persist into the folder on a 400ms debounce. Because a save fires the
same watcher events an external edit does, the echo is filtered **by comparing
content**, not by a time window — a window races any edit made shortly after a
save and swallows it silently. If a file changes on disk while the scene has
unsaved edits, Mosaic says so instead of overwriting either side.

## Packaging

`npm run pack` writes an unsigned app to `release/`; `npm run dist` writes
installers. The whole desktop suite can be run against the *packaged* bundle
rather than the source tree — `npm run smoke:packed` — which is what catches
the things packaging breaks and nothing else does: asar paths, a dependency
that was only ever a devDependency, a native module that cannot be loaded from
inside an archive.

Three details the config exists for:

- **`chokidar` and `rolldown` are `dependencies`, not devDependencies.** Both
  are imported by the main process at run time — the watcher and the script
  compiler. A packager ships only `dependencies`, so anything the built
  `main.mjs` imports has to be one.
- **`asarUnpack: ["**/@rolldown/**"]`.** Rolldown's compiler is a Rust binary,
  and a `.node` cannot be loaded from inside an asar.
- **`directories.output: "release"`.** electron-builder defaults to `dist/`,
  which is where the renderer bundle already lives.

The bundle icon comes from `npm run icon`, which writes `build/icon.png` at
1024² from the same geometry the UI and the running app draw — electron-builder
derives `.icns` and `.ico` from it. Nothing about the mark is checked in as a
bitmap.

Signing, when the certificates exist: a Developer ID Application cert plus
`hardenedRuntime` and an entitlements file on macOS. One entitlement is
specific to this app — the play-test evaluates compiled scripts with
`new Function`, so the hardened runtime needs `com.apple.security.cs.allow-jit`.

## Design

The UI follows the design tokens in `Phaser Editor Workflows.html`. `src/tokens.css`
carries that document's `:root` block verbatim — palette, ramps, type, spacing,
radii, elevation — followed by a short, commented set of additions.

- **Ground** `#f2f2f3` paper, `#e9e9ea` input surfaces, `#1d1f20` ink, hairline
  `--color-divider` rules. Panels are separated by 1px lines, not by fills.
- **Accent** `#5980a6` carries every selected state: a 12–16% tint with
  `--color-accent-800` text for selection, solid accent with `--color-bg` text
  for primary actions and the collision matrix's *collide* cell.
- **Square corners everywhere.** The reference's blueprint pass zeroes the
  radius on `.card/.btn/.input/.tag/.seg/.dialog`; the editor does the same, so
  the radius tokens are defined but deliberately unused.
- **Type** — "Barlow Condensed" 600 for headings and every chrome label
  (uppercase, `0.09em` tracked), "Barlow" for prose, "IBM Plex Mono" for
  numeric readouts, ids, paths and generated code. The reference's own woff2
  subsets are served from `public/fonts`, so it renders identically offline.
- **Registration marks** bracket the canvas, the way the reference brackets its
  blueprint frames.

Two things the reference had no need for, and how they were derived:

- **State hues.** A specification document never has to mark a field invalid.
  `--color-danger` and `--color-caution` are mixed to the same OKLCH lightness
  as the accent so they read as siblings of it, and are used only for
  validation, write conflicts and the volatile-edit banner.
- **Canvas gizmos.** `EditorScene`'s `INK` table draws every gizmo from the
  accent ramp — selection at `accent`, handles at `accent-800`, guides at
  `accent-400`, bodies at `accent-900`. Because the palette is monochrome by
  design, bodies are told apart from selection by *line style* (dashed) rather
  than by inventing a hue for them.

The placeholder tiles and objects are drawn from the same ramps, at steps far
enough apart to stay distinguishable by value, so a scene reads as one drawing
rather than as programmer art dropped onto a designed surface.

### Identity

`src/editor/ui/Logo.tsx` holds the mark: a 3×3 grid on a
26-unit canvas, 8-unit tile and 1-unit gutter — the canvas grid itself. Seven
set tiles read as an **M**; the two open tiles are the cells not yet painted.

The size ladder is part of the mark, so `MosaicMark` takes a size and derives
the rest: stroke on the open tiles thickens from 1 → 1.2 → 1.5 as it shrinks,
and below 16px they fill solid. That solid cut is what the favicon and the
menu-strip mark use.

Placement follows the sheet's *Applied — editor header* panel: the full lockup
in the title bar (mark + wordmark, Barlow Condensed 700 at 0.2em tracking,
followed by the `project / scene` readout), and the solid 14px mark alone in the
tool strip, where a wordmark would compete with the tool labels.
`public/app-icon.svg` is the reversed cut on `--color-accent-900` — the one
filled field the sheet permits.

The **desktop app icon is that same cut, rasterised at boot** rather than
checked in as a bitmap: `shared/logoBitmap.ts` draws the mark from
`shared/logoGeometry.ts` — the numbers the React `<MosaicMark>` and the
headless suite also read — and `electron/appIcon.ts` wraps it in a PNG for
`nativeImage`. Coverage is computed exactly per pixel (these are axis-aligned
rectangles; supersampling would be the long way round), and the window and the
macOS dock both take the result. No bitmap in the repo means no bitmap to drift
from the mark.

## Layout

```
src/
  shared/          imported by BOTH the editor and your game — no React, no UI
    types.ts        Project / Scene / Layer / Object / Prefab / Anim schema
    definitions.ts  Built-in tileset + object types
    textures.ts     Procedural placeholder art (Phaser)
    tilesetImage.ts The placeholder tileset as a PNG data URL (no Phaser)
    logoGeometry.ts The mark's 3x3 grid — drawn by the UI, the app icon and the
                    headless suite, so there is one set of numbers
    logoBitmap.ts   That geometry rasterised: the app icon, with no bitmap
                    checked into the repo
    prefabs.ts      Resolution: definition <- overrides, per property path
    transform.ts    Hierarchy maths, cycle rejection, world<->local
    manifest.ts     Derives the Phaser loader manifest from a scene

  runtime/         ships inside your game — zero editor deps
    loadScene.ts    preloadProject / buildScene: tilemaps, sprites, bodies,
                    animations and the collision matrix
    scripts.ts      ScriptComponent, the @property decorator and the host that
                    runs them; copied into your project by the scaffold

  tokens.css       the reference document's design tokens
  styles.css       editor chrome built from them

  editor/
    platform/       the desktop/browser seam: types.ts, electron.ts, browser.ts
    project/        serialize.ts (folder <-> ProjectData), scaffold.ts (the
                    new-project plan), workspace.ts (opening, saving,
                    watching, git, background install)
    store/          project.ts (state + slice-based undo), undo.ts,
                    templates.ts, ids.ts
    phaser/         EditorScene.ts (tools, snapping, handles, body editing),
                    PlayScene.ts, playtest.ts, PhaserHost.tsx, snapping.ts,
                    textures.ts
    assets/slice.ts grid + auto-detect slicing, frame naming
    scripts/        parse.ts (@property declarations, statically), registry.ts
                    (the index, kept warm by the watcher), runtime.ts (the
                    compiled classes + per-project trust), stub.ts (templates)
    export/         generate.ts, keep.ts, write.ts
    commands.ts     command registry, bindings, palette search
    ui/             MenuBar, Toolbar, LeftDock, Inspector, ScriptsTab,
                    SourceDrawer, BottomDock, StatusBar, Logo, fields, dialogs/
    bridge.ts       60fps canvas chatter (cursor, drag previews, transport)

scripts/smoke.ts   headless pass over every workflow's logic
```

### Why undo is slice-based

A transaction records only the slices it changed (`scene:<key>`, `prefabs`,
`assets`, `anims`, `groups`, `collision`, `meta`) and pushes one entry onto the
**active scene's** stack. Undoing an edit in one scene therefore cannot rewind a
later edit in another — `npm run smoke` asserts exactly that. Asset payloads are
compared by length + prefix, so a transaction never walks megabytes of base64.

### Using an exported scene in your game

```ts
import Phaser from "phaser";
import { preloadProject, buildScene } from "./runtime/loadScene";
import project from "./phaser.editor.json";
import scene from "./scenes/Level_01.scene.json";

class Level1 extends Phaser.Scene {
  preload() { preloadProject(this, project, scene); }
  create() {
    const { objectsById, groups, tileLayers } = buildScene(this, project, scene);
    // your gameplay wiring from here
  }
}
```

Or export the generated `Level_01Scene.ts` and edit it directly — your code
inside the keep markers survives every regeneration.

## Known limits

- **Browser build only:** the project lives in `localStorage` with assets
  inlined as data URLs, so a large project will exceed the quota (the status
  bar says so), and there is no folder, no watching and no git. The desktop
  build has none of these limits.
- The desktop app packages **unsigned**. `npm run pack` produces a working
  `.app`, but code signing, notarization and auto-update are not set up, so
  macOS quarantines a downloaded build (`xattr -dr com.apple.quarantine` clears
  it for local use). Signing needs certificates, not code — see Packaging.
- Because rolldown ships a **native binding**, builds are per-platform: a
  Windows binary has to be built on Windows. The same binding is why
  `asarUnpack` exists in the build config, and why the bundle is ~400MB.
- Arcade physics only. Bodies are box or circle; arbitrary polygons are a
  Matter concern and are not modelled.
- Play-test ships a default player controller (arrows/WASD, jump on gravity
  scenes) so RUN does something; real behaviour belongs in your exported code.
- Prefabs are single-node: a prefab's child objects are stored in the
  definition but neither rendered nor exported as children.
- Play-test compiles scripts with **rolldown**, which is therefore a runtime
  dependency of the desktop build, and it runs them with `new Function` in the
  renderer. That is the user's own code by construction — but it is not a
  sandbox, which is why the trust prompt exists and why the browser build
  refuses outright.
- A hot restart replays the scene from the pre-play snapshot; **in-flight game
  state is not carried across** a script edit. That is the honest reading of
  "the code changed", and it keeps the result reproducible.
- Script components are a TypeScript story: `@property` needs a compiler
  configured for decorators, which the scaffold's `tsconfig.json` provides. A
  JavaScript project lists the script files as skipped rather than writing code
  that will not build.
