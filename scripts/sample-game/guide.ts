import { SET_TILES } from "../../src/shared/logoGeometry";
import type { BuildResult } from "./build";
import { GAME_SCRIPTS } from "./scripts";

/**
 * The build guide, rendered from the SAME build that wrote the game.
 *
 * The steps come out of the build log and the code comes out of the constant
 * the generator wrote to disk, so a guide that is out of date is not possible:
 * both are produced by one pass.
 *
 * The output is print-stylesheet HTML, which Electron turns into the PDF.
 */

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Paragraph breaks, and `code` spans, without pulling in a markdown parser. */
function prose(text: string): string {
  return escape(text)
    .split("\n\n")
    .map((para) => `<p>${para.replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`)
    .join("\n");
}

const CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Barlow", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 10.5pt;
    line-height: 1.55;
    color: #1d1f20;
    margin: 0;
  }
  code, pre { font-family: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  code { font-size: 0.88em; background: #eef2f6; padding: 0 3px; }
  h1, h2, h3 { font-family: "Barlow Condensed", "Barlow", sans-serif; font-weight: 600; line-height: 1.15; margin: 0; }
  h1 { font-size: 30pt; letter-spacing: -0.01em; }
  h2 { font-size: 16pt; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 1.5px solid #5980a6; color: #2c455d; }
  h3 { font-size: 12pt; margin: 0 0 1mm; }
  p { margin: 0 0 3mm; }
  a { color: #416180; }

  .cover { height: 245mm; display: flex; flex-direction: column; justify-content: center; }
  .cover .mark { display: block; margin-bottom: 8mm; }
  .kicker { font-family: "Barlow Condensed", sans-serif; font-size: 10pt; letter-spacing: 0.3em; text-transform: uppercase; color: #7a7a7d; }
  .cover .sub { font-size: 13pt; color: #5d5d60; margin-top: 3mm; max-width: 130mm; }
  .cover dl { display: grid; grid-template-columns: 34mm 1fr; gap: 1.5mm 6mm; margin-top: 14mm; font-size: 9.5pt; }
  .cover dt { color: #7a7a7d; font-family: "IBM Plex Mono", monospace; font-size: 8.5pt; }
  .cover dd { margin: 0; }

  section { page-break-before: always; }
  section.flow { page-break-before: auto; }

  .step { page-break-inside: avoid; margin-bottom: 7mm; }
  .step-head { display: flex; align-items: baseline; gap: 4mm; margin-bottom: 2mm; }
  .step-n {
    font-family: "IBM Plex Mono", monospace; font-size: 9pt; color: #fff;
    background: #5980a6; min-width: 8mm; height: 8mm; display: flex;
    align-items: center; justify-content: center; flex: none;
  }
  .do {
    border-left: 2px solid #5980a6; background: #f4f7fa;
    padding: 2mm 4mm; margin: 2mm 0 0; font-size: 9.5pt;
  }
  .do b { font-family: "Barlow Condensed", sans-serif; letter-spacing: 0.1em; text-transform: uppercase; font-size: 8pt; color: #2c455d; display: block; }
  .do pre { margin: 1mm 0 0; white-space: pre-wrap; font-size: 8.5pt; color: #424244; }

  pre.code {
    background: #f5f6f8; border: 1px solid #d4d4d7; border-left: 2px solid #5980a6;
    padding: 3mm 4mm; font-size: 7.6pt; line-height: 1.45; white-space: pre-wrap;
    page-break-inside: auto;
  }
  .note { border-left: 2px solid #a68859; background: #fff8ee; padding: 2mm 4mm; font-size: 9.5pt; margin: 3mm 0; }
  .note b { color: #5d472c; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-bottom: 5mm; }
  th, td { text-align: left; padding: 1.6mm 3mm; border-bottom: 1px solid #e0e0e3; vertical-align: top; }
  th { font-family: "Barlow Condensed", sans-serif; text-transform: uppercase; letter-spacing: 0.08em; font-size: 8.5pt; color: #2c455d; border-bottom: 1.5px solid #5980a6; }
  td.mono, th.mono { font-family: "IBM Plex Mono", monospace; font-size: 8.5pt; }

  figure { margin: 0 0 6mm; page-break-inside: avoid; }
  figure img { width: 100%; border: 1px solid #d4d4d7; display: block; }
  figcaption { font-size: 8.5pt; color: #7a7a7d; margin-top: 1.5mm; }

  ul { margin: 0 0 3mm; padding-left: 5mm; }
  li { margin-bottom: 1mm; }
  .lede { font-size: 11.5pt; color: #424244; margin-bottom: 5mm; }
`;

export interface GuideAssets {
  /** data: URLs, so the PDF is one self-contained file. */
  editor?: string;
  running?: string;
}

export function renderGuide(result: BuildResult, shots: GuideAssets = {}): string {
  const s = result.stats;
  const totalScore = s.coins * 10 + s.gold * 50;

  const cover = `
<div class="cover">
  <svg class="mark" viewBox="0 0 26 26" width="74" height="74" aria-label="Mosaic">
    <g fill="#5980a6">
      ${SET_TILES.map(([x, y]) => `<rect x="${x}" y="${y}" width="8" height="8"/>`).join("")}
    </g>
    <g fill="none" stroke="#5980a6" stroke-width="1.6">
      <rect x="9.8" y="9.8" width="6.4" height="6.4"/>
      <rect x="9.8" y="18.8" width="6.4" height="6.4"/>
    </g>
  </svg>
  <div class="kicker">Mosaic · Scene Editor for Phaser</div>
  <h1>Coin Rush</h1>
  <div class="sub">
    Building a hypercasual game in the editor — every step, every script, and why each
    one is where it is.
  </div>
  <dl>
    <dt>the game</dt><dd>One screen, thirty seconds, ${totalScore} points on the board and ${s.gold ? "150" : "?"} needed to clear it.</dd>
    <dt>built with</dt><dd>Mosaic → Phaser 4, TypeScript, Vite</dd>
    <dt>the level</dt><dd>${s.tiles} tiles · ${s.objects} objects · ${s.prefabs} prefabs · ${s.scripts} script components</dd>
    <dt>editor actions</dt><dd>${s.undoDepth} undoable edits, start to finish</dd>
    <dt>output</dt><dd>${result.files.length} files, all of them plain text</dd>
  </dl>
</div>`;

  const intro = `
<section>
  <h2>What is being built, and why this shape</h2>
  <p class="lede">
    Coin Rush is a single screen. You run, you jump, you take every coin you can reach before
    the clock runs out. Spikes cost seconds rather than lives.
  </p>
  <p>
    That is the whole game, and the smallness is the point: a hypercasual round has to be
    understood without being explained. One screen means nothing is hidden off-camera; a
    countdown means every round ends on its own; costing time instead of a life means a mistake
    makes winning harder rather than impossible.
  </p>
  <p>
    ${s.coins * 10} points sit on the easy route and the target is 150, so clearing a round means
    making the climb to the ${s.gold} gold coins on the top ledge. That single number is the
    entire difficulty curve, and it is a field in the inspector — not a constant in anyone's code.
  </p>
  ${
    shots.editor
      ? `<figure><img src="${shots.editor}" alt="The finished level open in Mosaic"><figcaption>The finished level in Mosaic. Left: the folder, with each prefab as its own file and the variant nested under its base. Right: the three prefabs this game is made of.</figcaption></figure>`
      : ""
  }
  <h3>The parts</h3>
  <table>
    <tr><th>Piece</th><th>What it is</th><th class="mono">File</th></tr>
    <tr><td>Level_01</td><td>One tile layer and ${s.objects} objects</td><td class="mono">src/scenes/Level_01.scene.json</td></tr>
    <tr><td>Coin</td><td>Prefab · ${s.coins} instances</td><td class="mono">src/prefabs/Coin.prefab.json</td></tr>
    <tr><td>Coin_Gold</td><td>Variant of Coin · ${s.gold} instances</td><td class="mono">src/prefabs/Coin_Gold.prefab.json</td></tr>
    <tr><td>Spike</td><td>Prefab · ${s.spikes} instances</td><td class="mono">src/prefabs/Spike.prefab.json</td></tr>
    ${GAME_SCRIPTS.map(
      (g) =>
        `<tr><td>${g.name}</td><td>${escape(g.role)}</td><td class="mono">src/scripts/${g.name}.ts</td></tr>`,
    ).join("\n    ")}
  </table>
  <div class="note">
    <b>One rule runs through all of it.</b> The class says what exists; the scene file says what
    it is set to. Speed, jump height, round length, what a coin is worth — none of those are in
    the code. They are values in JSON that the editor writes and the game reads, which is why
    tuning this game never means recompiling it.
  </div>
</section>`;

  const steps = `
<section>
  <h2>Building it, step by step</h2>
  <p class="lede">
    Fourteen steps, in the order they were performed. Each gives the editor action and the call the
    editor makes underneath, so the sequence can be followed by hand or driven from a script.
  </p>
  ${result.steps
    .map(
      (step) => `
  <div class="step">
    <div class="step-head"><span class="step-n">${step.n}</span><h3>${escape(step.title)}</h3></div>
    ${prose(step.body)}
    ${
      step.editor
        ? `<div class="do"><b>In the editor</b>${escape(step.editor)}${
            step.api ? `<pre>${escape(step.api)}</pre>` : ""
          }</div>`
        : ""
    }
  </div>`,
    )
    .join("\n")}
</section>`;

  const prefabSection = `
<section>
  <h2>Why three prefabs and not thirty objects</h2>
  <p>
    There are ${s.coins + s.gold} coins in this level. They are ${
      s.prefabs
    } definitions and ${s.coins + s.gold} links to them,
    not ${s.coins + s.gold} objects that happen to look alike. That distinction is the difference
    between changing a coin once and changing it ${s.coins + s.gold} times.
  </p>

  <h3>The contract</h3>
  <p>
    A prefab publishes an <em>exposed</em> list, and that list is the whole of what a level may
    change about an instance. Coin publishes exactly one field —
    <code>Collectible.points</code>. Everything else about a coin belongs to the definition,
    which is what stops ${s.coins + s.gold} coins from drifting into ${
      s.coins + s.gold
    } slightly different objects.
  </p>
  <p>
    In a level, a field the definition owns is shown <em>locked</em> rather than hidden. A
    designer should be able to see that a value exists and read who owns it, instead of
    wondering where it went.
  </p>

  <h3>The variant</h3>
  <p>
    Coin_Gold is not a second prefab. Its whole file is a base and a diff:
  </p>
  <pre class="code">{
  "name": "Coin_Gold",
  "exposed": ["scripts.0.props.points"],
  "base": "Coin",
  "diff": {
    "scaleX": 1.45,
    "scaleY": 1.45,
    "scripts.0.props.points": 50
  }
}</pre>
  <p>
    Three claims, and everything else inherited. Change the bob, the body or the art on Coin and
    the gold coins move with it; the only things they keep for themselves are the three they
    asked for. A second prefab would have been a second thing to remember to fix.
  </p>

  <h3>Saving says what it costs</h3>
  <p>
    Editing a definition reaches into scene files nobody is looking at, so saving a prefab lists
    its consequences first: which values <b>move</b>, which overrides an instance set for itself
    are <b>kept</b>, which are <b>dropped</b> because a field is no longer published, and which
    scenes are <b>skipped</b> because they changed on disk. Nothing is written until Push.
  </p>
</section>`;

  const scriptSection = `
<section>
  <h2>The four script components</h2>
  <p class="lede">
    Ordinary TypeScript. Each extends <code>ScriptComponent</code>, which Mosaic copies into the
    project, and marks with <code>@property</code> the fields the editor may set. Mosaic never
    edits this code — it reads the declarations out of it and renders them.
  </p>
  <div class="note">
    <b>Nothing here reaches for another script.</b> Coins and spikes emit scene events and the
    director listens, so a coin does not need to know that a score exists. That is what lets a
    coin be dropped into any level, including one with no director at all.
  </div>
  ${GAME_SCRIPTS.map(
    (g) => `
  <h3>${g.name}<span style="font-weight:400;color:#7a7a7d;font-size:10pt"> — ${escape(g.role)}</span></h3>
  <ul>${g.notes
    .map((n) => `<li>${escape(n).replace(/`([^`]+)`/g, "<code>$1</code>")}</li>`)
    .join("")}</ul>
  <pre class="code">${escape(g.source.trimEnd())}</pre>`,
  ).join("\n")}
</section>`;

  const runSection = `
<section>
  <h2>Running it, and shipping it</h2>
  ${
    shots.running
      ? `<figure><img src="${shots.running}" alt="Coin Rush running inside the editor"><figcaption>RUN boots the scene into the same canvas it was edited in. The HUD is drawn by GameDirector; the outlines are the physics bodies, toggled with F2.</figcaption></figure>`
      : ""
  }
  <p>
    <b>RUN</b> (⌘↵) compiles the project's own classes and boots the scene into the canvas you
    were just editing. Stopping restores the pre-play snapshot exactly, and offers to keep any
    tweak made while it ran — so tuning against a moving game does not mean losing the tuning.
  </p>
  <p>
    Saving also writes a <code>*.layout.ts</code> beside the JSON — generated, rewritten on
    every save, never edited — plus a class per scene and per prefab that is written once and is
    yours from then on. The layout <em>constructs</em> those prefab classes, so behaviour written
    on a prefab actually runs:
  </p>
  <pre class="code">const coin_Gold = new Coin_Gold(scene, 272, 172);
coin_Gold.setName("Coin_Gold").setDepth(1);
scripts.add(coin_Gold, new Collectible(), { points: 50 });</pre>
  <p>
    Your scene's <code>create()</code> calls <code>createLevel_01(this)</code> and gets every
    object back by name. Nothing is merged with anything, so there are no markers to work inside.
  </p>
  <h3>From a clean checkout</h3>
  <pre class="code">npm install
npm run dev      # the game, in a browser
npm run build    # a production bundle in dist/</pre>
  <h3>What is on disk</h3>
  <table>
    <tr><th class="mono">Path</th><th>What it is</th></tr>
    <tr><td class="mono">phaser.editor.json</td><td>The manifest: assets, animations, groups, the collision matrix</td></tr>
    <tr><td class="mono">mosaic.config.json</td><td>Canvas size, tile size, physics — project defaults every scene inherits</td></tr>
    <tr><td class="mono">src/scenes/Level_01.scene.json</td><td>The level. The editor's source of truth</td></tr>
    <tr><td class="mono">src/scenes/Level_01.layout.ts</td><td>Generated from it on every save. Never edited</td></tr>
    <tr><td class="mono">src/scenes/Level_01.ts</td><td>The scene class. Written once; yours</td></tr>
    <tr><td class="mono">src/prefabs/*.prefab.json</td><td>One file per definition, with its own history in the repo</td></tr>
    <tr><td class="mono">src/prefabs/*.layout.ts</td><td>Each definition's art and body, as a base class. Generated</td></tr>
    <tr><td class="mono">src/prefabs/*.ts</td><td>The class that extends it. Written once; yours</td></tr>
    <tr><td class="mono">src/scripts/*.ts</td><td>Yours. Mosaic reads them and never writes them</td></tr>
  </table>
  <div class="note">
    <b>There is no proprietary project file.</b> Every line above is text a repo can diff, review
    and merge. That is the reason a prefab is a file rather than a row in a manifest: two people
    editing two prefabs should not be editing one file.
  </div>
</section>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Coin Rush — Build Guide</title>
<style>${CSS}</style></head>
<body>${cover}${intro}${steps}${prefabSection}${scriptSection}${runSection}</body></html>`;
}
