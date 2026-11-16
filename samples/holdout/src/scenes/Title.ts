import Phaser from "phaser";
import { createTitle, preloadTitle, type TitleLayout } from "./Title.layout";

/**
 * Title — this file is yours.
 *
 * Everything on screen was placed in the editor: the grass is the Ground layer
 * of the level's own Tiled map, the figures are atlas frames, the words are
 * text objects. This only makes the prompt blink and starts the game.
 */
export class Title extends Phaser.Scene {
  layout!: TitleLayout;

  constructor() {
    super("Title");
  }

  preload(): void {
    preloadTitle(this);
  }

  create(): void {
    this.layout = createTitle(this);
    this.tweens.add({ targets: this.layout.prompt, alpha: 0.2, duration: 650, yoyo: true, repeat: -1 });
    const start = () => this.scene.start("Level_01");
    this.input.once("pointerdown", start);
    this.input.keyboard?.once("keydown-SPACE", start);
  }
}
