import { trustRoot } from "../../scripts/runtime";
import { useEditor } from "../context";
import { Dialog } from "./Dialog";

/**
 * The one moment Mosaic asks to run someone else's code.
 *
 * Everywhere else the editor reads source. RUN executes it: on a project
 * folder it starts the project's dev server, which is `npm run dev` with
 * everything that implies. For your own project that is trust you already
 * extend every day — for a folder you were sent, it is not. So it is asked
 * once per project, and the answer is remembered by the editor, never by the
 * project, where the project could grant it to itself.
 */
export function ScriptTrustDialog({ onClose }: { onClose: () => void }) {
  const { store, workspace, playtest } = useEditor();
  const root = workspace.location?.root ?? "";
  const game = playtest.runsGame;

  const scripted = store.scene?.objects.filter((o) => store.scriptsFor(o).length > 0) ?? [];
  const classes = new Set(
    scripted.flatMap((o) => store.scriptsFor(o).map((s) => `${s.class} · ${s.src}`)),
  );

  const trustAndRun = () => {
    trustRoot(root);
    onClose();
    if (game) void playtest.startGame();
    else playtest.start();
  };

  const previewOnly = () => {
    onClose();
    playtest.start();
  };

  return (
    <Dialog
      title={game ? "Run this project's game?" : "Run this project's scripts?"}
      subtitle={
        game
          ? "RUN starts the project's own dev server and shows the game beside the canvas."
          : "The preview compiles the project's classes and runs them in the editor."
      }
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={previewOnly}>
            {game ? "Preview the layout only" : "Play without scripts"}
          </button>
          <button className="primary" onClick={trustAndRun}>
            {game ? "Trust and run" : "Compile and run scripts"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="kv">
          <span>Project</span>
          <code>{root}</code>
        </div>

        {game ? (
          <>
            <div className="section-title">What happens</div>
            <p className="muted">
              Mosaic runs the <code>dev</code> script from this folder's <code>package.json</code>,
              the same as typing <code>npm run dev</code> in a terminal, and shows the page it
              serves. From then on each save reloads it.
            </p>
          </>
        ) : (
          <>
            <div className="section-title">What would run</div>
            <div className="chips">
              {[...classes].map((label) => (
                <span key={label} className="chip">
                  {label}
                </span>
              ))}
            </div>
          </>
        )}

        <div className="banner warn">
          This is the project's own code, run from the folder above with your user's permissions.
          Say yes only for projects you trust. The answer is remembered per folder, by the editor.
        </div>

        <div className="hint">
          {game
            ? "The layout preview needs no code at all: it builds the scene from its data, in the editor's own canvas."
            : "Playing without scripts still runs the scene: objects, bodies, animations and the collision matrix are scene data, and none of them need your code."}
        </div>
      </div>
    </Dialog>
  );
}
