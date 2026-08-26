// Mirrors mosaic.config.json — keep the two in step, or let the editor
// rewrite this file when the project defaults change.
import Phaser from "phaser";
import { Level_01 } from "./scenes/Level_01";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: "#1d2d3d",
  pixelArt: false,
  roundPixels: false,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [Level_01],
};

new Phaser.Game(config);
