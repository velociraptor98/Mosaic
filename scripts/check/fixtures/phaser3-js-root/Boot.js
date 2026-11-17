export default class Boot extends Phaser.Scene
{
    constructor ()
    {
        super('Boot');
    }

    preload ()
    {
        this.load.setBaseURL('https://cdn.phaserfiles.com/v385');
        this.load.setPath('assets/games/bank-panic/');
        this.load.image('title');
    }

    create ()
    {
        this.scene.start('MainMenu');
    }
}
