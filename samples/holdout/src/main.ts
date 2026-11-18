import Phaser from "phaser";
import { Title } from "./scenes/Title";
import { Level_01 } from "./scenes/Level_01";

const scenes = [Title, Level_01];

// Mosaic's RUN opens the game at ?scene=<ClassName>, so it starts on the scene
// you are editing rather than wherever the game normally boots.
const first = new URLSearchParams(window.location.search).get("scene");
scenes.sort((a, b) => Number(b.name === first) - Number(a.name === first));

new Phaser.Game({
  type: Phaser.AUTO,
  width: 1024,
  height: 576,
  backgroundColor: "#14171a",
  pixelArt: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: scenes,
});
