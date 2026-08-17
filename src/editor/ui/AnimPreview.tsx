import Phaser from "phaser";
import { useEffect, useRef } from "react";
import type { AnimDef, AssetDef } from "../../shared/types";

/**
 * The preview runs the real Phaser animation manager in a throwaway game
 * sharing the same texture bytes, so the timing you approve here is the
 * timing the shipped game plays.
 */
export function AnimPreview({ anim, assets }: { anim: AnimDef; assets: AssetDef[] }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const needed = [...new Set(anim.frames.map((f) => f.textureKey))]
      .map((key) => assets.find((a) => a.key === key))
      .filter((a): a is AssetDef => !!a && !!a.url);

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      width: 132,
      height: 132,
      transparent: true,
      audio: { noAudio: true },
      banner: false,
      scene: {
        preload(this: Phaser.Scene) {
          for (const asset of needed) {
            if (asset.kind === "spritesheet") {
              this.load.spritesheet(asset.key, asset.url, {
                frameWidth: asset.frameWidth ?? 32,
                frameHeight: asset.frameHeight ?? 32,
                margin: asset.margin ?? 0,
                spacing: asset.spacing ?? 0,
              });
            } else {
              this.load.image(asset.key, asset.url);
            }
          }
        },
        create(this: Phaser.Scene) {
          for (const asset of needed) {
            if (asset.kind !== "atlas" || !asset.frames) continue;
            if (!this.textures.exists(asset.key)) continue;
            const tex = this.textures.get(asset.key);
            for (const f of asset.frames) {
              if (!tex.has(f.name)) tex.add(f.name, 0, f.x, f.y, f.w, f.h);
            }
          }
          if (!anim.frames.length) return;
          this.anims.create({
            key: anim.key,
            frames: anim.frames.map((f) => ({
              key: f.textureKey,
              frame: f.frame,
              duration: f.duration ?? 0,
            })),
            frameRate: anim.fps,
            repeat: anim.loop ? -1 : 0,
          });
          const sprite = this.add.sprite(66, 66, anim.frames[0].textureKey, anim.frames[0].frame);
          const scale = Math.min(96 / (sprite.width || 32), 96 / (sprite.height || 32));
          sprite.setScale(Math.max(1, Math.floor(scale)));
          sprite.play(anim.key);
        },
      },
    });

    return () => game.destroy(true);
  }, [anim, assets]);

  return <div className="anim-preview" ref={hostRef} />;
}
