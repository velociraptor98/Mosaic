import Phaser from "phaser";
import { PickupBase } from "./Pickup.layout";
import type { Weapon } from "./Player";

/**
 * Pickup — this file is yours.
 *
 * A gun on the floor. The prefab exposes its texture, so each one placed can
 * show the gun it gives.
 */
export class Pickup extends PickupBase {
  /** The gun it gives. @editable { options: ["machinegun", "silencer"] } */
  weapon: Weapon = "machinegun";

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    scene.tweens.add({ targets: this, angle: 360, duration: 4000, repeat: -1 });
  }
}
