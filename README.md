# Mosaic

**Scene editor for Phaser.** A WYSIWYG editor for Phaser games. The canvas is a real `Phaser.Scene`
rendering the real scene data; the surrounding UI is React. Scenes are plain
JSON that the editor, the play-test and a shipped game all read — there is no
import step to lose data in.

Implements the nine workflows in `Phaser Editor Workflows.html`, styled to the
tokens in that document and branded per `Mosaic Logo.html`.

## Run it

```
npm install
npm run dev      # editor at the printed URL
npm run smoke    # headless pass over every workflow's logic (64 checks)
npm run build    # static production build in dist/
npm run lint
```

## The nine workflows, and where they live

### 1. Project & scenes — `store/project.ts`, `store/templates.ts`, `commands.ts`
The editor opens a *project*, not a file. The Project tab lists every scene,
prefab, asset and animation, with a modified marker per scene. New scenes come
from templates (Empty / Platformer / Top-down) that write a runnable scene —
camera, tile layer, a player with a body. Keys are derived and collision-free
before write.

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
Prefabs become classes so hand-written logic has somewhere to live. Tile data
stays in the `.scene.json`, which the class imports, so the source carries no
walls of literal numbers.

Writing shows a diff first. Where the browser supports the File System Access
API you can point the editor at your real source tree and it writes there;
otherwise it downloads. Code between `// <keep id="…">` markers is carried
across every regeneration, and a file with edits *outside* a keep region is
refused rather than clobbered (`overwrite anyway` is an explicit choice).
Watch re-emits on every change so a running dev server stays in step.

Export changes nothing in the scene: the editor and the generated code read the
same `scene.json`.

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

`src/editor/ui/Logo.tsx` holds the mark from `Mosaic Logo.html`: a 3×3 grid on a
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

## Layout

```
src/
  shared/          imported by BOTH the editor and your game — no React, no UI
    types.ts        Project / Scene / Layer / Object / Prefab / Anim schema
    definitions.ts  Built-in tileset + object types
    textures.ts     Procedural placeholder art (Phaser)
    tilesetImage.ts The placeholder tileset as a PNG data URL (no Phaser)
    prefabs.ts      Resolution: definition <- overrides, per property path
    transform.ts    Hierarchy maths, cycle rejection, world<->local
    manifest.ts     Derives the Phaser loader manifest from a scene

  runtime/         ships inside your game — zero editor deps
    loadScene.ts    preloadProject / buildScene: tilemaps, sprites, bodies,
                    animations and the collision matrix

  tokens.css       the reference document's design tokens
  styles.css       editor chrome built from them

  editor/
    store/          project.ts (state + slice-based undo), undo.ts,
                    templates.ts, ids.ts
    phaser/         EditorScene.ts (tools, snapping, handles, body editing),
                    PlayScene.ts, playtest.ts, PhaserHost.tsx, snapping.ts,
                    textures.ts
    assets/slice.ts grid + auto-detect slicing, frame naming
    export/         generate.ts, keep.ts, write.ts
    commands.ts     command registry, bindings, palette search
    ui/             MenuBar, Toolbar, LeftDock, Inspector, BottomDock,
                    StatusBar, Logo, fields, dialogs/
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

- Assets live in the project as data URLs and persist to `localStorage`; a
  large project will exceed the quota (the status bar says so). "Save project"
  writes the whole project as JSON.
- Arcade physics only. Bodies are box or circle; arbitrary polygons are a
  Matter concern and are not modelled.
- The editor cannot watch the source tree for *external* edits to scene files;
  re-open the project JSON (or re-export) after editing scenes outside it.
- Play-test ships a default player controller (arrows/WASD, jump on gravity
  scenes) so RUN does something; real behaviour belongs in your exported code.
