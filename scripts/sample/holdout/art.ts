import { Pixels, dither, lightAt, packAtlas, rng, type Color } from "./pixels";

/**
 * Holdout's art: 16-bit style pixel art, drawn here rather than shipped as
 * files, so every sprite can be read and changed as code.
 *
 * The rules a 16-bit artist works to, applied throughout:
 * - one fixed palette, a few shades per material, nothing in between;
 * - a dark outline around every figure and prop, so it reads on any ground;
 * - light from the top left, on everything;
 * - art drawn small and shown big: tiles are 16 × 16 and every art pixel is
 *   PX × PX on screen, so the game keeps its 64px grid. Sprites are drawn at
 *   the size they are shown, at scale 1, so no pixel is ever bigger or
 *   smaller than another.
 */

export const PX = 4;

// ------------------------------------------------------------------ palette

const INK = "#1b1724";
const WHITE = "#f4efe2";
const SHADOW = "#10101860";

const G = ["#1f3d2a", "#2c5a2e", "#3f7a34", "#5f9e3c", "#93c85a"]; // grass, leaves
const D = ["#3e2a1e", "#5e3f28", "#7d5734", "#a27a4c", "#c8a36c"]; // dirt
const C = ["#2c2e38", "#464a56", "#636874", "#828894", "#a9aeb8"]; // concrete
const W = ["#3a2016", "#5c3320", "#7e4a2a", "#a3653a", "#c98c52"]; // wood
const B = ["#3e1714", "#6e2a20", "#a0442c", "#c8653a", "#eaa35e"]; // brick
const S = ["#7a3f2e", "#b8694a", "#e89c74", "#ffd0a6"]; // skin
const H = ["#2a1812", "#4f2d1d", "#7a4a2c"]; // hair
const U = ["#1a2350", "#28408a", "#3c64c0", "#6a94e6"]; // survivor's shirt
const Z = ["#24361c", "#456028", "#6f9038", "#a5c65a"]; // zombie skin
const R = ["#2a1834", "#46294f", "#6a4278"]; // zombie's rags
const M = ["#22252f", "#3a4252", "#5a6578", "#8a97aa", "#c4cdd9"]; // metal
const E = ["#4e0f16", "#8e1c22", "#cc3628", "#ff6c3c"]; // red
const Y = ["#a8501a", "#ea8420", "#ffc038", "#fff27a", "#fffde0"]; // fire, brass
const K = ["#34343e", "#55555f", "#7c7c88", "#a8a8b2"]; // smoke
const BONE = ["#8e8470", "#c4b996", "#ece3c6"];

/** A pixel hash: the same "random" value for the same place, every build. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

// ------------------------------------------------------------ the survivor

export type Pose = "pistol" | "machinegun" | "silencer" | "hold" | "reload";

/** Survivor frames: 20 × 14, head at (6.5, 7), facing right. */
export const SURVIVOR = { width: 20, height: 14, headX: 6.5 };
/** Where the pistol's barrel ends, from the head, facing right, in screen px. */
export const MUZZLE = { forward: (16 - SURVIVOR.headX) * PX, side: 2 * PX };

function survivor(pose: Pose): Pixels {
  const p = new Pixels(SURVIVOR.width, SURVIVOR.height);
  const gun = (x: number, y: number, w: number, h = 2) => {
    p.rect(x, y, w, h, M[1]);
    p.rect(x, y, w, 1, M[3]);
  };

  // Shoulders, seen from above.
  torso(p, U, 3.2, 5.6);

  // The gun first; the hands that hold it go over it.
  let top: [number, number];
  let bottom: [number, number];
  if (pose === "pistol") {
    gun(12, 8, 4);
    top = [11, 7];
    bottom = [11, 9];
  } else if (pose === "machinegun") {
    gun(9, 8, 7);
    p.rect(16, 9, 2, 1, M[2]);
    p.set(12, 10, M[0]);
    p.set(8, 9, W[2]);
    top = [14, 7];
    bottom = [10, 9];
  } else if (pose === "silencer") {
    gun(12, 8, 3);
    p.rect(15, 8, 3, 2, M[0]);
    p.rect(15, 8, 3, 1, M[2]);
    top = [11, 7];
    bottom = [11, 9];
  } else if (pose === "hold") {
    gun(11, 8, 3);
    top = [10, 7];
    bottom = [10, 9];
  } else {
    // Reloading: the gun tipped down, the free hand bringing a magazine.
    p.rect(10, 10, 2, 3, M[1]);
    p.rect(10, 10, 1, 3, M[3]);
    p.rect(10, 4, 1, 2, M[3]);
    top = [9, 5];
    bottom = [10, 9];
  }

  // Bare arms from short sleeves, then hands.
  p.line(8.5, 2.5, top[0] - 0.5, top[1] - 0.5, S[1]);
  p.line(9.5, 2.5, top[0] - 0.5, top[1] - 0.5, S[1]);
  p.line(8.5, 11.5, bottom[0] - 0.5, bottom[1] + 0.5, S[0]);
  p.line(9.5, 11.5, bottom[0] - 0.5, bottom[1] + 0.5, S[0]);
  p.rect(7, 2, 2, 2, U[3]);
  p.rect(7, 10, 2, 2, U[1]);
  p.rect(top[0] - 1, top[1] - 1, 2, 2, S[2]);
  p.set(top[0] - 1, top[1] - 1, S[3]);
  p.rect(bottom[0] - 1, bottom[1], 2, 2, S[1]);

  // The head over everything: hair, with the forehead showing at the front.
  p.ball(6.5, 7, 2.5, 2.5, H);
  p.set(8, 6, S[2]);
  p.set(8, 7, S[1]);
  p.set(5, 5, H[2]);

  return p.outline(INK);
}

/** Shoulders from above: a rounded block, lit like everything else. */
function torso(p: Pixels, ramp: Color[], rx: number, ry: number): void {
  p.each(
    (x, y) => Math.abs((x - 6) / rx) ** 2.6 + Math.abs((y - 7) / ry) ** 2.6 <= 1,
    (x, y) => ramp[lightAt((x + 0.5 - 6) / rx, (y + 0.5 - 7) / ry, ramp.length)],
  );
}

// ------------------------------------------------------------ the shambling

/** Zombie and robot frames: 18 × 14, head at (6.5, 7), facing right. */
export const WALKER = { width: 18, height: 14, headX: 6.5 };

/** How far each arm reaches on each of the four walk frames. */
const REACH: [number, number][] = [
  [2, 0],
  [1, 1],
  [0, 2],
  [1, 1],
];

function zombie(step: number): Pixels {
  const p = new Pixels(WALKER.width, WALKER.height);
  const [a, b] = REACH[step];

  torso(p, R, 3, 5.8);
  // Torn rags, skin through the holes, and the bite that started it.
  p.set(4, 3, Z[1]);
  p.set(3, 8, Z[1]);
  p.set(5, 11, Z[2]);
  p.set(7, 10, E[1]);
  p.set(8, 10, E[0]);

  // Both arms straight out, the way they all walk.
  for (const [y, reach] of [
    [4, a],
    [10, b],
  ] as const) {
    p.line(8, y, 12 + reach, y, Z[1], 2);
    p.line(8, y - 1, 12 + reach, y - 1, Z[2]);
    p.rect(8, y - 1, 2, 2, R[1]);
    p.set(13 + reach, y - 1, Z[3]);
    p.set(13 + reach, y, Z[2]);
  }

  p.ball(6.5, 7, 2.3, 2.3, Z);
  p.set(8, 6, E[2]);
  p.set(8, 7, E[2]);
  p.set(5, 6, H[0]);
  p.set(6, 8, H[0]);
  return p.outline(INK);
}

function robot(step: number): Pixels {
  const p = new Pixels(WALKER.width, WALKER.height);
  const [a, b] = REACH[step];

  // A boxier body than a zombie's: a superellipse, lit the same way.
  const box = (x: number, y: number) => ((x - 6) / 4) ** 4 + ((y - 7) / 6) ** 4 <= 1;
  p.each(box, (x, y) => M[1 + lightAt((x + 0.5 - 6) / 4, (y + 0.5 - 7) / 6, 3)]);
  p.rect(3, 2, 2, 1, M[4]);
  p.rect(3, 11, 2, 1, M[2]);

  // Pistons for arms, a claw at each end.
  for (const [y, reach] of [
    [3, a],
    [10, b],
  ] as const) {
    p.rect(9, y, 3 + reach, 2, M[2]);
    p.rect(9, y, 3 + reach, 1, M[3]);
    p.set(12 + reach, y - 1, M[4]);
    p.set(12 + reach, y + 2, M[3]);
    p.rect(12 + reach, y, 2, 2, M[3]);
  }

  // Head: a dark block with a visor whose light sweeps as it walks.
  p.rect(4, 5, 5, 4, M[0]);
  p.rect(4, 5, 5, 1, M[1]);
  p.rect(8, 5, 1, 4, E[1]);
  p.set(8, 5 + step, E[3]);
  p.set(4, 4, M[4]);
  return p.outline(INK);
}

// ---------------------------------------------------------------- effects

function bullet(): Pixels {
  const p = new Pixels(2, 4);
  p.rect(0, 0, 2, 1, Y[4]);
  p.rect(0, 1, 2, 1, Y[3]);
  p.rect(0, 2, 2, 1, Y[2]);
  p.rect(0, 3, 2, 1, Y[1]);
  return p;
}

/** A blast, frame by frame: flash, fireball, breaking up, smoke, gone. */
function blast(step: number): Pixels {
  const p = new Pixels(32, 32);
  const rand = rng(40 + step);
  const noisy = (r: number, amount: number) => (x: number, y: number) =>
    Math.hypot(x - 16, y - 16) + (hash(Math.floor(x), Math.floor(y), step) - 0.5) * amount <= r;
  const by = (r: number, ramp: Color[], amount: number) => (x: number, y: number) => {
    const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16) + (hash(x, y, step + 9) - 0.5) * amount;
    return ramp[Math.min(ramp.length - 1, Math.max(0, Math.floor((1 - d / r) * ramp.length)))];
  };

  if (step === 0) {
    p.ball(16, 16, 5, 5, [Y[2], Y[3], Y[4]]);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.set(16 + Math.cos(a) * 8, 16 + Math.sin(a) * 8, Y[3]);
    }
    return p.outline(Y[0]);
  }
  if (step === 1) return p.each(noisy(9, 3), by(9, [Y[1], Y[2], Y[3], Y[4]], 3)).outline(E[1]);
  if (step === 2) return p.each(noisy(12, 4), by(12, [E[2], Y[1], Y[2], Y[3]], 4)).outline(E[0]);

  // Breaking up: the ball becomes puffs, fire giving way to smoke.
  const puffs: [number, number, number][] = [];
  const count = step === 3 ? 6 : 7;
  const spread = step === 3 ? 8 : step === 4 ? 9 : 11;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.6;
    const d = spread * (0.6 + rand() * 0.4);
    puffs.push([16 + Math.cos(a) * d, 16 + Math.sin(a) * d, (step === 5 ? 5 : 4.5) + rand() * 2]);
  }
  puffs.push([16, 16, step === 3 ? 7 : 6]);
  const ramp = step === 3 ? K.slice(0, 3) : step === 4 ? K : [K[1], K[2], K[3]];
  for (const [cx, cy, r] of step === 3 ? puffs.slice(0, -1) : puffs) {
    p.each(
      (x, y) => ((x - cx) / r) ** 2 + ((y - cy) / r) ** 2 <= 1 && (step < 5 || dither(Math.floor(x), Math.floor(y), 0.55)),
      (x, y) => ramp[lightAt((x + 0.5 - cx) / r, (y + 0.5 - cy) / r, ramp.length)],
    );
  }
  if (step === 3) p.each(noisy(8, 4), by(8, [E[1], E[2], Y[1], Y[2], Y[3]], 4));
  if (step === 4) {
    for (let i = 0; i < 9; i++) p.set(6 + rand() * 20, 6 + rand() * 20, i % 2 ? Y[1] : E[2]);
  }
  return step === 5 ? p : p.outline(step === 3 ? E[0] : INK);
}

// ------------------------------------------------------------------ guns

function machinegun(): Pixels {
  const p = new Pixels(18, 7);
  p.rect(1, 2, 4, 3, W[2]);
  p.rect(1, 2, 4, 1, W[3]);
  p.rect(5, 2, 7, 2, M[1]);
  p.rect(5, 2, 7, 1, M[3]);
  p.rect(12, 2, 5, 1, M[2]);
  p.rect(7, 4, 2, 2, M[1]);
  p.rect(9, 4, 2, 2, M[0]);
  p.set(8, 1, M[3]);
  return p.outline(INK);
}

function silencer(): Pixels {
  const p = new Pixels(18, 6);
  p.rect(1, 1, 6, 2, M[1]);
  p.rect(1, 1, 6, 1, M[3]);
  p.rect(2, 3, 2, 2, M[1]);
  p.rect(7, 1, 9, 2, M[0]);
  p.rect(7, 1, 9, 1, M[2]);
  return p.outline(INK);
}

// ------------------------------------------------------------------ tiles

/** Where each tile sits in tiles.png, 8 to a row: the numbers Tiled shows. */
export const TILE_INDEX = {
  GRASS: [0, 1, 2, 3],
  DIRT: [4, 5],
  /** Plain slabs three times as often as cracked ones. */
  CONCRETE: [6, 6, 6, 7],
  WOOD: 8,
  LEAVES: 9,
  DEBRIS: [10, 11, 12, 13],
  BUSH: 14,
  HATCH: 15,
  /** 2 × 2. */
  TREE: [
    [16, 17],
    [24, 25],
  ],
  BARREL: 18,
  CRATE: 19,
  SCORCH: 20,
  /**
   * The walls, by which neighbours are wall too — what Tiled's terrain brush
   * does. Bits: 1 north, 2 east, 4 south, 8 west.
   */
  WALL: (mask: number) => 32 + mask,
};

/** The grass colour, for the scene's background. */
export const GROUND = G[2];

const tile = () => new Pixels(16, 16);

function grass(v: number): Pixels {
  const p = tile().fill(G[2]);
  const rand = rng(10 + v);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (hash(x, y, v) < 0.08) p.set(x, y, G[1]);
  for (let i = 0; i < 7; i++) {
    const x = 1 + Math.floor(rand() * 12);
    const y = 2 + Math.floor(rand() * 12);
    p.set(x, y, G[3]);
    p.set(x + 1, y - 1, G[4]);
    p.set(x + 2, y, G[3]);
    p.set(x + 1, y, G[1]);
  }
  if (v === 2) {
    for (const [x, y] of [
      [4, 4],
      [11, 10],
    ]) {
      p.set(x, y, Y[2]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.set(x + dx, y + dy, WHITE);
    }
  }
  return p;
}

function dirt(v: number): Pixels {
  const p = tile().fill(D[2]);
  const rand = rng(20 + v);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const h = hash(x, y, 20 + v);
      if (h < 0.1) p.set(x, y, D[1]);
      else if (h > 0.93) p.set(x, y, D[3]);
    }
  }
  for (let i = 0; i < 3; i++) {
    const x = 1 + Math.floor(rand() * 13);
    const y = 1 + Math.floor(rand() * 13);
    p.set(x, y, D[4]);
    p.set(x + 1, y, D[3]);
    p.rect(x, y + 1, 2, 1, D[0]);
  }
  return p;
}

function concrete(v: number): Pixels {
  const p = tile().fill(C[2]);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const h = hash(x, y, 30 + v);
      if (h < 0.07) p.set(x, y, C[1]);
      else if (h > 0.94) p.set(x, y, C[3]);
    }
  }
  p.rect(0, 0, 16, 1, C[3]);
  p.rect(0, 0, 1, 16, C[3]);
  p.rect(0, 15, 16, 1, C[1]);
  p.rect(15, 0, 1, 16, C[1]);
  if (v === 1) {
    const rand = rng(33);
    let x = 4;
    let y = 3;
    for (let i = 0; i < 10; i++) {
      p.set(x, y, C[0]);
      x += rand() < 0.6 ? 1 : 0;
      y += 1;
    }
  }
  return p;
}

function wood(): Pixels {
  const p = tile();
  for (let y = 0; y < 16; y++) {
    const plank = Math.floor(y / 4);
    const seam = (plank * 5 + 3) % 16;
    for (let x = 0; x < 16; x++) {
      let c = plank % 2 ? W[2] : W[3];
      if (y % 4 === 0) c = plank % 2 ? W[3] : W[4];
      if (hash(x, y, 40) < 0.1) c = W[1];
      if (x === seam) c = W[0];
      if (y % 4 === 3) c = W[0];
      p.set(x, y, c);
    }
  }
  return p;
}

function leaves(): Pixels {
  const p = tile();
  const rand = rng(50);
  const colors = [G[3], G[4], Y[1], D[3], G[3]];
  for (const c of colors) {
    const x = 1 + Math.floor(rand() * 13);
    const y = 1 + Math.floor(rand() * 13);
    p.set(x + 1, y + 1, SHADOW);
    p.set(x, y, c);
    p.set(x + 1, y, c);
  }
  return p;
}

function rubble(): Pixels {
  const p = tile();
  for (const [x, y, w] of [
    [3, 4, 3],
    [9, 3, 2],
    [6, 9, 3],
    [11, 11, 2],
  ]) {
    p.rect(x + 1, y + 2, w, 1, SHADOW);
    p.rect(x, y, w, 2, C[2]);
    p.set(x, y, C[4]);
    p.set(x + w - 1, y + 1, C[1]);
  }
  return p;
}

function skull(): Pixels {
  const p = tile();
  const rows = [".bbb.", "bbbbb", "bkbkb", "bbbbb", ".b.b."];
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === "b") p.set(5 + x, 5 + y, y < 2 ? BONE[2] : BONE[1]);
      if (ch === "k") p.set(5 + x, 5 + y, INK);
    }),
  );
  p.outline(INK);
  p.rect(11, 11, 3, 1, BONE[1]);
  p.set(11, 11, BONE[2]);
  p.set(13, 10, BONE[0]);
  return p;
}

function stain(): Pixels {
  const p = tile();
  return p.each(
    (x, y) => Math.hypot(x - 8, (y - 8) * 1.3) + (hash(Math.floor(x), Math.floor(y), 60) - 0.5) * 3 < 5.5,
    (x, y) => (Math.hypot(x + 0.5 - 8, y + 0.5 - 8) < 3 ? "#4e0f16d8" : dither(x, y, 0.7) ? "#6e1820b0" : null),
  );
}

function casings(): Pixels {
  const p = tile();
  for (const [x, y] of [
    [3, 4],
    [6, 7],
    [10, 5],
    [8, 11],
  ]) {
    p.set(x, y, Y[2]);
    p.set(x, y + 1, Y[0]);
  }
  p.rect(11, 10, 3, 2, WHITE);
  p.set(13, 11, BONE[1]);
  return p;
}

function bush(): Pixels {
  const p = tile();
  for (const [cx, cy, rx, ry] of [
    [8, 9, 5.5, 4.5],
    [5, 7, 3.5, 3],
    [11, 7, 3.5, 3],
    [8, 5, 3.5, 3],
  ]) {
    p.ball(cx, cy, rx, ry, G.slice(1));
  }
  return p.outline(INK);
}

function tree(): Pixels {
  const p = new Pixels(32, 32);
  const clumps: [number, number, number, number][] = [
    [16, 17, 11, 10],
    [10, 12, 7, 6],
    [22, 12, 7, 6],
    [16, 8, 7, 6],
    [9, 21, 6, 5],
    [23, 21, 6, 5],
    [16, 24, 7, 5],
  ];
  for (const [cx, cy, rx, ry] of clumps) p.ball(cx, cy, rx, ry, G);
  // Leaves catching the light, where the light already is.
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (p.get(x, y) >>> 8 === parseInt(G[3].slice(1), 16) && hash(x, y, 70) < 0.25) p.set(x, y, G[4]);
    }
  }
  return p.outline(INK);
}

function hatch(): Pixels {
  const p = tile();
  p.ball(8, 8, 6.5, 6.5, M.slice(0, 4));
  p.each(
    (x, y) => Math.hypot(x - 8, y - 8) <= 4.4,
    (x, y) => (y % 2 === 0 ? M[1] : M[0]),
  );
  for (const [x, y] of [
    [3, 3],
    [12, 3],
    [3, 12],
    [12, 12],
  ]) {
    p.set(x, y, M[4]);
  }
  return p.outline(INK);
}

function barrel(): Pixels {
  const p = tile();
  p.ball(8, 8, 6, 6, E);
  p.each(
    (x, y) => {
      const d = Math.hypot(x - 8, y - 8);
      return d > 3.6 && d <= 4.6;
    },
    () => E[0],
  );
  p.set(8, 7, Y[2]);
  p.set(7, 8, Y[2]);
  p.set(8, 8, Y[3]);
  p.set(9, 8, Y[2]);
  p.set(8, 9, Y[2]);
  p.set(10, 5, M[0]);
  return p.outline(INK);
}

function crate(): Pixels {
  const p = tile();
  p.rect(2, 2, 12, 12, W[3]);
  for (let i = 2; i < 14; i++) {
    p.set(i, 2, W[4]);
    p.set(2, i, W[4]);
    p.set(i, 13, W[1]);
    p.set(13, i, W[1]);
  }
  p.rect(3, 6, 10, 1, W[1]);
  p.rect(3, 9, 10, 1, W[1]);
  p.line(4, 11, 11, 4, W[2]);
  p.line(4, 10, 10, 4, W[4]);
  for (const [x, y] of [
    [3, 3],
    [12, 3],
    [3, 12],
    [12, 12],
  ]) {
    p.set(x, y, M[3]);
  }
  return p.outline(INK);
}

function scorch(): Pixels {
  const p = tile();
  return p.each(
    (x, y) => Math.hypot(x - 8, y - 8) + (hash(Math.floor(x), Math.floor(y), 80) - 0.5) * 3 < 7.5,
    (x, y) => {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d < 3.5) return "#1b1724e0";
      return dither(x, y, d < 5.5 ? 0.6 : 0.3) ? "#1b1724c0" : null;
    },
  );
}

/** A brick wall tile, its arms reaching the neighbours named by `mask`. */
function wall(mask: number): Pixels {
  const p = tile();
  const [n, e, s, w] = [1, 2, 4, 8].map((bit) => (mask & bit) !== 0);
  const band = (v: number) => v >= 2 && v <= 13;
  const inShape = (x: number, y: number): boolean => {
    if (x < 0) return w && band(y);
    if (x > 15) return e && band(y);
    if (y < 0) return n && band(x);
    if (y > 15) return s && band(x);
    if (band(x) && band(y)) return true;
    if (y < 2) return n && band(x);
    if (y > 13) return s && band(x);
    if (x < 2) return w && band(y);
    return e && band(y);
  };
  const edge = (x: number, y: number) =>
    !inShape(x - 1, y) || !inShape(x + 1, y) || !inShape(x, y - 1) || !inShape(x, y + 1);

  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (!inShape(x, y)) {
        // The wall's shadow falls down and to the right.
        if (inShape(x - 1, y - 2) || inShape(x, y - 2)) p.set(x, y, SHADOW);
        continue;
      }
      if (edge(x, y)) {
        p.set(x, y, INK);
        continue;
      }
      const row = Math.floor(y / 4);
      const offset = row % 2 ? 4 : 0;
      let c = hash(Math.floor((x + offset) / 8), row, mask) < 0.5 ? B[2] : B[3];
      if (y % 4 === 0) c = B[3];
      if (y % 4 === 3 || (x + offset) % 8 === 7) c = B[1];
      if (edge(x, y - 1) && !inShape(x, y - 2)) c = B[4];
      else if (edge(x - 1, y) && !inShape(x - 2, y)) c = B[4];
      p.set(x, y, c);
    }
  }
  return p;
}

// --------------------------------------------------------------- the files

/**
 * Every art file, as it lands in assets/: two packed atlases with their
 * Starling XML, the tilesheet and two gun images.
 */
export function drawArt(scale = PX): Record<string, Buffer | string> {
  const poses: Pose[] = ["pistol", "machinegun", "silencer", "hold", "reload"];
  const characters = packAtlas(
    "characters.png",
    [
      ...poses.map((pose) => ({ name: `survivor_${pose}`, pixels: survivor(pose) })),
      ...REACH.map((_, i) => ({ name: `zombie_${i}`, pixels: zombie(i) })),
      ...REACH.map((_, i) => ({ name: `robot_${i}`, pixels: robot(i) })),
    ],
    scale,
  );
  const effects = packAtlas(
    "effects.png",
    [{ name: "bullet", pixels: bullet() }, ...[0, 1, 2, 3, 4, 5].map((i) => ({ name: `blast_${i}`, pixels: blast(i) }))],
    scale,
    100,
  );

  const sheet = new Pixels(8 * 16, 6 * 16);
  const put = (index: number, pixels: Pixels) => sheet.stamp(pixels, (index % 8) * 16, Math.floor(index / 8) * 16);
  const T = TILE_INDEX;
  T.GRASS.forEach((i, v) => put(i, grass(v)));
  T.DIRT.forEach((i, v) => put(i, dirt(v)));
  [...new Set(T.CONCRETE)].forEach((i, v) => put(i, concrete(v)));
  put(T.WOOD, wood());
  put(T.LEAVES, leaves());
  [rubble, skull, stain, casings].forEach((draw, k) => put(T.DEBRIS[k], draw()));
  put(T.BUSH, bush());
  put(T.HATCH, hatch());
  const big = tree();
  T.TREE.forEach((row, r) =>
    row.forEach((index, c) => {
      const part = new Pixels(16, 16);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) part.data[y * 16 + x] = big.get(c * 16 + x, r * 16 + y);
      }
      put(index, part);
    }),
  );
  put(T.BARREL, barrel());
  put(T.CRATE, crate());
  put(T.SCORCH, scorch());
  for (let mask = 0; mask < 16; mask++) put(T.WALL(mask), wall(mask));

  return {
    "characters.png": characters.png,
    "characters.xml": characters.xml,
    "effects.png": effects.png,
    "effects.xml": effects.xml,
    "tiles.png": sheet.png(scale),
    "weapon_machine.png": machinegun().png(scale),
    "weapon_silencer.png": silencer().png(scale),
  };
}
