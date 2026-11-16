import { useEffect, useState } from "react";
import { useEditor } from "../context";
import { Dialog } from "./Dialog";
import { isTrusted, trustRoot } from "../../scripts/trust";
import {
  applyImport,
  findEntries,
  previewScene,
  surveyProject,
  writeImportedArt,
  type ImportSurvey,
} from "../../import/importPhaser";
import type { ImportResult } from "../../import/fromRecording";

/**
 * Importing a scene out of a hand-written Phaser project.
 *
 * The flow is four steps because each one is a real question with no safe
 * default: which file starts the game, may we run it, which of its scenes did
 * you mean, and is this what you wanted. The last of those is the important
 * one — an import is a guess made by running somebody's code, and it is shown
 * in full before anything is added.
 */
type Step = "entry" | "trust" | "scene" | "review";

export function ImportPhaserDialog({ onClose }: { onClose: () => void }) {
  const { store, workspace } = useEditor();
  const root = workspace.location?.root ?? "";

  const [step, setStep] = useState<Step>("entry");
  const [entries, setEntries] = useState<string[] | null>(null);
  const [entry, setEntry] = useState<string>("");
  const [survey, setSurvey] = useState<ImportSurvey | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void findEntries(root).then((found) => {
      if (!live) return;
      setEntries(found);
      if (found.length) setEntry(found[0]);
    });
    return () => {
      live = false;
    };
  }, [root]);

  const record = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await surveyProject(root, entry, workspace.scripts);
      if (!result.candidates.length) {
        setError("The game ran, but none of its scenes had anything on the display list.");
        setStep("entry");
        return;
      }
      setSurvey(result);
      const first = result.candidates[0].key;
      setPreview(previewScene(result, first));
      setStep("scene");
    } catch (err) {
      setError((err as Error).message);
      setStep("entry");
    } finally {
      setBusy(false);
    }
  };

  const go = () => {
    if (!entry) return;
    // Recording runs the project's code, so trust is asked before anything is
    // compiled — not after, and not silently on the strength of a folder being
    // open.
    if (!isTrusted(root)) setStep("trust");
    else void record();
  };

  const pickScene = (key: string) => {
    if (!survey) return;
    setPreview(previewScene(survey, key));
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    let notes: string[] = [];
    store.transact("import Phaser scene", () => {
      notes = applyImport(store.project, preview);
    });
    // The art lands on disk before the scene is shown, so the canvas has
    // something to draw the moment it opens rather than a frame of nothing.
    const written = await writeImportedArt(root, preview, store.project);
    store.activateScene(store.project.scenes[store.project.scenes.length - 1].key);
    // Then the project itself. Importing IS the moment this folder becomes a
    // Mosaic project, so it is saved like any other explicit save — and it has
    // to be: writing the art trips the folder watcher, and a reload would drop
    // an imported scene that only ever existed in memory.
    await workspace.saveNow();
    store.setStatus(
      `Imported ${preview.scene.objects.length} object(s) from ${entry} · ${[...written, ...notes].length} note(s)`,
    );
    setBusy(false);
    onClose();
  };

  // ---- step: which file starts the game ---------------------------------
  if (step === "entry") {
    return (
      <Dialog
        title="Import a scene from this Phaser project"
        subtitle="Mosaic runs the game once and imports what its scene actually builds."
        onClose={onClose}
        footer={
          <>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={!entry || busy} onClick={go}>
              {busy ? "Running…" : "Continue"}
            </button>
          </>
        }
      >
        <div className="stack">
          {error && <div className="banner danger">{error}</div>}
          <div className="section-title">Entry point</div>
          {entries === null && <p className="muted">Looking for a file that starts a game…</p>}
          {entries?.length === 0 && (
            <p className="muted">
              Nothing here constructs a <code>Phaser.Game</code>. Mosaic needs the file that starts
              the game to know where to begin.
            </p>
          )}
          {entries?.map((rel) => (
            <label key={rel} className="check-row">
              <input
                type="radio"
                name="entry"
                checked={entry === rel}
                onChange={() => setEntry(rel)}
              />
              <code>{rel}</code>
            </label>
          ))}
          <p className="muted">
            Only objects the scene builds in <code>create()</code> can be imported. Anything spawned
            later — on a timer, on input, in <code>update()</code> — does not exist yet when the
            import is taken.
          </p>
        </div>
      </Dialog>
    );
  }

  // ---- step: may we run it ----------------------------------------------
  if (step === "trust") {
    return (
      <Dialog
        title="Run this project to import it?"
        subtitle="There is no way to read a hand-written create() without running it."
        onClose={onClose}
        footer={
          <>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={() => {
                trustRoot(root);
                void record();
              }}
            >
              Run and import
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
            <code>{entry}</code>
          </div>
          <p className="muted">
            The game is compiled and run once, in a separate hidden window that is closed
            afterwards, and is stopped if it takes too long. Recording writes nothing — only
            pressing Import does, and it says what first. The answer is remembered by the editor for
            this folder, the same trust RUN asks for.
          </p>
        </div>
      </Dialog>
    );
  }

  // ---- steps: which scene, and what would come in ------------------------
  const chosen = preview?.scene.key ?? "";
  return (
    <Dialog
      wide
      title="Review the import"
      subtitle={`Recorded from ${entry}`}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!preview || busy} onClick={() => void confirm()}>
            {busy ? "Importing…" : "Import scene"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="section-title">Scene</div>
        <div className="chips">
          {survey?.candidates.map((c) => (
            <button
              key={c.key}
              className={`chip ${c.key === chosen || c.key === preview?.scene.name ? "on" : ""}`}
              onClick={() => pickScene(c.key)}
            >
              {c.key} · {c.objects} object{c.objects === 1 ? "" : "s"}
            </button>
          ))}
        </div>

        {preview && (
          <>
            {preview.prefabCandidates.length > 0 && (
              <>
                <div className="section-title">The project's own classes</div>
                <div className="chips">
                  {preview.prefabCandidates.map((c) => (
                    <span
                      key={c.className}
                      className={`chip ${c.bound ? "on" : ""}`}
                      title={
                        c.bound
                          ? `Bound to ${c.bound.module} — the exported scene constructs the real class`
                          : c.blockedBy
                            ? `Not bound: its constructor takes ${c.blockedBy.join(", ")}`
                            : "Not found in this project's source"
                      }
                    >
                      {c.className} × {c.count}
                      {c.bound ? " · bound" : ""}
                    </span>
                  ))}
                </div>
              </>
            )}

            <div className="section-title">
              {preview.scene.objects.length} object(s), {preview.anims.length} animation(s),{" "}
              {preview.assets.length} asset(s)
              {preview.files.length > 0 &&
                ` · ${preview.files.length} art file(s) will be written to assets/imported/`}
            </div>
            <div className="file-tree">
              {preview.scene.objects.map((o) => (
                <div key={o.id} className="file-row">
                  <span className="sign">+</span>
                  {o.name}
                  <span className="note">
                    {o.type}
                    {o.texture ? ` · ${o.texture}` : ""}
                    {o.frame ? `/${o.frame}` : ""}
                  </span>
                </div>
              ))}
            </div>

            {preview.issues.length > 0 && (
              <>
                <div className="section-title">What did not come across</div>
                {preview.issues.map((issue) => (
                  <div key={issue} className="check-row warn">
                    <span className="mark">!</span>
                    {issue}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
