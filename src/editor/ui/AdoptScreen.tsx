import { useState } from "react";
import { platform } from "../platform";
import { adoptedDirs } from "../project/adopt";
import { useEditor } from "./context";
import { MosaicMark } from "./Logo";
import { trustRoot } from "../scripts/trust";

/**
 * A Phaser game Mosaic has opened and not yet laid anything out in.
 *
 * One action: import every scene. Picking scenes one at a time, then an entry
 * file, then a scene again in a review, was five decisions with an obvious
 * answer each. Nothing has been written, and the screen says what will be
 * before the button is pressed: two files per scene, beside the class.
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
  // Where the files will go is decided by where the classes are, so it is
  // shown the same way it will be decided.
  const found = adoptedDirs(scenes)?.scenes;
  const dir = found === undefined ? "<scene folder>" : found === "." ? store.project.name : found;
  // A real class from that folder, with its real file: a class called
  // MainGame in Game.js gets MainGame.scene.json, and the preview says so.
  const sample = scenes.find((s) => (found === "." ? !s.src.includes("/") : s.src.startsWith(`${found}/`)));
  const rows: [string, string][] = sample
    ? [
        [sample.src.split("/").pop()!, "your class"],
        [`${sample.name}.scene.json`, "what the editor edits"],
        [`${sample.name}.layout.${workspace.language}`, "generated on every save"],
      ]
    : [];
  const width = Math.max(0, ...rows.map(([f]) => f.length)) + 3;
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
              <div className="descriptor">
                {existing?.phaser ? `PHASER ${existing.phaser.replace(/^[\^~]/, "")}` : "PHASER GAME"}
                {" · NOTHING WRITTEN YET"}
              </div>
            </div>
          </div>

          {!confirming && (
          <>
          <p className="hint">
            This folder is a Phaser game Mosaic didn&rsquo;t make. Nothing has been written to it.
            Importing gives every scene below a layout, as two files beside its class:
          </p>
          <pre className="code-preview">
            {`${dir}/\n${rows.map(([f, what]) => `  ${f.padEnd(width)}${what}`).join("\n")}`}
          </pre>
          <p className="hint">
            A class uses its layout once it imports it. Mosaic can make that change to each class
            for you — it asks first.
          </p>

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
                <span className="muted">none in this folder — importing brings in what the game loads</span>
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
          {platform.canImportPhaser && (
            <p className="hint">
              Importing runs the game once, in a hidden window that can read only the game&rsquo;s own files, and
              starts each scene&rsquo;s layout from what its <code>create()</code> builds. A scene that
              builds nothing gets an empty layout.
            </p>
          )}
        </div>

        <div className="launcher-recents">
          <div className="section-title">Scenes in this game</div>
          <div className="recent-list">
            {loading && <div className="empty">Reading the game's source…</div>}
            {!loading && scenes.length === 0 && (
              <div className="empty">
                No class here extends <code>Phaser.Scene</code>. Mosaic lays out scenes, so there is
                nothing to pick yet.
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
          <div className="hint mono">your scene classes are changed only if you agree</div>
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
        <strong>Mosaic will change your code.</strong> To use their layouts, {files.length === 1 ? "this file" : `these ${files.length} files`} will be edited:
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
          Each class imports its layout and calls <code>preload…(this)</code> and <code>create…(this)</code>.
        </li>
        <li>
          Each object the layout now builds stops being built by the class: a line like{" "}
          <code>let sign = this.add.image(…)</code> becomes <code>let sign = layout.sign</code>, so tweens,
          handlers and setters on it keep working.
        </li>
        <li>
          Objects made in loops, helpers, callbacks or <code>preload()</code>, and text, stay in your code
          and out of the layout.
        </li>
        <li>Mosaic can&rsquo;t undo changes to code. Commit or back up first.</li>
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
