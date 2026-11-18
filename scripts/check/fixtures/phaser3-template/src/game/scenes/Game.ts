import { Scene } from 'phaser';
import { Star } from '../objects/Star';

export class Game extends Scene
{
    camera: Phaser.Cameras.Scene2D.Camera;
    background: Phaser.GameObjects.Image;
    platforms: Phaser.Physics.Arcade.StaticGroup;
    stars: Star[] = [];

    constructor ()
    {
        super('Game');
    }

    create ()
    {
        this.camera = this.cameras.main;
        this.camera.setBackgroundColor(0x00ff00);

        this.background = this.add.image(512, 384, 'background');
        this.background.setAlpha(0.5);

        this.platforms = this.physics.add.staticGroup();
        for (let i = 0; i < 6; i++)
        {
            this.platforms.create(160 + i * 140, 700, 'platform');
        }

        for (let i = 0; i < 5; i++)
        {
            this.stars.push(new Star(this, 200 + i * 150, 200));
        }

        this.physics.add.collider(this.stars, this.platforms);

        this.input.once('pointerdown', () => {

            this.scene.start('GameOver');

        });
    }
}
