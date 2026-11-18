import { trustRoot } from "../../scripts/trust";
import { useEditor } from "../context";
import { Dialog } from "./Dialog";

/**
 * The one moment Mosaic asks to run someone else's code.
 *
 * Everywhere else the editor reads source. RUN executes it: it starts the
 * project's dev server, which is `npm run dev` with everything that implies.
 * For your own project that is trust you already extend every day — for a
 * folder you were sent, it is not. So it is asked once per project, and the
 * answer is remembered by the editor, never by the project, where the project
 * could grant it to itself.
 */
export function ScriptTrustDialog({ onClose }: { onClose: () => void }) {
  const { workspace, playtest } = useEditor();
  const root = workspace.location?.root ?? "";

  const trustAndRun = () => {
    trustRoot(root);
    onClose();
    void playtest.start();
  };

  return (
    <Dialog
      title="Run this project's game?"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={trustAndRun}>
            Trust and run
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="kv">
          <span>Project</span>
          <code>{root}</code>
        </div>

        <div className="banner warn">
          This runs the project's own code with your user's permissions. Only run projects you
          trust.
        </div>
      </div>
    </Dialog>
  );
}
