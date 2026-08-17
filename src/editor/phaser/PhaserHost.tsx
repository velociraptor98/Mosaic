import Phaser from "phaser";
import { useEffect, useRef } from "react";
import { EditorScene } from "./EditorScene";
import { PlayScene } from "./PlayScene";
import type { EditorBridge } from "../bridge";
import type { ProjectStore } from "../store/project";
import type { Playtest } from "./playtest";

interface Props {
  store: ProjectStore;
  bridge: EditorBridge;
  playtest: Playtest;
}

/**
 * The ONLY place a Phaser.Game is constructed. Both the editor scene and the
 * play-test scene live in this one game instance, which is what lets RUN
 * happen in place, in the canvas you were editing.
 */
export function PhaserHost({ store, bridge, playtest }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: "#eeeeef", // --color-bg under the 2% canvas wash
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
      physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
      audio: { noAudio: true },
      banner: false,
    });

    // Registered by hand rather than through `scene:` so EditorScene can never
    // auto-boot without its init data, and PlayScene stays dormant until RUN.
    game.scene.add("EditorScene", EditorScene, true, { store, bridge });
    game.scene.add("PlayScene", PlayScene, false);
    gameRef.current = game;
    playtest.game = game;

    return () => {
      playtest.game = null;
      game.destroy(true);
      gameRef.current = null;
    };
    // The scene reads further changes straight from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="phaser-host" ref={containerRef} />;
}
