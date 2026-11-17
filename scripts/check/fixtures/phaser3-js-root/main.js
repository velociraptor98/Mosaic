import Boot from './Boot.js';
import MainMenu from './MainMenu.js';
import MainGame from './Game.js';

// The shape of the games in Phaser's own examples repo (public/src/games):
// plain JavaScript, every scene loose beside main.js, art from a CDN, and a
// scene class whose name is not its file's.
const config = {
    type: Phaser.AUTO,
    width: 1024,
    height: 768,
    backgroundColor: '#2e91f3',
    parent: 'phaser-example',
    scene: [ Boot, MainMenu, MainGame ]
};

let game = new Phaser.Game(config);
