import { Physics, Scene } from 'phaser';

/** A star that falls, lands and bounces a little. */
export class Star extends Physics.Arcade.Sprite
{
    constructor (scene: Scene, x: number, y: number)
    {
        super(scene, x, y, 'star');
        scene.add.existing(this);
        scene.physics.add.existing(this);
        this.setBounceY(0.4);
    }
}
