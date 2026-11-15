import Phaser from "phaser";
import { useEffect, useRef } from "react";
import { EditorScene } from "./EditorScene";
import type { EditorBridge } from "../bridge";
import type { ProjectStore } from "../store/project";

interface Props {
  store: ProjectStore;
  bridge: EditorBridge;
}

/**
 * The ONLY place a Phaser.Game is constructed: the editor's canvas. The game
 * you are making runs somewhere else — in its own page, from its own server.
 */
export function PhaserHost({ store, bridge }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: "#181b1e", // --color-bg under the 2% canvas wash
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
      physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
      audio: { noAudio: true },
      banner: false,
    });

    // Registered by hand rather than through `scene:` so EditorScene can never
    // auto-boot without its init data.
    game.scene.add("EditorScene", EditorScene, true, { store, bridge });
    gameRef.current = game;

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
    // The scene reads further changes straight from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="phaser-host" ref={containerRef} />;
}
