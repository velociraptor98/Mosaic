import Phaser from "phaser";
import { Bullet } from "./Bullet";
import { PlayerBase } from "./Player.layout";

export type Weapon = "pistol" | "machinegun" | "silencer";

/** Each gun: the frame that holds it, ms between shots, clip size, spread in radians, how loud. */
const GUNS: Record<Weapon, { frame: string; rate: number; clip: number; spread: number; volume: number }> = {
  pistol: { frame: "survivor_pistol", rate: 280, clip: 12, spread: 0.03, volume: 0.6 },
  machinegun: { frame: "survivor_machinegun", rate: 95, clip: 40, spread: 0.1, volume: 0.45 },
  silencer: { frame: "survivor_silencer", rate: 190, clip: 20, spread: 0.015, volume: 0.12 },
};

type Keys = Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

/** Where the barrel ends, from the sprite's origin, facing right: forward and to the side. */
const MUZZLE = { forward: 38, side: 8 };

/**
 * Player — this file is yours.
 *
 * WASD to move, the mouse to aim, click (or hold) to shoot, R to reload. The
 * art and the body come from PlayerBase, which Mosaic regenerates. The fields
 * tagged @editable show in Mosaic's inspector; the values here are the defaults.
 */
export class Player extends PlayerBase {
  /** Pixels per second. @editable { min: 0, max: 400 } */
  speed = 200;

  /** Health at the start of the round. @editable { min: 1, max: 200 } */
  health = 100;

  /** The gun the round starts with. @editable { options: ["pistol", "machinegun", "silencer"] } */
  weapon: Weapon = "pistol";

  /** Where bullets go. Set by the scene. */
  bullets?: Phaser.Physics.Arcade.Group;
  ammo = 0;
  clip = 0;
  reloading = false;
  private maxHealth = 0;
  private nextShot = 0;
  private readonly keys: Keys;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    this.keys = scene.input.keyboard!.addKeys({ up: "W", down: "S", left: "A", right: "D" }) as Keys;
    this.on(Phaser.Animations.Events.ANIMATION_COMPLETE_KEY + "survivor_reload", () => {
      this.reloading = false;
      this.ammo = this.clip;
      this.setFrame(GUNS[this.weapon].frame);
    });
  }

  /** Picks up a gun, full. */
  arm(weapon: Weapon): void {
    this.maxHealth ||= this.health;
    this.weapon = weapon;
    this.clip = GUNS[weapon].clip;
    this.ammo = this.clip;
    this.reloading = false;
    this.stop();
    this.setFrame(GUNS[weapon].frame);
  }

  reload(): void {
    if (this.reloading || this.ammo === this.clip || !this.active) return;
    this.reloading = true;
    this.play("survivor_reload");
    this.scene.sound.play("audio_reload", { volume: 0.5 });
  }

  /** Takes damage, with a red flash. True when that was the last of it. */
  hurt(amount: number): boolean {
    this.health -= amount;
    this.setTint(0xff6666);
    this.scene.time.delayedCall(120, () => this.clearTint());
    this.scene.cameras.main.shake(120, 0.006);
    if (this.health > 0) return false;
    this.setActive(false);
    this.setVelocity(0, 0);
    this.setAlpha(0.5);
    return true;
  }

  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  override preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (!this.active) return;

    const { up, down, left, right } = this.keys;
    const move = new Phaser.Math.Vector2(Number(right.isDown) - Number(left.isDown), Number(down.isDown) - Number(up.isDown));
    this.body.velocity.copy(move.normalize().scale(this.speed));

    // Face the pointer, wherever the camera has scrolled to.
    const pointer = this.scene.input.activePointer;
    pointer.updateWorldPoint(this.scene.cameras.main);
    this.setRotation(Phaser.Math.Angle.Between(this.x, this.y, pointer.worldX, pointer.worldY));

    if (pointer.isDown && time >= this.nextShot) this.fire(time, pointer);
  }

  private fire(time: number, pointer: Phaser.Input.Pointer): void {
    if (this.reloading) return;
    if (this.ammo <= 0) {
      this.reload();
      return;
    }
    const gun = GUNS[this.weapon];
    this.nextShot = time + gun.rate;
    this.ammo -= 1;

    const a = this.rotation;
    const x = this.x + Math.cos(a) * MUZZLE.forward - Math.sin(a) * MUZZLE.side;
    const y = this.y + Math.sin(a) * MUZZLE.forward + Math.cos(a) * MUZZLE.side;
    const aim = Phaser.Math.Angle.Between(x, y, pointer.worldX, pointer.worldY);

    // A bullet is a prefab nobody placed: made here, joined to its group,
    // then launched — the group resets velocity on everything it takes.
    const bullet = new Bullet(this.scene, x, y);
    this.bullets?.add(bullet);
    bullet.setDepth(this.depth - 0.5);
    bullet.launch(aim + Phaser.Math.FloatBetween(-gun.spread, gun.spread));
    this.scene.sound.play("audio_shot", { volume: gun.volume, detune: Phaser.Math.Between(-150, 150) });
  }
}
