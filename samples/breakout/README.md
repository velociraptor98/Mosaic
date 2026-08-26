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

**Step 3 — Import the art.** An existing Phaser atlas (.png + .json) cannot be imported as one. The slicer builds frames from pixels and names them from a pattern, so re-using packed art means either losing its frame names or unpacking it first.

**Step 6 — Place the paddle and the ball.** The original disables ONE side of the world bounds — `setBoundsCollision(true, true, true, false)` — so the ball can fall out of play. Mosaic authors the bounds rectangle and whether a body is kept inside it, but not the four per-side flags, so a Mosaic breakout has no floor to lose the ball through and therefore no way to lose. BallController sets the flag itself, behind a "solid floor" property.

**Step 9 — Lay the wall out.** Nothing in the scene format says "a grid of these". Sixty placements are sixty objects in the scene file and sixty statements in the exported class; changing the wall's shape means moving sixty things rather than editing two numbers.

**Step 11 — The collision matrix, and why this game cannot use it.** The collision matrix cannot express "collide, and tell me". Every interaction that needs a physical response AND a callback has to leave the matrix and move into a script, which is both of breakout's interactions — the entire game.

## Assets

The art is from the Phaser examples repo and is **not** covered by its MIT
licence — much of it comes from classic arcade games and stock art. It is here
so the sample renders; do not ship it.
