import { useEditor } from "../context";
import { Dialog } from "./Dialog";
import { isTrusted, trustRoot } from "../../scripts/runtime";

/**
 * Asking before running somebody's game.
 *
 * Running the project's own code is the same question the play-test asks
 * before compiling scripts, and it has to be asked here too — this path used to
 * refuse an untrusted project with a status line and no way to say yes, which
 * looks exactly like the feature not working.
 *
 * It asks for more than the play-test does, so it says more: the project's own
 * update loop runs in the editor, which is a larger thing to agree to than a
 * scene being built from data.
 */
export function RunProjectDialog({ onClose }: { onClose: () => void }) {
  const { workspace, playtest } = useEditor();
  const root = workspace.location?.root ?? "";
  const entry = workspace.gameEntry ?? "";
  const trusted = isTrusted(root);

  const run = () => {
    trustRoot(root);
    onClose();
    void playtest.startProject(entry);
  };

  return (
    <Dialog
      title="Run this project's own game?"
      subtitle="Its scenes, its update loop, its input — not the editor's."
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!entry} onClick={run}>
            {trusted ? "Run the game" : "Trust and run"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="kv">
          <span>Project</span>
          <code>{root}</code>
        </div>
        <div className="kv">
          <span>Entry</span>
          <code>{entry || "none found"}</code>
        </div>

        <div className="section-title">What happens</div>
        <p className="muted">
          Mosaic compiles <code>{entry}</code>, takes the scenes the game was constructed with, and
          runs them on the editor's canvas. The game boots the way it normally does, so you land
          wherever it lands — usually its menu, which you can click.
        </p>
        <p className="muted">
          Your edits appear in it only if the scene's <code>create()</code> calls the builder that
          Export writes. Without that you are seeing the game exactly as it runs without Mosaic,
          which is still a useful thing to look at.
        </p>

        <div className="section-title">Worth knowing</div>
        <div className="check-row warn">
          <span className="mark">!</span>
          The project's <code>update()</code> runs inside the editor, so a loop that never returns
          can lock the canvas. STOP ends the run and gives it back.
        </div>
        {!trusted && (
          <p className="muted">
            This folder has not been trusted to execute its code yet. Answering yes is remembered by
            the editor for this folder — the same trust play-test asks for, never stored in the
            project.
          </p>
        )}
      </div>
    </Dialog>
  );
}
