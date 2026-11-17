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
npm run sample      # build the test samples into samples/: Coin Run and Holdout
npm run check       # rebuild them, open each as the app does (fails if opening would change a byte),
                    # then open the two fixtures of a game Mosaic did not make

npm run build:app   # renderer + main/preload bundles
npm run lint

npm run pack        # an unsigned .app in release/ (electron-builder --dir)
npm run dist        # installers: dmg / nsis / AppImage for the host platform
```

There is no unit suite at the moment: the previous ones asserted on a
generator and an in-editor runtime that no longer exist, and were removed with
them. `npm run check` is the one automated gate. It opens each sample through
the real Workspace — with a Node stand-in for the desktop bridge that reads the
way the main process reads (`electron/projectFiles.ts`) and only records
writes — and fails on any file that opening and saving would create, change or
delete.

It then opens the two fixtures in `scripts/check/fixtures/`. `phaser2` has the
shape of every game in the phaser-examples collection, and must be refused with
nothing written. `phaser3-template` has the shape of Phaser's own Vite template
(scenes in `src/game/scenes`, art in `public/assets`, the game constructed on
`DOMContentLoaded`). It must open with no scenes and nothing written. Laying out
`Game` must write exactly its data and layout beside the class, load art by the
URL the game serves it at, and reopen without changing a byte.

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
    const { player, terrain, groups } = createLevel_01(this);
    this.physics.add.collider(player, terrain);
    this.physics.add.overlap(player, groups.pickup, (_p, pickup) => pickup.destroy());
  }
}
```

`createLevel_01` returns every object typed and by name, each tile layer, the
Tiled maps themselves, and every group the project defines. It
places things and sizes their bodies. **What collides with what is your code**
— the two lines above — because that is already how every Phaser game says it.

Two things Mosaic deliberately does not do, because an established tool or
convention already does:

| | Where it lives instead |
|---|---|
| Painting tiles | [Tiled](https://www.mapeditor.org). Mosaic places the map and draws it. |
| Collision rules | `physics.add.collider` / `overlap` in the scene class. |

## The eleven workflows, and where they live

### 1. Project & scenes — `project/workspace.ts`, `project/serialize.ts`, `store/project.ts`
The editor opens a *folder*, not a file — `readProject(dir)` parses
`phaser.editor.json`, and chokidar watches the tree and re-reads on change. The
Project tab lists every scene, prefab, source file, asset and animation, with an
unsaved marker and **the git status of each**. New scenes come from templates (Empty /
Platformer / Top-down) that write a runnable scene — camera, a Tiled map, a
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

**F** frames the selection, and with nothing selected the whole scene;
double-clicking a row in the Outliner selects and frames it. It zooms out as far
as it must to fit and never zooms in past 100% on its own, so finding one crate
in a big level still shows the level around it.

**Fill grid** (`⌘⇧G`) stamps the selection across a grid in one undoable step,
defaulting the step to the selection's own footprint. It deliberately adds no
"repeat" to the scene format: a level is data, not a loop, so it still writes
one object per cell and every one stays selectable and movable afterwards.
What it removes is the fifty-four clicks, not the fifty-four objects.

Outliner rows drag to reparent. World position is preserved
(`local = parentInverse × world`) and cycles are rejected. Containers carry
their own transform, and clicking a child picks the container until the
container is selected, at which point the click drills in.

### 3. Tiled maps & layers — `shared/tiled.ts`, `Inspector.tsx` (Map), `LeftDock.tsx` (Layers)
Terrain is a [Tiled](https://www.mapeditor.org) map. Mosaic does not edit
tiles: it finds the maps in `assets/`, places one in a scene, and draws it.
`Open in Tiled` hands the file over; saving there redraws the canvas here,
without a reload, so the undo history and the selection survive every save.

A map is recognised by what is in it rather than by its name — `.tmj` or
`.json` — and is drawn by **Phaser's own Tiled parser**, in the editor's canvas
and in the game alike, which is what makes the two agree. Tilesets have to be
embedded in the map (Phaser cannot load external ones; the Map tab says so when
one is), and each tileset's image is matched to a project asset by the path the
map states, then by file name.

Each tile layer of a map is **one row in the scene's layer list**, alongside
the object layers, because draw order must be one ordering and not two. That
is how an object layer comes to sit between the ground and the treetops. A
layer added in Tiled appears above its map's others the next time the file is
read; one renamed or deleted there is dropped. A scene may place only some of a
map's layers — a title screen drawing just the ground — and a layer it leaves
out stays out: only a layer new to the map is added.

A tile with the custom property `collides` (bool) is solid: the layout calls
`setCollisionByProperty({ collides: true })` on the layer. Nothing collides
*with* the layer until the scene's code adds a collider for it.

The map is also handed back whole — `layout.maps.Level_01` — so object layers,
tile lookups and anything else Tiled can express are reachable from code.

Mosaic writes a map in exactly two cases, once each: the starter terrain of a
template, and the conversion of a tile layer painted in the editor it used to
have. Both are ordinary `.tmj` files from then on. Visibility and lock are
scene data, not editor preferences.

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
packer's own frame names — every shape Phaser loads (JSON hash, JSON array,
`textures[0]` multi-atlas, and the Starling `.xml` that `load.atlasXML` takes
and Kenney's packs ship), because which one you get is decided by the packer
and not by the person importing. The layout loads the JSON Mosaic writes beside
the sheet; it carries a pivot only for a frame whose pivot was set, because
Phaser resets the origin to a frame's pivot on every frame change. The document itself never becomes
an asset of its own: it is metadata about one. Invented names were the whole
problem — a scene says `frame: "blue1"`, and `frame_7` is not that.

### 5. Prefabs & instancing — `shared/prefabs.ts`, `shared/propagate.ts`
Making one object into many, in seven steps: **promote, isolate, compose,
expose, vary, place, propagate.**

**There are no engine object types.** An object is art plus the components put
on it: a texture, maybe a body, maybe a class. `type` is a rendering hint
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

What the game's code makes and nobody places — a bullet, an explosion, an enemy
a spawner lets out — starts from art instead: **◆+** on an asset card names the
prefab, picks the frame and optionally gives it a body, and opens the
definition on its stage. Nothing lands in a scene.

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

**Sound** has one cue — `on spawn` — plus looping scene music. A prefab plays
its cue from its own constructor, so an explosion made with `new` sounds like a
placed one. Every clip the project has is loaded, as every animation is
registered: nearly all sound is played by code, and a scene file cannot say
which. A sound on contact is behaviour, and is played from code.

The line stays where it was: these are the values, not the logic. Anything
conditional — a sound only when the player is falling — is still code.

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
plays on spawn; a missing key is a validation error, not a silent no-op. A
prefab plays it from its constructor, so `new Explosion(scene, x, y)` from code
plays it too — which is why the layout registers animations before it builds
anything.

Every animation the project defines is registered in the exported scene, not
only the ones an object names in `playOnSpawn`. Nothing in a scene file can say
what your code plays, and an animation that is merely absent fails at the moment
it is asked for.

### 7. Physics bodies & groups — `Inspector.tsx` (Physics)
Bodies are a *section of the object*, not a separate editor: box or circle,
size, offset, immovable, gravity, bounce. With BODIES on, the body draws over
the sprite with its own drag handles on a layer above the transform handles,
and the numbers stay live in the Inspector during the drag.

An object can be tagged with a **group**. Groups are project data — add,
rename and remove them in the Physics tab — and the layout hands each one back
as an arcade group, so `groups.brick` is how the scene's code says "every
brick" without naming sixty of them. Every group the project defines is handed
back, including one this scene places nothing in, because the bullets may all
be made by code.

An arcade group resets the body settings of anything it takes (gravity,
immovable, bounce, world-bounds collision) to the group's config. The body's
shape survives. So the layout creates each group the way you would by hand,
with the settings its bodies share as config:

```ts
const enemyGroup = scene.physics.add.group({ allowGravity: false });
enemyGroup.addMultiple([enemy, enemy_2]);
```

The bodies counted are the ones placed in the scene plus every prefab tagged
with the group, since code may make more of those. Adding one at run time is
then plain Phaser:

```ts
const enemy = new Enemy(this, x, y);
groups.enemy.add(enemy);
enemy.setDepth(player.depth);
```

A setting the group's bodies disagree on is left out of the config, and the
layout says so in a comment. Depth is yours to set, as in any Phaser game.

There is no collision matrix. Colliders are written in the scene class:

```ts
this.physics.add.collider(groups.ball, groups.brick, (_ball, brick) => (brick as Brick).hit());
```

The callback is where an object finds out it was hit: it calls a method on the
prefab's class. So a brick's behaviour lives on the Brick class and reaches all
sixty instances, the way it would in any Phaser game.

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

A game with no dev script — Phaser's own examples are a folder of scripts with
no `package.json` and no `index.html` — is served as it is, the way the examples
site serves it (`electron/staticServer.ts`). The folder's own `index.html` if it
has one; otherwise a page that loads Phaser (the project's installed copy, else
Mosaic's) as the global or, when the code imports `"phaser"`, through an import
map, then the file that starts the game — as a module when it uses `import`.
That page fits a game with no scale mode to the pane. Nothing is written to the
folder; a file watcher reloads the page on save, as a dev server would. Art
loaded from a CDN that only allows its own site (the examples' CDN) is let
through for requests from that page only.

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
emits loads → world → animations → layers bottom-up → groups → bodies →
camera → music, and returns the objects. Prefabs become classes
**and the layout constructs them** — `new Coin(scene, x, y)` — so behaviour
written on a prefab's class actually runs. A prefab's layout is a base class
(`CoinBase`) holding its texture and body; your `Coin` extends it. A variant
extends its parent's class — yours, not the generated one — so behaviour
reaches variants by ordinary inheritance, and the variant restates only what it
changed. Values set on a variant become field initialisers on its base class
(`override speed: Enemy["speed"] = 170`), which run after the parent's, so
`new Enemy_Fast(scene, x, y)` gets them with no Mosaic helper involved.

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
sprite subclass, and a field whose doc comment says `@editable` is listed in
the inspector's Code tab for every instance:

```ts
export class Player extends PlayerBase {
  /** Pixels per second. @editable { min: 0, max: 600 } */
  speed = 220;

  override preUpdate(time: number, delta: number) { /* reads this.speed */ }
}
```

It is a comment, so the class compiles and runs exactly as it would without
Mosaic: no import, no decorator, no compiler setting, and it works in
JavaScript. The description becomes the inspector's hint, and the braces take
`label`, `min`, `max`, `step`, `options` and `hint`. The older `@property(...)`
decorator is still read, so existing projects keep working.

**Where a value lives decides who sees it**, and `new` always agrees with the
editor:

| Set where | Stored as | `new Player(scene, x, y)` gets it? |
|---|---|---|
| In the class (`speed = 220`) | your code | yes. For a root prefab this *is* the default, so the inspector shows it read-only on the definition, marked "from code" |
| On a variant's definition | a field initialiser in the variant's generated base class | yes |
| On a placed instance | `props` in the scene file, assigned after `new` in the layout (`player.speed = 400`) | no, it belongs to that one object |

A value set on a root definition before this rule existed still reaches placed
instances. The inspector flags it, because `new` doesn't see it, and asks for it
to be moved into code. A
value whose field has been removed from the class is kept in the scene file,
flagged, and left out of the layout rather than assigned to a property that no
longer exists.

Mosaic never executes your game code to find out what a class exposes. The
editor indexes every source file under `src/` when the project opens and keeps
the index warm with the same watcher that reloads scenes, and `parse.ts` reads
the declarations **statically**. That is also why the index survives a file
that does not compile: the fields grey out and the last good metadata stays.

- **Only declared fields are editable.** `@editable` carries type, label,
  min/max and enum options; objects and callbacks render read-only with a *code
  only* tag. A field removed from the class keeps its value in the scene file,
  flagged rather than deleted.
- **The Project tab lists the code.** Every file under `src/` shows in the
  folder view beside the scenes, prefabs and assets, with its classes, its git
  status and ↗ to open it in your editor. Clicking one opens it read-only.
- **View source** opens the file in a read-only drawer with the fields the
  inspector is rendering highlighted, so the mapping from field to code is
  obvious. External saves re-index and refresh the field list in place; the
  text you are reading gets a *reload* banner rather than moving underneath
  you. *Open in editor* hands the file to `$MOSAIC_EDITOR`, then `code`,
  `cursor`, `subl`, then the OS handler — at the field's line where it can.
- **There are no script components.** An earlier version let you attach
  component classes to objects and ran them from a host the layout built.
  That was a Unity-style system laid over Phaser, so it was removed: behaviour
  that belongs to a kind of object goes in its prefab class, and behaviour that
  belongs to the level (rules, score, a one-off paddle) goes in the scene
  class, which is where Phaser puts it. A project written while components
  existed opens with a note, its references dropped and its classes untouched.

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

## Opening a game Mosaic didn't make — `project/adopt.ts`, `electron/existingProject.ts`

A folder with source in it, no `phaser.editor.json` and some sign of Phaser is
read as the game it already is, before anything is shown:

- **Which Phaser.** Taken from `package.json` or `bower.json`, else from the
  code (`game.state`, a positional `new Phaser.Game(960, …)`). A Phaser 2 game
  is refused on the launcher with the reason. It has states, not scenes, and
  nothing Mosaic writes would run in it.
- **Where it starts.** `index.html`'s module script first, which is what Vite
  runs, then any file that constructs a game: `new Phaser.Game(`, or
  `new Game(` where `Game` was imported from `phaser`.
- **Where its art is, and the URL it loads it by.** `public/assets` is listed
  as the art folder and `public/` recorded as `paths.publicDir`, so a layout
  loads `public/assets/star.png` as `assets/star.png`, the way Vite serves it.
- **Its canvas size, background, physics and pixel-art setting**, from the game
  config. A game with no `physics` block gets layouts that never touch
  `scene.physics`.
- **Its language and how it reaches Phaser.** Layouts are written in the
  language of the file that starts the game. A game where no file imports
  `phaser` has it from a script tag and runs its modules unbundled, as Phaser's
  own examples do. Its layouts leave out `import Phaser from "phaser"`, which
  the browser could not resolve (`"phaser": "global"` in the config).

The game opens on a screen listing its scene classes, not on a starter scene,
and nothing is written. There is one action: **Import all scenes**. It runs the
game once (the recorder, below) and gives every scene class a layout that
starts from what its `create()` built. A class the recording has nothing for
gets an empty layout, and so does every class of a game that cannot be run.
Each layout is two files beside its class (`MainGame.scene.json`,
`MainGame.layout.js`), named after the class whatever file it is in. The first
import also writes `phaser.editor.json` and `mosaic.config.json`, and the config
records the folders found.

**Your classes are edited only if you agree.** Pressing Import shows a warning
naming every class file and what will change in it, with three answers:
*Import and update my code*, *Import without changing code*, *Cancel*. Mosaic
can't undo a code edit, and the warning says so.

Agreeing wires each class to its layout (`project/wireClass.ts`,
`electron/classShape.ts`). The class imports the layout and calls
`preloadX(this)` and `createX(this)` first in its `preload()` and `create()`,
which are added in the file's own brace style if missing. Then every object
the layout now builds stops being built by the class: the call that made it is
replaced by the layout's object, so the rest of the line keeps working.

```js
let sign = this.add.image(512, -400, 'logo');          // before
let sign = layout.sign;                                 // after
let cactus2 = layout.cactus2.setFlipX(true);            // chained setters kept
```

A call whose result is unused is removed. The layout's objects take the names
the code used (`sign`, `levelImage`), or else their art's. Taking over is only
sound where one line makes one object, once. The recorder notes the stack that
put each object on the display list and maps it back through the bundle's
source map; the class is parsed with rolldown's parser to find the
`this.add.*(…)` calls straight in `create()`. Anything else stays the code's and
leaves the layout, so the scene never has two of it: objects made in loops,
helpers, callbacks or `preload()`, text (whose style a snapshot lacks),
container contents, instances of the game's own classes, and the animations the
game registers. A class that is not an ES module, or that cannot be parsed,
is left alone and listed with the lines to add by hand.

One dialog then lists every class: for an edited class, which objects now come
from the layout and which stay in code, and why; otherwise the import and two
calls to add, the objects its own `create()` still builds, and what the import
could not bring across.

Mosaic's placeholder shapes are not offered in an adopted game
(`"placeholders": false`). Their PNGs exist only in projects Mosaic scaffolded.

A scene class added to the game later is listed in the Project panel with
**+ layout** and **import**.

**The recorder** bundles the entry with rolldown and runs it once in a hidden,
sandboxed window, then snapshots what each scene's `create()` put on the
display list. The window has a session of its own, and a scheme that serves
only the harness and the game's web root. Relative loads resolve as they do
under the game's dev server, and the game's code cannot read anything outside
those two folders. A load that resolves to a file already in the project is
referenced where it is. Art loaded from a CDN under `setBaseURL` keeps that
URL in the layout (`AssetDef.source`), and a copy in `<assets>/imported/` is
only what the editor draws. Atlases are copied, because the layout loads the
frame document Mosaic writes beside them. When the import names a file already
listed under its filename, the asset takes the game's loader key.

The recorder waits for the game's loaders to go quiet rather than for a fixed
time. Its session lets the page read remote responses: Phaser's examples load
from a CDN that answers phaser.io and no other origin, `localhost` included.
The session has no cookies or credentials, so this exposes nothing.

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
  Endless runner each produce a real scene with a camera, a Tiled map and a
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
| Code | indexed from `src/**`, editable fields shown | unavailable — no source tree |
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
  staticServer.ts  RUN for a folder with no dev script: serves it as it is
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
  for primary actions.
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
  shared/          editor data and logic with no React and no UI
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
    tiled.ts        Reads a Tiled map well enough to describe it, and writes a
                    small one (template terrain, converted painted layers)

    scripts.ts      Editable-field types, and checking a stored value against one

  Nothing Mosaic ships runs inside your game: what it writes is generated
  layout files, and those import only Phaser and your own classes.

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
    scripts/        parse.ts (@editable fields, statically), registry.ts
                    (the index, kept warm by the watcher), trust.ts
                    (per-folder consent to run code)
    export/         generate.ts (layouts and starting-point classes), write.ts
    commands.ts     command registry, bindings, palette search
    ui/             MenuBar, Toolbar, LeftDock, Inspector, ScriptsTab,
                    SourceDrawer, BottomDock, StatusBar, Logo, fields, dialogs/
    bridge.ts       60fps canvas chatter (cursor, drag previews)

```

### Why undo is slice-based

A transaction records only the slices it changed (`scene:<key>`, `prefabs`,
`assets`, `anims`, `groups`, `meta`) and pushes one entry onto the
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
- Tiled maps must be **orthogonal, fixed-size, with embedded tilesets**, exported
  as JSON. `.tmx`, external `.tsx`/`.tsj` tilesets and infinite maps are
  reported in the Map tab rather than loaded.
- A layer **renamed** in Tiled reads as one layer removed and one added, so it
  loses its place in the scene's draw order and returns above its map's others.
- Tiled **object layers** are not shown in the editor. They are reachable from
  code through `layout.maps`.
- The desktop app packages **unsigned**. `npm run pack` produces a working
  `.app`, but code signing, notarization and auto-update are not set up, so
  macOS quarantines a downloaded build (`xattr -dr com.apple.quarantine` clears
  it for local use). Signing needs certificates, not code — see Packaging.
- Because rolldown ships a **native binding**, builds are per-platform: a
  Windows binary has to be built on Windows. The same binding is why
  `asarUnpack` exists in the build config, and why the bundle is ~400MB.
- Arcade physics only. Bodies are box or circle; arbitrary polygons are a
  Matter concern and are not modelled.
- RUN uses a `dev` (or `start`/`serve`) script when `package.json` has one, and
  then needs dependencies installed. Without one the folder is served as it is,
  which runs plain JavaScript only: TypeScript, or imports of npm packages other
  than Phaser, need the project's own bundler. A game served this way runs on
  Mosaic's Phaser unless the folder has its own installed — Phaser 4 for a
  Phaser 3 example. Opened in a browser (↗), CDN art the CDN does not allow
  for 127.0.0.1 stays missing. The game pane has no pause, step or live inspector — the loop
  belongs to the game. Open it in a browser (↗) for devtools.
- An import carries position, rotation, scale, origin, texture, frame, text
  and Arcade bodies. Flip, alpha and tint are not in Mosaic's object model, so
  a `setFlipX(true)` in `create()` does not come across.
- A prefab bound to the game's own class (Bank Panic's `Door`) is constructed
  by the layout, so its children come from the class. The editor cannot run
  the class, so it shows the instance without them.
- Starting on the edited scene relies on the game honouring `?scene=`; the
  scaffold's `main.ts` does, and an existing project runs from wherever it
  normally boots until it is taught to.
- A new scene's class is written for you, but adding it to the game's scene
  list is manual.
- The layout exposes every placed object as a field, so a scene with sixty
  bricks has sixty typed fields. Collections are reached through `groups`.
- Prefab layouts cover a prefab's root: a child node inside a prefab is drawn by
  the editor, and is not yet emitted into the class.
- There are two samples (`npm run sample`), built through the editor's own API:
  Coin Run, a platformer on placeholder shapes (`scripts/sample/build.ts`), and
  Holdout, a top-down shooter on real CC0 art and sound
  (`scripts/sample/holdout/`). Each README lists what its parts exercise.
- An arcade group resets the body settings of every child it takes to its
  config. The layout's groups carry the settings their bodies share. Where the
  bodies disagree, the setting is left out of the config, and an object added
  at run time keeps Phaser's default for it until your code sets it (or calls
  the prefab's `applyBody()`) after adding.
- A root prefab's editable defaults live in its class, so tuning one for every
  instance means editing code (or making a variant). Values can still be set
  per placed instance in the editor.
- Groups and the starter prefabs are project data with genre-ish
  names (`player`, `pickup`, `Player`, `Pickup`). They are a starting point,
  not a fixed set — rename or delete them and nothing in the editor cares.
- A variant claims structure whole: if it changes its children, it stores the
  child list rather than a per-child diff, so later structural changes on the
  base do not flow into it. Property changes on the base still do.
- **rolldown** is a runtime dependency of the desktop build: it bundles a
  hand-written project for importing, and the whole game for `Export game…`.
