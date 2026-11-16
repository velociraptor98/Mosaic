import Phaser from "phaser";
import { Level_01 } from "./scenes/Level_01";

const scenes = [Level_01];

// Mosaic's RUN opens the game at ?scene=<ClassName>, so it starts on the scene
// you are editing rather than wherever the game normally boots.
const first = new URLSearchParams(window.location.search).get("scene");
scenes.sort((a, b) => Number(b.name === first) - Number(a.name === first));

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 960,
  height: 540,
  backgroundColor: "#14171a",
  pixelArt: true,
  roundPixels: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  // The second stick. Without this the gamepad plugin is not created at all.
  input: { gamepad: true },
  scene: scenes,
};

new Phaser.Game(config);
