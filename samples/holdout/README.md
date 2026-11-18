# Holdout

A top-down survival shooter, laid out in Mosaic and written in Phaser. It
exists to test the editor with real art — 16-bit style pixel art, drawn in
code by the sample's builder — so it is small but leans on most of what Mosaic
does: two packed atlases, a tilesheet that is both a Tiled tileset
and a spritesheet, animation, sound, prefabs made only by code, a variant,
per-instance values, groups, two scenes and a camera that follows.

    npm install
    npm run dev

**WASD** to move, the **mouse** to aim, **click** (or hold) to shoot, **R** to
reload. Zombies climb out of the four hatches in waves; robots join from the
second. Shoot the orange barrels when they are close. The house and the shed
each hold a better gun. Clearing a wave gives back some health.

## Who did what

| | Where it is | Whose |
|---|---|---|
| The ground, walls, debris and tree tops | `assets/maps/Level_01.tmj`, a Tiled map with four layers | Tiled's |
| Where everything stands, bodies, groups, camera, music, HUD, both scenes | `src/scenes/*.scene.json` → `*.layout.ts` | Mosaic's |
| Each prefab's art, body, animation, sound and the variant's numbers | `src/prefabs/*.prefab.json` → `*.layout.ts` | Mosaic's |
| Animations | `anims.json` | Mosaic's |
| Moving, aiming, shooting, reloading | `src/prefabs/Player.ts` | yours |
| Chasing and biting (Robot inherits it) | `src/prefabs/Zombie.ts` | yours |
| Flying and striking | `src/prefabs/Bullet.ts` | yours |
| Spawn timing, per hatch | `src/prefabs/Spawner.ts` | yours |
| Colliders, waves, barrels going up, score, losing | `src/scenes/Level_01.ts` | yours |
| The title screen | `src/scenes/Title.ts` | yours |

## The editor's part, step by step

1. New project… → Empty template, TypeScript, Vite, 1024 × 576, 64px grid, pixel art on
2. Import assets… → characters.png + .xml (13 frames), effects.png + .xml (7 frames), tiles.png as a 64px spritesheet, two weapon images, seven sounds
3. Tiled → assets/maps/Level_01.tmj, 40 × 30: Ground, Details, Walls (collides), Canopy — all drawn with tiles.png
4. Scene tab → 2560 × 1920, no gravity, music on loop, camera follows Player with a deadzone · Map tab → Add to scene · Layers: Canopy dragged above Objects, + HUD
5. Physics tab → Groups: player, pickup, enemy, bullet, barrel, cover
6. Animation timeline → survivor_reload (holds 650ms on the middle frame), zombie_walk, robot_walk, explode
7. Place characters › survivor_pistol → origin on the head, circle body → Prefab "Player"
8. Place zombie_0 → circle body, plays zombie_walk → Prefab "Zombie" → variant "Robot" (robot_0, robot_walk, health 8) → place 3 more, one Robot slower
9. Place effects › bullet → Prefab "Bullet"; effects › blast_0, plays explode, on spawn audio_explosion → Prefab "Explosion"; delete both from the scene
10. Place tiles › 18 → immovable circle body → Prefab "Barrel" → place 7
11. Place tiles › 19 → immovable box body, group cover → Fill grid 3 × 1 and 2 × 2 → one more, turned 20°
12. Place tiles › 15 → Prefab "Spawner" → place 4 at the gates' paths, each with its own kind, rate and delay
13. Place weapon_machine → Prefab "Pickup", texture exposed → place a second, texture weapon_silencer, weapon "silencer"
14. Text (T) × 4 on the HUD layer → Status, Score (right-aligned), Banner, Hint — all pinned to the camera
15. New scene "Title" (Empty) → Map tab → Add Level_01, remove its Details layer, Canopy above Objects → four atlas sprites and a barrel → + Text layer, four texts

## What to check when testing the editor

- **Atlas import:** `characters` and `effects` came in as Starling XML, the
  format sprite packers write. Frames keep their names (`survivor_pistol`), and
  the layout loads the JSON Mosaic writes beside each sheet.
- **Pixel art:** every art pixel is 4 × 4 on screen, and `pixelArt` is on,
  so nothing blurs when the camera follows or a sprite turns. Nothing is placed
  scaled, so no pixel is bigger than another.
- **One sheet, two uses:** `tiles.png` is the Tiled map's tileset and a 64px
  spritesheet. Barrels are frame 18, crates 19, hatches 15.
- **Draw order:** Canopy is a tile layer above the Objects layer, so the player
  walks under the trees. The HUD is its own object layer, on top of both.
- **Made by code:** `Bullet` and `Explosion` are never placed. The explosion's
  animation and sound are set on its prefab and run from its constructor, so
  `new Explosion()` in the scene's code plays both.
- **Variant:** `Robot` changes Zombie's frame, walk animation and four
  numbers. `new Robot()` from a spawner gets all of them.
- **Per-instance values:** each Spawner's kind, rate and delay; the slower
  Robot; the north-gate barrel's shorter fuse; the Silencer pickup's texture,
  which the Pickup prefab exposes.
- **Fill grid:** the crate rows by the north gate and the 2 × 2 stack.
- **Second scene:** Title places two layers of Level_01's map and nothing else
  of it, and plays the walk animations on plain atlas sprites.
- **Camera and HUD:** the camera follows with a deadzone and stops at the
  map's edges; the four texts stay put.
