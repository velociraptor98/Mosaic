# Mosaic

**A layout tool for Phaser, beside your code.** The canvas is a real
`Phaser.Scene` rendering the real scene data; the surrounding UI is React. You
lay scenes out here and write the game in your own editor: every save writes a
generated layout file next to your scene classes, and RUN shows the project's
own game from its own dev server.

Built to the design documents that specify it — the editor workflows, the new
project flow, the logo sheet, and `Mosaic Script Inspector Flow.html`, the one
still in the tree, which specifies workflow 10 below.

Mosaic is a **desktop app**. It opens a project *folder*, treats the scene
files in it as the source of truth, watches them for edits made elsewhere, and
shows git status per file. It also builds the finished game into a folder you
can ship, without a terminal. The same renderer builds for the browser too, as a
zero-install demo with no folder access.

## Run it

```
npm install

npm run dev:app     # the desktop app (Electron + Vite dev server)
npm run dev         # the browser demo at the printed URL

npm run sample      # build the Coin Rush sample by driving the editor
npm run anim-lab    # build the Anim Lab sample
npm run breakout    # rebuild Phaser's breakout example as a Mosaic project

npm run build:app   # renderer + main/preload bundles
npm run lint

npm run pack        # an unsigned .app in release/ (electron-builder --dir)
npm run dist        # installers: dmg / nsis / AppImage for the host platform
```

There is no automated suite at the moment: the previous ones asserted on a
generator and an in-editor runtime that no longer exist, and were removed with
them.

## Layout beside code

Mosaic is a layout tool that sits next to a Phaser codebase, not a place the
game is built. One rule covers every file it touches:

**`*.layout.ts` is generated. Everything else is yours.**

```
src/main.ts                     game config and scene list        yours
src/scenes/Level_01.ts          the scene class                   yours — written once
src/scenes/Level_01.layout.ts   what the editor placed            generated on every save
src/scenes/Level_01.scene.json  the data the editor edits         Mosaic's
src/prefabs/Player.ts           a prefab's class                  yours — written once
src/prefabs/Player.layout.ts    its art and body, as a base class generated on every save
```

A generated file is rewritten whole, so it is never merged with anything and
there are no markers to work inside. A file that is yours is written when it
does not exist and never opened again. They meet through an import:

```ts
export class Level_01 extends Phaser.Scene {
  preload() { preloadLevel_01(this); }
  create() {
    const { player, terrain, groups } = createLevel_01(this, {
      playerPickup: (player, pickup) => pickup.destroy(),
    });
  }
}
```

`createLevel_01` returns every object typed and by name, the collision groups
that have members in the scene, and takes a hook per pair the collision matrix
wires.

## The eleven workflows, and where they live

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

**Fill grid** (`⌘⇧G`) stamps the selection across a grid in one undoable step,
defaulting the step to the selection's own footprint. It deliberately adds no
"repeat" to the scene format: a level is data, not a loop, so it still writes
one object per cell and every one stays selectable and movable afterwards.
What it removes is the fifty-four clicks, not the fifty-four objects.

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

### 4. Asset import & atlases — `assets/slice.ts`, `assets/atlasJson.ts`, `dialogs/ImportDialog`, `dialogs/AtlasDialog`
Type is inferred per file and shown for correction *before* the copy. Files are
copied into the project (as data URLs), never referenced from outside it.

The slicer does grid slicing with margin and spacing, or auto-detect by
transparency (flood-filled islands, tight bounding boxes). The overlay draws
real frame boundaries over the art before you commit. Names come from a
`{i}` pattern with optional zero padding; pivots are per sheet, and both the
place tool and the body editor read them.

Art that arrives **already packed** is read rather than re-cut. Pick a sheet
and its `.json` together and the image comes in as an atlas carrying the
packer's own frame names — all three shapes Phaser accepts (JSON hash, JSON
array, and `textures[0]` multi-atlas), because which one you get is decided by
the packer and not by the person importing. The document itself never becomes
an asset of its own: it is metadata about one. Invented names were the whole
problem — a scene says `frame: "blue1"`, and `frame_7` is not that.

### 5. Prefabs & instancing — `shared/prefabs.ts`, `shared/propagate.ts`
Making one object into many, in seven steps: **promote, isolate, compose,
expose, vary, place, propagate.**

**There are no engine object types.** An object is art plus the components put
on it: a texture, maybe a body, maybe scripts. `type` is a rendering hint
(`sprite` or `container`) and nothing downstream branches on it. The editor
ships six *placeholder shapes* — capsule, box, circle, triangle, star, diamond
— so a new project has something to place before you import art, and a new
project's starter content is written into your folder as ordinary prefab files
you can rename, edit or delete. What you place is an **asset** or a **prefab**;
there is no third, fixed palette of somebody else's game nouns.

**Promote.** A prefab starts as something already on screen. You build it in
the scene, then promote it — the dialog names the file and says what happens to
the thing you selected: it becomes the first instance rather than being
replaced by a copy. The scene node is rewritten in place, **keeping its id**, so
anything referencing it still resolves. A selection spanning two parents has no
single root and is refused with the reason; siblings of one parent are relinked
as instances together.

**Isolate.** `src/prefabs/<Name>.prefab.json` opens as its **own document** on
an empty stage, with its own undo stack, so nothing you drag can land in a
level. Scene documents stay open and their instances go on rendering from the
last *saved* definition until you push. The stage draws the prefab's bounds and
its origin, because those are the two things an instance cannot fix later.

**Compose.** The definition is a node tree with the same shape as a scene
subtree, so nothing new has to be learned to author one. Parts are addressed by
a stable **local id**, which is what lets an override survive a rename.

**Expose.** `exposed[]` is the contract with the levels: a checked field is
published to instances, an unchecked one never appears in a level inspector at
all. Fields the definition owns are shown **locked**, not hidden — a level
designer should see that the value exists and read who owns it. Unexposing a
field that instances override asks first, and names the count and the scenes.

**Vary.** A variant stores `{ base, diff }` and nothing else — three fields,
not a second copy of the object. Fixing the base fixes every variant except
where one deliberately disagreed. A variant of a variant is allowed; a third
level is refused, as is a cycle.

**Place.** Instances come from the asset browser onto the canvas, named for the
prefab and showing how many are already placed. Resolution is
`definition ← overrides`, shallow per property path, with the inheritance chain
resolved first. An instance whose definition has gone keeps its position and
its overrides and draws as a placeholder.

**Propagate.** Saving a prefab is the one edit that reaches into files you are
not looking at, so it is the one edit that lists its consequences first: which
scenes, which instances, which values **move**, which overrides are **kept**
because an instance claimed them, which are **dropped** because the field is no
longer published, and which scenes are **skipped** because they changed on disk
under you. Nothing is written until Push. *Push + review each* then walks the
affected scenes one at a time with the touched instances already selected.

### 5b. Text, camera and sound — content, not create()
Three things used to be authorable only in code, and all three are content:

**Text** is an object like any other — placed on the canvas, dragged, styled in
the inspector, and drawn by the editor exactly as the game will draw it.
`Pin to camera` is what makes a HUD a HUD: it ignores the camera, so a score
stays where you put it however far the level scrolls.

**The camera** is scene data: follow target, per-axis lerp, zoom, deadzone and
whether to clamp to the scene's bounds. Before this the exporter set a
background colour and world bounds and nothing else, so following the player
meant hand-written code in every scene. The follow call is emitted *after* the
objects, because a target has to exist before it can be followed, and a camera
pointed at a name the scene does not contain is a validation error.

**Sound** has two cues — `on spawn` and `on overlap` — plus looping scene
music. The overlap cue fires for any pair the collision matrix marks as
overlapping, and either participant's cue plays. Audio clips previously loaded
and were then never referenced by anything in the format; a clip a scene names
is now pulled into its loader manifest.

The line stays where it was: these are the values, not the logic. Anything
conditional — a sound only when the player is falling — is still a script.

### 6. Animation timeline — `ui/BottomDock.tsx`, `ui/AnimPreview.tsx`
The timeline takes over the asset dock so the canvas stays full size. Frames
are picked from a spritesheet or a sliced atlas, dragged to reorder, and can
carry a per-frame duration that overrides the global fps.

An animation stores frames, frame rate, a **repeat count** (`-1` forever, `0`
once, `N` more times) and **yoyo**, which plays the frames forward then back —
four frames of art become seven of motion, so it is the difference between
drawing four poses and drawing seven. `+ all` appends a whole sheet in order,
because building a sixty-frame clip one click at a time is not a workflow.

The preview runs the **real Phaser animation manager** on the real texture
bytes, so approved timing is shipped timing. An object names the animation it
plays on spawn; a missing key is a validation error, not a silent no-op.

Every animation the project defines is registered in the exported scene, not
only the ones an object names in `playOnSpawn`. Nothing in a scene file can say
what a script plays, and an animation that is merely absent fails at the moment
it is asked for — so `npm run anim-lab` builds a sample whose whole job is to
exercise this: a looping walk, a two-frame idle at 2fps, a one-shot with
per-frame durations, an animation on a prefab that instances inherit and one
overrides, and an animation played only from a script.

### 7. Physics & collision — `Inspector.tsx` (Physics), `dialogs/CollisionDialog`
Bodies are a *section of the object*, not a separate editor: box or circle,
size, offset, immovable, gravity, bounce. With BODIES on, the body draws over
the sprite with its own drag handles on a layer above the transform handles,
and the numbers stay live in the Inspector during the drag.

Pair rules are authored once per project in the collision matrix
(`collide | overlap | ignore`, symmetric) instead of being scattered through
`create()`. Export emits deduplicated `addCollider` / `addOverlap` calls —
**both with a handler**, and both with a keep region.

A `collide` pair used to be emitted bare, with nowhere to hang behaviour, so
anything that needed a physical response *and* to know it happened had to
register a second collider inside a script — two colliders on one pair, the
second running against bodies the first had already separated. Rebuilding
Phaser's breakout example is what made that unmissable: its two collisions are
the entire game, and both of them had to leave the feature built to describe
them.

The handler tells the **scripts on both objects** that they touched, through
`onContact(other, rule)`, each side handed the other one. So a brick's
behaviour lives on the Brick prefab and reaches all sixty instances without the
scene naming any of them. It is also what finally lets a `sounds.overlap` cue
fire on a collide, which it never could before.

**World edges** are scene data too. Arcade's bounds are one rectangle with a
flag per side, and Mosaic used to author only the rectangle — so a game that
needs an open edge could not say so. A breakout built on it ran, looked right,
and was unlosable, which is the bad kind of failure. Four checkboxes under
Scene; absent means all four closed, which is Arcade's own default and what
every scene written before this was built against.

### 8. Run the game — `phaser/playtest.ts`, `ui/GamePane.tsx`, `electron/devServer.ts`
On a project folder, RUN is the project's own game. Mosaic runs the `dev`
script from the folder's `package.json` — the same thing as typing
`npm run dev` — finds the address it prints, and shows that page beside the
canvas, opened at `?scene=<ClassName>` so it starts on the scene being edited.

The canvas stays editable next to it. Every save rewrites the layout files, the
dev server reloads, and the game shows the change. The server is started once
and kept between runs; it stops when the project closes or the app exits, by
any means — it watches a pipe the app holds, so a crash takes it down too.

Running a dev server executes the project's code, so a folder that has not been
trusted asks first. The answer is stored by the editor, per folder. A project
created through the New Project flow is trusted from the start.

Mosaic has no runtime of its own. There is nothing that plays a scene except
the game, so there is no second implementation of what a scene means to keep in
step with the first — and no RUN without a project folder, which is why the
browser build has none.

### 9. Generated code — `export/generate.ts`, `project/workspace.ts`
There is no export step. Saving a scene writes its layout, and only the files
whose bytes changed are written, so moving one sprite reloads one module.

The generator is **pure** — same project in, same bytes out. A scene layout
emits loads → world → layers bottom-up → groups → bodies → colliders →
animations → camera → music, and returns the objects. Prefabs become classes
**and the layout constructs them** — `new Coin(scene, x, y)` — so behaviour
written on a prefab's class actually runs. A prefab's layout is a base class
(`CoinBase`) holding its texture, body and defaults; your `Coin` extends it. A
variant extends its parent's class — yours, not the generated one — so
behaviour reaches variants by ordinary inheritance, and the variant restates
only what it changed. Tile data stays in the `.scene.json`, which the layout
imports.

A scene made in the editor gets its class written once; adding it to the game's
scene list is yours to do, because `main.ts` is yours. Deleting a scene or a
prefab deletes its data and its layout, and leaves the class.

`Code…` (`⌘E`) shows every file written for the current scene, whose it is, and
what it says. In the browser build, which has no folder, the same panel writes
through the File System Access API or downloads.

A project in JavaScript gets `.layout.js` files with the types left out; the
language comes from `mosaic.config.json`, or from whether the folder has a
`tsconfig.json`.

**Projects from before this.** A scene or prefab class the old generator wrote
is replaced by the new starting point when nothing was written inside its keep
markers. One that holds your code is left alone and reported: it is yours now,
and picks the layout up by importing it.

### 10. Behaviour — `scripts/parse.ts`, `scripts/registry.ts`, `ui/ScriptsTab.tsx`
**Behaviour lives in your classes.** A prefab's class is an ordinary Phaser
sprite subclass, and a field it marks `@property` is listed in the Scripts tab
for every instance:

```ts
export class Player extends PlayerBase {
  @property({ min: 0, max: 600 })
  speed = 220;

  override preUpdate(time: number, delta: number) { /* reads this.speed */ }
}
```

A value set there is stored on the object (`props`) and assigned in the layout
after the constructor runs — `player.speed = 400`. Set on the prefab's
definition it is the default for every instance; set on an instance it wins. A
value whose field has been removed from the class is kept in the scene file,
flagged, and left out of the layout rather than assigned to a property that no
longer exists.

**Script components are the optional second way**, for behaviour that attaches
to several kinds of object. The rest of this section is about them.

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

- **Contacts arrive as events.** A script implements `onContact(other, rule)`
  and hears about anything the project's collision matrix pairs its object
  with, handed the thing it touched. The matrix owns *whether* two groups
  interact and what physics does about it; this is how the object finds out.
  A contact that lands before `create()` has run is dropped rather than
  delivered to a script that has not initialised.
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
- **Your game runs them.** The layout constructs one `ScriptHost` per scene,
  and the host owns their update loop. A script that throws is switched off
  rather than allowed to take the frame loop with it.
- **The layout wires it up.** It constructs the `ScriptHost`, then
  `scripts.add(player, new PlayerController(), { moveSpeed: 220 })` in list
  order, with `, false` for a disabled script. Two classes of one name in
  different folders are imported under distinct aliases — and so is a script
  that shares its name with a **prefab**, which is the case that actually bit:
  `Brick` the prefab and `Brick` the behaviour is the obvious way to name that
  object, and it emitted two imports of one name and a file that would not
  compile, whose first error named neither of them. `runtime/scripts.ts`
  is the base class, the `@property` decorator and the host — one file, type
  checked here, copied verbatim into your project as
  `src/scripts/ScriptComponent.ts`, so what the editor parses and what your
  game runs cannot drift apart.

### 11. Ship the game — `electron/packageGame.ts`, `dialogs/PackageDialog`
Saving writes source. **Export game…** (`⌘⇧E`) writes the thing you send
someone: one folder — `index.html`, a single `game.js` with Phaser linked into
it, and a copy of `assets/` — that runs with nothing installed. "The game is
finished" used to be the point where Mosaic handed you back to a terminal.

It uses the bundler Mosaic already carries for importing a hand-written
project. A shipped build has nothing to borrow Phaser from, so here it is linked in — the project's own
copy when it has one, Mosaic's when the folder has never had `npm install` run
in it, which is what lets a folder that has only ever been opened in the editor
build at all. The report says which was used. Phaser is handed to the bundler as
*source* rather than as a path, because in a packaged Mosaic it lives inside an
asar: transparent to Node's fs, and not to the bundler's own file reads.

Building is destructive inside its output folder, so the wipe is licensed
narrowly: the path has to be inside the project, it cannot be `src/`, `assets/`,
`node_modules/` or `.git/`, and a folder that already holds files has to carry
the `.mosaic-build` marker Mosaic writes. A folder Mosaic did not write is
refused, not emptied.

`Zip when done` writes `<outDir>.zip` with `index.html` at the archive root,
which is what a host that takes a zip expects. The archive is written by hand
with `zlib` — stored or deflated per file, whichever is smaller — because a
packaging dependency in an app whose whole pitch is that your game does not need
one would be an odd thing to add.

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
| Generated code | written on every save | File System Access API, else download |
| RUN | the project's own dev server | unavailable — no project to run |
| Storage ceiling | none | ~5MB, warned about in the status bar |

`platform.canOpenProjects` is the flag every folder-aware feature checks.
Nothing above that seam — the store, the canvas, any panel — knows which
target it is running on.

### How the desktop build is put together

```
electron/
  main.ts        window + app lifecycle; registers the asset protocol and IPC
  appIcon.ts     the mark, rasterised into the window and dock icon
  packageGame.ts    bundles the whole game into a shippable folder, and zips it
  preload.ts     the ONLY bridge: contextBridge -> window.mosaic
  contract.ts    channel names + payload types, shared by main and renderer
  ipc.ts         fs, native dialogs, chokidar watcher, git status
  assets.ts      mosaic:// protocol serving files out of the project folder
  devServer.ts   starts and stops the project's own dev server for RUN
```

`contextIsolation` is on and `nodeIntegration` is off; the renderer never sees
Node. Every path crossing IPC — and every URL the asset protocol serves — is
resolved against the project root and refused if it escapes.

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

## Packaging Mosaic itself

(For packaging *your game*, see workflow 11 — that is `Export game…`, and it
needs none of the below.)

`npm run pack` writes an unsigned app to `release/`; `npm run dist` writes
installers.

Three details the config exists for:

- **`chokidar` and `rolldown` are `dependencies`, not devDependencies.** Both
  are imported by the main process at run time — the watcher and the script
  compiler. A packager ships only `dependencies`, so anything the built
  `main.mjs` imports has to be one.
- **`asarUnpack: ["**/@rolldown/**"]`.** Rolldown's compiler is a Rust binary,
  and a `.node` cannot be loaded from inside an asar.
- **`directories.output: "release"`.** electron-builder defaults to `dist/`,
  which is where the renderer bundle already lives.
- **`node_modules/phaser` is listed in `files`.** `Export game…` links Phaser
  into a project that may have none of its own, so the copy it falls back to has
  to survive packaging. Specifying `files` at all replaces electron-builder's
  default, which would otherwise have brought it along.

The bundle icon comes from `npm run icon`, which writes `build/icon.png` at
1024² from the same geometry the UI and the running app draw — electron-builder
derives `.icns` and `.ico` from it. Nothing about the mark is checked in as a
bitmap.

Signing, when the certificates exist: a Developer ID Application cert plus
`hardenedRuntime` and an entitlements file on macOS.

## Design

The UI follows the design tokens in `Phaser Editor Workflows.html`. `src/tokens.css`
carries that document's `:root` block verbatim — palette, ramps, type, spacing,
radii, elevation — followed by a short, commented set of additions, and then the
**dark ground** from `token.html`, which is the block that actually ships. The
light block is kept above it as the reference it was derived from; swapping the
two is the whole of a theme switch.

- **Ground** `#14171a` ink, `#1e2226` input surfaces, `#e6e9ec` text, hairline
  `--color-divider` rules. Panels are separated by 1px lines, not by fills.
- **Accent** `#7ba3cc` carries every selected state: a 12–16% tint with
  `--color-accent-800` text for selection, solid accent with `--color-bg` text
  for primary actions and the collision matrix's *collide* cell.
- **The ramps invert, the steps don't.** On the dark ground both tonal ramps run
  dark→light, so a step keeps its *meaning*: 700–900 is still "readable ink
  against the ground" and 100–300 is still "a quiet fill sitting on it". Every
  rule written against the light ground therefore survives the swap untouched.
  Only rules that pinned a literal colour against a ramp step needed restating,
  and there were three of them.
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
  validation and write conflicts.
- **Canvas gizmos.** `EditorScene`'s `INK` table draws every gizmo from the
  accent ramp — selection at `accent`, handles at `accent-800`, guides at
  `accent-400`, bodies at `accent-900`. Because the palette is monochrome by
  design, bodies are told apart from selection by *line style* (dashed) rather
  than by inventing a hue for them. These are the one part of the palette the
  ground does **not** move: gizmos are drawn over the *scene's* background,
  which is the user's data, so they stay tuned to that rather than to the
  editor's chrome.

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
    definitions.ts  Placeholder tileset + placeholder SHAPES (not game roles)
    size.ts         How big a thing is drawn — read from its art, not its type
    textures.ts     Procedural placeholder art (Phaser)
    tilesetImage.ts The placeholder tileset as a PNG data URL (no Phaser)
    logoGeometry.ts The mark's 3x3 grid — drawn by the UI, the app icon and the
                    headless suite, so there is one set of numbers
    logoBitmap.ts   That geometry rasterised: the app icon, with no bitmap
                    checked into the repo
    prefabs.ts      Resolution: base <- variant diff, then definition <-
                    instance overrides; local ids, bounds, tree diffing
    propagate.ts    What a definition change costs, worked out before it
                    happens: moved / kept / dropped / skipped, by scene
    transform.ts    Hierarchy maths, cycle rejection, world<->local
    manifest.ts     Derives the Phaser loader manifest from a scene

  runtime/         ships inside your game — zero editor deps
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
                    playtest.ts (RUN: the project's dev server),
                    PhaserHost.tsx, snapping.ts,
                    textures.ts
    assets/         slice.ts (grid + auto-detect slicing, frame naming),
                    atlasJson.ts (reading an atlas document that already
                    exists, in any of the three shapes Phaser accepts)
    scripts/        parse.ts (@property declarations, statically), registry.ts
                    (the index, kept warm by the watcher), trust.ts
                    (per-folder consent to run code), stub.ts (templates)
    export/         generate.ts (layouts and starting-point classes), write.ts
    commands.ts     command registry, bindings, palette search
    ui/             MenuBar, Toolbar, LeftDock, Inspector, ScriptsTab,
                    SourceDrawer, BottomDock, StatusBar, Logo, fields, dialogs/
    bridge.ts       60fps canvas chatter (cursor, drag previews)

scripts/sample-game/
                   builds the samples by driving the editor: Coin Rush (a
                   playable game, and the build guide) and Anim Lab (built to
                   exercise the animation feature rather than to be a game)
scripts/breakout/  rebuilds Phaser's own breakout example as a Mosaic project,
                   to answer whether a whole game somebody else already wrote
                   fits the model. build.ts authors it through the editor's
                   API and logs every step
```

### Rebuilding somebody else's game

Every workflow above is checked against a game Mosaic did not design.
`npm run breakout` rebuilds Phaser's own `breakout.js` example — the wall, the
ball, the paddle, the rules — as a Mosaic project, authored entirely through
the editor's own API: `planScaffold` plans the folder, `ProjectStore` performs
each edit as a real undoable transaction, `projectToFiles` and
`generateProjectFiles` write the result. There is no script-only path into the project format, so
anything the editor cannot express does not get quietly written anyway — the
builder records those as **friction** in its step log and prints them when it
finishes.

The first run printed four. Closing them is most of what the physics, atlas and
grid notes above describe:

| Friction | Now |
|---|---|
| the matrix could not say "collide, *and* tell me" | `collide` pairs get a handler; scripts get `onContact` |
| world bounds were one rectangle, not four sides | `Scene → World edges` |
| an existing Phaser atlas could not be imported | picked with its `.json`, frame names kept |
| sixty placements were sixty clicks | `Fill grid` — the same scene in 50 edits instead of 98 |

The same exercise is what turned up the duplicate-identifier bug in the
generator: naming a prefab and its behaviour the same thing — the obvious
choice — emitted a file that would not compile.

### Why undo is slice-based

A transaction records only the slices it changed (`scene:<key>`, `prefabs`,
`assets`, `anims`, `groups`, `collision`, `meta`) and pushes one entry onto the
**active document's** stack. Undoing an edit in one scene therefore cannot
rewind a later edit in another. An open
prefab is a document too: it gets a `doc` slice and a stack of its own, and its
modified marker compares the definition against what was stored rather than
counting undo depth, so editing an asset while it is open does not make it read
as unsaved. Asset payloads are
compared by length + prefix, so a transaction never walks megabytes of base64.

## Known limits

- **Browser build only:** the project lives in `localStorage` with assets
  inlined as data URLs, so a large project will exceed the quota (the status
  bar says so), and there is no folder, no watching, no git and no
  `Export game…`. The desktop build has none of these limits.
- `Export game…` targets the **web**: a folder, and optionally a zip. Wrapping
  that into a `.app`/`.exe` would mean shipping and extracting an Electron
  runtime per platform, which is a different feature and not a flag on this one.
- The atlas document is paired with its image **by filename** — `kit.png` next
  to `kit.json`. Picking both at once is the normal case and works; importing
  them separately, or into a folder where the name already exists and gets
  suffixed, will not pair them.
- `sounds.overlap` keeps its name now that it fires on collide pairs too. The
  field is older than the callback, and renaming it would rewrite every scene
  that has one for no gain.
- The desktop app packages **unsigned**. `npm run pack` produces a working
  `.app`, but code signing, notarization and auto-update are not set up, so
  macOS quarantines a downloaded build (`xattr -dr com.apple.quarantine` clears
  it for local use). Signing needs certificates, not code — see Packaging.
- Because rolldown ships a **native binding**, builds are per-platform: a
  Windows binary has to be built on Windows. The same binding is why
  `asarUnpack` exists in the build config, and why the bundle is ~400MB.
- Arcade physics only. Bodies are box or circle; arbitrary polygons are a
  Matter concern and are not modelled.
- RUN needs a `dev` (or `start`/`serve`) script in `package.json` and installed
  dependencies. The game pane has no pause, step or live inspector — the loop
  belongs to the game. Open it in a browser (↗) for devtools.
- Starting on the edited scene relies on the game honouring `?scene=`; the
  scaffold's `main.ts` does, and an existing project runs from wherever it
  normally boots until it is taught to.
- A new scene's class is written for you, but adding it to the game's scene
  list is manual.
- The layout exposes every placed object as a field, so a scene with sixty
  bricks has sixty typed fields. Collections are reached through `groups`.
- Prefab layouts cover a prefab's root: a child node inside a prefab is drawn by
  the editor, and is not yet emitted into the class.
- The sample builders (`sample`, `anim-lab`, `breakout`) write the new file
  shape, but `breakout` needs a checkout of the Phaser examples for its art.
- An arcade group applies its OWN defaults to every child it takes —
  `collideWorldBounds` off, `allowGravity` on, drag, acceleration — so a body
  has to be configured *after* it joins its group, which is why the layout
  emits bodies after groups.
- Collision groups and the starter prefabs are project data with genre-ish
  names (`player`, `pickup`, `Player`, `Pickup`). They are a starting point,
  not a fixed set — rename or delete them and nothing in the editor cares.
- A variant claims structure whole: if it changes its children, it stores the
  child list rather than a per-child diff, so later structural changes on the
  base do not flow into it. Property changes on the base still do.
- **rolldown** is a runtime dependency of the desktop build: it bundles a
  hand-written project for importing, and the whole game for `Export game…`.
- Script components are a TypeScript story: `@property` needs a compiler
  configured for decorators, which the scaffold's `tsconfig.json` provides. A
  JavaScript project lists the script files as skipped rather than writing code
  that will not build.
