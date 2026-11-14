import Phaser from "phaser";
import { createLevel_01, preloadLevel_01, type Level_01Layout } from "./Level_01.layout";

/**
 * Level 01 — this file is yours.
 *
 * Mosaic wrote it once, as a starting point, and will not touch it again. What
 * you place in the editor arrives through ./Level_01.layout.ts, which is
 * regenerated on every save: `createLevel_01(this)` builds the scene and hands
 * the objects back by name.
 */
export class Level_01 extends Phaser.Scene {
  layout!: Level_01Layout;

  constructor() {
    super("Level_01");
  }

  preload(): void {
    preloadLevel_01(this);
  }

  create(): void {
    this.layout = createLevel_01(this);
  }

  update(_time: number, _delta: number): void {}
}
