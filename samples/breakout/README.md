# Breakout

Phaser's `breakout.js` example, rebuilt as a Mosaic project.

    npm install
    npm run dev

The original is one file: `public/src/games/breakout/breakout.js` in the
[Phaser examples](https://github.com/phaserjs/examples). Everything in it — the
wall, the ball, the paddle, the rules — is written inside one scene class. This
is the same game with the same numbers, authored the way Mosaic asks: the wall
is 60 objects in a scene file, a brick is a prefab with five colour
variants, and every behaviour is a script component whose tunable fields are
`@property` declarations the editor fills in.

It exists to answer a question rather than to be a game — can a whole, real,
already-written Phaser game be laid out in this editor and still run as an
ordinary Phaser project? `npm run breakout` at the repo root rebuilds it by
driving the editor's own API.

## Layout

One rule: **`*.layout.ts` is generated, everything else is yours.**

    src/main.ts                      the game config and scene list — yours
    src/scenes/Level_01.ts           the scene class — yours
    src/scenes/Level_01.layout.ts    what the editor placed — generated on save
    src/scenes/Level_01.scene.json   the data the editor edits
    src/prefabs/Brick*.ts            a class per prefab — yours; variants extend Brick
    src/prefabs/Brick*.layout.ts     each prefab's art and body — generated
    src/scripts/                     ScriptComponent + the four behaviours
    assets/                          art, copied in by the editor
    mosaic.config.json               canvas, tile size, scale mode, physics

## What did not fit



## Assets

The art is from the Phaser examples repo and is **not** covered by its MIT
licence — much of it comes from classic arcade games and stock art. It is here
so the sample renders; do not ship it.
