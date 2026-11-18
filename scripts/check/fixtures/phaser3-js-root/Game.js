export default class MainGame extends Phaser.Scene
{
    constructor ()
    {
        super('MainGame');
    }

    create ()
    {
        this.add.image(512, 384, 'title');
    }
}
