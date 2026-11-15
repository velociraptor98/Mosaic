import { useMemo, useState } from "react";
import { platform } from "../../platform";
import type { PackageResult } from "../../platform/types";
import { Dialog } from "./Dialog";
import { useEditor, useStoreVersion } from "../context";

/**
 * Export game… — the build, not the source.
 *
 * Saving writes code for a developer to read and a bundler to compile.
 * This writes the thing you send someone: one folder, index.html first, no
 * install. It exists because "the game is finished" used to be the point where
 * Mosaic handed you back to a terminal.
 *
 * Everything it can tell you before it runs, it tells you before it runs: which
 * entry it will compile, which Phaser it will link, and exactly which folder it
 * is about to overwrite.
 */
export function PackageDialog({ onClose }: { onClose: () => void }) {
  const { store, workspace } = useEditor();
  useStoreVersion(store);

  const root = workspace.location?.root ?? "";
  const entries = workspace.gameEntries;
  const [entry, setEntry] = useState(entries[0] ?? "src/main.ts");
  const [outDir, setOutDir] = useState("build/web");
  const [minify, setMinify] = useState(true);
  const [copyAssets, setCopyAssets] = useState(true);
  const [zip, setZip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PackageResult | null>(null);

  const assetsDir = store.project.config.paths.assets;
  const scene = store.scene;
  const issues = useMemo(() => store.validate().filter((i) => i.level === "error"), [store]);
  const unsaved = workspace.isOpen && store.isDirty(store.docKey);

  const build = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await platform.packageGame({
        root,
        entry,
        outDir,
        assetsDir,
        minify,
        copyAssets,
        zip,
        title: store.project.name,
        background: scene?.settings.backgroundColor ?? "#000000",
      });
      setResult(res);
      store.setStatus(
        res.ok
          ? `Built ${outDir} — ${bytes(res.totalBytes)} in ${res.ms}ms`
          : `Build failed — ${res.error}`,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!platform.canPackage) {
    return (
      <Dialog title="Export game" subtitle="Not available in the browser build." onClose={onClose}>
        <p className="muted">
          Packaging writes a folder to disk and compiles the project's own source, so it needs the
          desktop app.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Export game"
      subtitle="One folder that runs on its own — no install, no bundler, no terminal."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            {result?.ok ? "Done" : "Cancel"}
          </button>
          {result?.ok && (
            <button className="ghost" onClick={() => workspace.reveal(outDir)}>
              Reveal build
            </button>
          )}
          <button className="primary" disabled={busy || !root} onClick={() => void build()}>
            {busy ? "Building…" : result ? "Build again" : "Build"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="kv">
          <span>Project</span>
          <code>{root || "no folder open"}</code>
        </div>

        <label className="kv">
          <span>Entry</span>
          {entries.length > 1 ? (
            <select value={entry} onChange={(e) => setEntry(e.target.value)}>
              {entries.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          ) : (
            <input value={entry} onChange={(e) => setEntry(e.target.value)} spellCheck={false} />
          )}
        </label>

        <label className="kv">
          <span>Output</span>
          <input value={outDir} onChange={(e) => setOutDir(e.target.value)} spellCheck={false} />
        </label>

        <div className="row">
          <label className="check">
            <input type="checkbox" checked={minify} onChange={(e) => setMinify(e.target.checked)} />
            Minify
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={copyAssets}
              onChange={(e) => setCopyAssets(e.target.checked)}
            />
            Copy {assetsDir}/
          </label>
          <label className="check">
            <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} />
            Zip when done
          </label>
        </div>

        {(issues.length > 0 || unsaved) && (
          <>
            <div className="section-title">Before you build</div>
            {unsaved && (
              <div className="check-row warn">
                <span className="mark">!</span>
                This scene has edits that are not on disk yet. The build compiles the FILES, so save
                first (⌘S) or the build will be one edit behind.
              </div>
            )}
            {issues.map((issue, i) => (
              <div className="check-row warn" key={i}>
                <span className="mark">!</span>
                {issue.message}
              </div>
            ))}
          </>
        )}

        {!result && (
          <>
            <div className="section-title">What gets written</div>
            <p className="muted">
              <code>index.html</code>, one <code>game.js</code> with Phaser linked into it, and a
              copy of <code>{assetsDir}/</code>. The page loads a plain script rather than a module,
              so the folder opens from a file path as readily as from a web host.
            </p>
            <p className="muted">
              Mosaic uses the project's own Phaser when it has one, and its own copy when the
              project has never had <code>npm install</code> run in it — which is what lets this
              work on a folder that has only ever been opened in the editor.
            </p>
            <div className="check-row warn">
              <span className="mark">!</span>
              <span>
                <code>{outDir}</code> is rebuilt from scratch each time. Mosaic refuses to clear a
                folder it did not write, so point this somewhere of its own.
              </span>
            </div>
          </>
        )}

        {result && !result.ok && (
          <>
            <div className="section-title">Build failed</div>
            <pre className="build-error">{result.error}</pre>
          </>
        )}

        {result?.ok && (
          <>
            <div className="section-title">
              Built in {result.ms}ms — {bytes(result.totalBytes)}
            </div>
            <div className="kv">
              <span>Folder</span>
              <code>{result.outDir}</code>
            </div>
            {result.zipPath && (
              <div className="kv">
                <span>Archive</span>
                <code>{result.zipPath}</code>
              </div>
            )}
            {result.phaser && (
              <div className="kv">
                <span>Phaser</span>
                <code>
                  {result.phaser.version} ({result.phaser.source === "project" ? "the project's own" : "Mosaic's copy"})
                </code>
              </div>
            )}

            <div className="build-files">
              {result.files.slice(0, 12).map((f) => (
                <div className="build-file" key={f.rel}>
                  <code>{f.rel}</code>
                  <span className="build-size">{bytes(f.bytes)}</span>
                </div>
              ))}
              {result.files.length > 12 && (
                <div className="build-file muted">
                  <code>+{result.files.length - 12} more</code>
                  <span className="build-size" />
                </div>
              )}
            </div>

            {result.warnings.map((w, i) => (
              <div className="check-row warn" key={i}>
                <span className="mark">!</span>
                {w}
              </div>
            ))}
          </>
        )}
      </div>
    </Dialog>
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
