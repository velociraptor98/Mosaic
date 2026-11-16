# Twin Stick

A small top-down arena shooter, laid out in Mosaic and written in Phaser.

    npm install
    npm run dev

**Keyboard and mouse:** WASD to move, aim with the mouse, hold the button to
fire. **Gamepad:** left stick moves, right stick aims and fires. Enemies walk
at you; touching one costs a hit point. Click to play again.

Rebuild it from the repo root with `npm run twin-stick`, which drives the
editor's own API and then writes the code below over the starting points.

## Who did what

| | Where it is | Whose |
|---|---|---|
| The arena | `assets/maps/Level_01.tmj` — a Tiled map, two layers | Tiled's |
| Where everything stands, body sizes, camera, HUD text | `src/scenes/Level_01.scene.json` → `Level_01.layout.ts` | Mosaic's |
| Each prefab's art, body and tuned numbers | `src/prefabs/*.prefab.json` → `*.layout.ts` | Mosaic's |
| Moving, aiming, firing | `src/prefabs/Player.ts` | yours |
| Chasing, taking hits | `src/prefabs/Enemy.ts` (Enemy_Fast inherits it) | yours |
| Flying, expiring | `src/prefabs/Bullet.ts` | yours |
| Asking for enemies on a timer | `src/prefabs/Spawner.ts` | yours |
| What collides with what, score, game over | `src/scenes/Level_01.ts` | yours |

## The editor's part, step by step

1. New project… → Empty template, TypeScript, Vite, 960 × 540 (20 files)
2. Scene tab → 1280 × 768, no gravity, camera follows Player
3. Map tab → Add to scene: assets/maps/Level_01.tmj (layers Floor, Walls — drawn in Tiled)
4. Physics tab → Groups: player, enemy, bullet
5. Place capsule → Physics: circle body → Prefab: create "Player" → Scripts tab: speed 260, fireRate 7
6. Place triangle → Prefab "Enemy" → variant "Enemy_Fast" (0.7 scale, speed 170, hp 1, 25 points) → place 4
7. Place star at 0.5 scale → Prefab "Bullet" → delete it from the scene → Scripts tab: speed 620, lifetime 800
8. Place diamond → Prefab "Spawner" → place one per corner → Scripts tab on each: interval, delay, kind
9. Text (T) twice → HUD and Banner, both pinned to the camera

## Things worth looking at

- **A prefab that is never placed.** No bullet is in the scene. `Bullet` is a
  prefab so its art, body and numbers can be authored, and the game makes one
  with `Bullet.spawn(scene, x, y)` — `new`, plus the values set on the
  definition in the editor.
- **A variant is the same class.** `Enemy_Fast` has no behaviour of its own;
  it extends `Enemy` and differs by scale and three numbers.
- **The difficulty curve is four inspector rows.** Each spawner's interval,
  delay and kind are `@property` fields set per instance.
- **Collisions are six lines** in `Level_01.ts`, written against the groups and
  the tile layer the layout hands back.

## What building it turned up

This sample was the first game made with the editor after it became a layout
tool, and it was built to find out where that falls short. Three things did,
and were fixed in the editor rather than worked around here:

- **A prefab nobody placed had no texture.** The layout only loaded art for
  objects in the scene, so a bullet spawned from code arrived invisible. Every
  prefab's art is loaded now.
- **Numbers set on a definition did not reach spawned objects.** They were only
  assigned to instances the layout itself built. Prefab classes now carry the
  definition's values and a `spawn()` that applies them.
- **"HUD" became `layout.hUD`.** Names that start with an acronym are
  camel-cased properly now.
- **A group only existed if something placed was in it**, so the bullets' group
  had to be made in code. The layout now hands back every group the project
  defines.
- **A spawned object lost its body settings and drew below the walls.** Adding
  it to an arcade group reset them (gravity came back on), and nothing gave it
  a depth. A layout group now restores
  the authored body, and gives an object with no depth the depth of the layer
  the group's objects were placed on.

And things that are still rough, left as they are:

- The spawners' `kind` is a string the scene maps to a class. There is no way
  to point a field at a prefab.
- The art is the editor's placeholder shapes. Nothing here depends on them.
