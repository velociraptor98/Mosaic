// The shape of every game in the phaser-examples collection: Phaser 2 (CE),
// a positional Game constructor and states rather than scenes.
var game = new Phaser.Game(960, 720, Phaser.AUTO, "game");

var mainState = {
  preload: function () {
    game.load.image("paddle", "assets/paddle.png");
  },
  create: function () {
    this.paddle = game.add.sprite(480, 680, "paddle");
  }
};

game.state.add("main", mainState);
game.state.start("main");
