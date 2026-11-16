import { BarrelBase } from "./Barrel.layout";

/**
 * Barrel — this file is yours.
 *
 * What a barrel does when it goes up is the scene's business, since it reaches
 * everything nearby. This only says how much it takes and how far it reaches.
 */
export class Barrel extends BarrelBase {
  /** Shots before it goes up. @editable { min: 1, max: 10 } */
  health = 2;

  /** Blast radius in pixels. @editable { min: 32, max: 400 } */
  radius = 150;

  /** Hits it takes off every enemy in the blast. @editable { min: 0, max: 50 } */
  damage = 6;

  /** Takes a shot. True when that sets it off. */
  hit(): boolean {
    this.health -= 1;
    this.setTint(0xffaa66);
    this.scene.time.delayedCall(80, () => this.clearTint());
    return this.health <= 0;
  }
}
