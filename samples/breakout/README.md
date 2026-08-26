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
already-written Phaser game be expressed in this editor's model, and does what
comes out the far end actually run? Both are checked in CI:

| command | what it proves |
|---|---|
| `npm run breakout` (repo root) | the project can be authored through the editor's own API |
| `node scripts/verify-export.mjs breakout` | the generated code typechecks and bundles |
| `node scripts/parity/run.mjs breakout` | the editor's play-test and the shipped build agree |
| `node scripts/breakout/playtest.mjs` | the game is playable: bricks break, lives are lost, the round ends |

## Layout

    src/scenes/Level_01.scene.json   the editor's source of truth
    src/scenes/Level_01.ts           generated from it — edit inside // <keep> markers
    src/prefabs/Brick*.ts            one class per prefab; the five variants are diffs
    src/scripts/                     ScriptComponent + the four behaviours
    assets/                          art, copied in by the editor
    mosaic.config.json               canvas, tile size, scale mode, physics

## What did not fit



## Assets

The art is from the Phaser examples repo and is **not** covered by its MIT
licence — much of it comes from classic arcade games and stock art. It is here
so the sample renders; do not ship it.
