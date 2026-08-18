import { trustRoot } from "../../scripts/runtime";
import { useEditor } from "../context";
import { Dialog } from "./Dialog";

/**
 * The one moment Mosaic asks to run someone else's code.
 *
 * Everywhere else the editor reads source; pressing RUN on a scene with
 * behaviour compiles the project and executes it in the editor's own process.
 * For your own project that is the trust you already extend to your dev
 * server — for a folder you were sent, it is not. So it is asked once per
 * project, and the answer is remembered by the editor, never by the project.
 */
export function ScriptTrustDialog({ onClose }: { onClose: () => void }) {
  const { store, workspace, playtest } = useEditor();
  const root = workspace.location?.root ?? "";

  const scripted = store.scene?.objects.filter((o) => store.scriptsFor(o).length > 0) ?? [];
  const classes = new Set(
    scripted.flatMap((o) => store.scriptsFor(o).map((s) => `${s.class} · ${s.src}`)),
  );

  const runWith = () => {
    trustRoot(root);
    onClose();
    playtest.start();
  };

  const runWithout = () => {
    onClose();
    playtest.start();
  };

  return (
    <Dialog
      title="Run this project's scripts?"
      subtitle="Play-test compiles the project's classes and runs them in the editor."
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={runWithout}>
            Play without scripts
          </button>
          <button className="primary" onClick={runWith}>
            Compile and run scripts
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="kv">
          <span>Project</span>
          <code>{root}</code>
        </div>

        <div className="section-title">What would run</div>
        <div className="chips">
          {[...classes].map((label) => (
            <span key={label} className="chip">
              {label}
            </span>
          ))}
        </div>

        <div className="banner warn">
          This is your project's own code, compiled from the folder above and run in Mosaic's
          process — the same trust you give your dev server. Say yes only for projects you trust.
          The answer is remembered per project, by the editor.
        </div>

        <div className="hint">
          Playing without scripts still runs the scene: objects, bodies, animations and the
          collision matrix are scene data, and none of them need your code.
        </div>
      </div>
    </Dialog>
  );
}
