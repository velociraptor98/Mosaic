import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { platform } from "../platform";
import { useEditor, useStoreVersion } from "./context";

/**
 * The project's own game, beside the canvas.
 *
 * It is a page from the project's dev server, not a scene the editor built —
 * so what plays here is what `npm run dev` plays, because it is the same
 * server. A folder with no dev server is served as it is, the way Phaser's
 * examples site serves its games. The canvas next to it stays editable: a save rewrites the layout
 * files, and the dev server reloads this with them.
 */
export function GamePane() {
  const { playtest, store, workspace } = useEditor();
  useSyncExternalStore(playtest.subscribe, playtest.getRevision);
  useStoreVersion(store);
  const [wide, setWide] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  const game = playtest.run;
  const url = playtest.url();

  // Keys belong to the game the moment it appears: nobody should have to
  // click a canvas before the arrow keys do anything.
  useEffect(() => {
    if (game?.status === "running") frame.current?.focus();
  }, [game?.status, game?.nonce, url]);

  if (!game) return null;

  const install = () => {
    workspace.markInstalling();
    void platform.install(game.root);
    playtest.stop();
    store.setStatus("Running npm install — press RUN again when it finishes");
  };

  return (
    <aside className={`game-pane ${wide ? "wide" : ""}`}>
      <header>
        <span className={`game-dot ${game.status}`} />
        <span className="game-title">
          {game.status === "starting" && "Starting the game…"}
          {game.status === "running" && (url ?? "")}
          {game.status === "failed" && "The game did not start"}
        </span>
        <div className="toolbar-spacer" />
        {game.status === "running" && (
          <>
            <button className="mini" onClick={() => playtest.reload()} title="Reload the page">
              ↻
            </button>
            <button
              className="mini"
              onClick={() => url && window.open(url, "_blank")}
              title="Open in your browser, with its devtools"
            >
              ↗
            </button>
          </>
        )}
        <button className="mini" onClick={() => setShowLog((v) => !v)} title="What the dev server printed">
          log
        </button>
        <button
          className="mini"
          onClick={() => setWide((v) => !v)}
          title={wide ? "Show the canvas beside the game" : "Give the game the whole stage"}
        >
          {wide ? "◧" : "▣"}
        </button>
        <button className="mini" onClick={() => playtest.stop()} title="Close the game">
          ✕
        </button>
      </header>

      {game.status === "running" && url && (
        <iframe
          ref={frame}
          key={`${url}#${game.nonce}`}
          src={url}
          title="The game"
          allow="autoplay; fullscreen; gamepad"
        />
      )}

      {game.status === "starting" && (
        <div className="game-message">
          <p>
            Running the project's dev script, or serving the folder as it is when it has none. The
            first start takes a few seconds; after that the server stays up and RUN is immediate.
          </p>
        </div>
      )}

      {game.status === "failed" && (
        <div className="game-message">
          <p>{game.error}</p>
          {game.code === "not-installed" && (
            <button className="primary" onClick={install}>
              Run npm install
            </button>
          )}
          {game.code !== "not-installed" && (
            <button className="primary" onClick={() => void playtest.start()}>
              Try again
            </button>
          )}
        </div>
      )}

      {(showLog || game.status === "failed") && game.log.trim() && (
        <pre className="game-log">{game.log.trim()}</pre>
      )}
    </aside>
  );
}
