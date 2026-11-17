export default class MainMenu extends Phaser.Scene
{
    constructor ()
    {
        super('MainMenu');
    }

    create ()
    {
        this.add.image(512, 384, 'title');
        this.input.once('pointerdown', () => this.scene.start('MainGame'));
    }
}
