import { useState } from "react";
import { platform } from "../platform";
import { useEditor } from "./context";
import { MosaicMark } from "./Logo";
import { trustRoot } from "../scripts/trust";

/**
 * A Phaser game Mosaic has opened and not yet laid anything out in.
 *
 * One action: import every scene. Picking scenes one at a time, then an entry
 * file, then a scene again in a review, was five decisions with an obvious
 * answer each.
 *
 * The one real decision is the user's code. Using a layout means editing the
 * class, and Mosaic does that only after a warning that names every file it
 * will change — or imports and leaves the classes alone. There is no
 * canvas yet because there is no scene yet — showing a starter scene here is
 * what this replaced.
 */
export function AdoptScreen() {
  const { store, workspace } = useEditor();
  const [busy, setBusy] = useState<"import" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = workspace.adoption;
  const scenes = workspace.gameScenes;
  const loading = !workspace.scripts.index.files.length;
  const paths = store.project.config.paths;
  const files = [...new Set(scenes.map((s) => s.src))];
  const art = store.project.assets.length;

  // One action for the whole game. Pressing it is the consent to run the
  // game's code once — the same trust RUN asks for, remembered per folder.
  const importAll = async (wire: boolean) => {
    const root = workspace.location?.root;
    if (!root) return;
    setConfirming(false);
    setBusy("import");
    setError(null);
    try {
      trustRoot(root);
      await workspace.importAll({ wire });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="launcher">
      <div className="launcher-window blueprint adopt">
        <i className="corner tl" />
        <i className="corner tr" />
        <i className="corner bl" />
        <i className="corner br" />

        <div className="launcher-main">
          <div className="launcher-lockup">
            <MosaicMark size={42} title="Mosaic" />
            <div>
              <div className="wordmark" style={{ fontSize: 28 }}>
                {store.project.name}
              </div>
              {existing?.phaser && (
                <div className="descriptor">PHASER {existing.phaser.replace(/^[\^~]/, "")}</div>
              )}
            </div>
          </div>

          {!confirming && (
          <>
          <div className="kv-list">
            <div className="kv">
              <span>Art</span>
              {art ? (
                <>
                  <code>{paths.assets}/</code>
                  <span className="muted">
                    {art} file(s)
                    {paths.publicDir ? ` · loaded relative to ${paths.publicDir}/` : ""}
                  </span>
                </>
              ) : (
                <span className="muted">none in this folder</span>
              )}
            </div>
            <div className="kv">
              <span>Canvas</span>
              <code>
                {store.project.config.canvas.width} × {store.project.config.canvas.height}
              </code>
            </div>
            {existing?.entries[0] && (
              <div className="kv">
                <span>Starts at</span>
                <code>{existing.entries[0]}</code>
              </div>
            )}
          </div>
          </>
          )}

          <div className="launcher-spacer" />
          {error && <div className="banner error">{error}</div>}
          {confirming ? (
            <CodeWarning
              files={files}
              dirty={files.filter((f) => workspace.git[f])}
              onWire={() => void importAll(true)}
              onLeave={() => void importAll(false)}
              onCancel={() => setConfirming(false)}
            />
          ) : (
          <div className="launcher-actions">
            {platform.canImportPhaser ? (
              <button
                className="primary block"
                disabled={!!busy || loading || !scenes.length}
                onClick={() => setConfirming(true)}
              >
                {busy === "import"
                  ? `Running the game and importing ${scenes.length} scene${scenes.length === 1 ? "" : "s"}…`
                  : `Import all ${scenes.length} scene${scenes.length === 1 ? "" : "s"}`}
              </button>
            ) : null}
            <button className="ghost block" disabled={!!busy} onClick={() => workspace.close()}>
              Close folder
            </button>
          </div>
          )}
        </div>

        <div className="launcher-recents">
          <div className="section-title">Scenes in this game</div>
          <div className="recent-list">
            {loading && <div className="empty">Reading the game's source…</div>}
            {!loading && scenes.length === 0 && (
              <div className="empty">
                No class here extends <code>Phaser.Scene</code>.
              </div>
            )}
            {scenes.map((scene) => (
              <div key={`${scene.src}::${scene.name}`} className="recent-card adopt-scene">
                <div className="recent-open static">
                  <span className="recent-head">
                    <span className="recent-name">{scene.name}</span>
                    {scene.key && scene.key !== scene.name && (
                      <span className="recent-when">key “{scene.key}”</span>
                    )}
                  </span>
                  <span className="recent-path">
                    {scene.src}:{scene.line}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The warning before Mosaic edits code it did not write. It names every file,
 * says exactly what changes in each, and offers the import without the edits
 * as an equal choice.
 */
function CodeWarning({
  files,
  dirty,
  onWire,
  onLeave,
  onCancel,
}: {
  files: string[];
  dirty: string[];
  onWire: () => void;
  onLeave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="code-warning">
      <div className="banner warn">
        <strong>Mosaic will change your code.</strong> {files.length === 1 ? "This file" : `These ${files.length} files`} will be edited:
      </div>
      <div className="file-tree">
        {files.map((f) => (
          <div key={f} className="file-row">
            <span className="sign">~</span>
            {f}
            {dirty.includes(f) && <span className="muted"> — has uncommitted changes</span>}
          </div>
        ))}
      </div>
      <ul className="hint warning-list">
        <li>
          Each class calls its layout, and <code>this.add.image(…)</code> lines for objects the layout now
          builds become <code>layout.name</code>.
        </li>
        <li>This can&rsquo;t be undone from Mosaic. Commit or back up first.</li>
      </ul>
      <div className="launcher-actions">
        <button className="primary block" onClick={onWire}>
          Import and update my code
        </button>
        <button className="ghost block" onClick={onLeave}>
          Import without changing code
        </button>
        <button className="ghost block" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
