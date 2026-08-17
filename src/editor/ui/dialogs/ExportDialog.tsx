import { useEffect, useMemo, useState } from "react";
import { generateFiles, type ExportTarget } from "../../export/generate";
import {
  canWriteToDisk,
  chooseFolder,
  connectedFolder,
  diffFiles,
  downloadText,
  writeFiles,
  type FileDiff,
  type WriteResult,
} from "../../export/write";
import { Dialog } from "./Dialog";
import { useEditor, useStoreVersion } from "../context";

const TARGETS: { id: ExportTarget; label: string; blurb: string }[] = [
  { id: "sceneJson", label: "Scene JSON", blurb: "The format the editor and the game both read." },
  { id: "tsSceneClass", label: "TypeScript Scene class", blurb: "preload() + create(), meant to be read in review." },
  { id: "both", label: "Both", blurb: "JSON for data, a class for behaviour." },
];

/**
 * Export targets scene JSON, a typed Scene class, or both. Generated code is
 * meant to be read in review, so the preview is the whole file, and writing
 * shows a diff before it touches anything.
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditor();
  const [target, setTarget] = useState<ExportTarget>("both");
  const [active, setActive] = useState(0);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [folder, setFolder] = useState<string | null>(connectedFolder());
  const [busy, setBusy] = useState(false);

  const version = useStoreVersion(store);
  const scene = store.scene;
  // `version` is the dependency that matters: the store mutates in place, so
  // the project/scene object identities do not change on edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const files = useMemo(() => (scene ? generateFiles(store.project, scene, target) : []), [
    store,
    scene,
    target,
    version,
  ]);

  useEffect(() => {
    let cancelled = false;
    void diffFiles(files).then((d) => {
      if (!cancelled) setDiffs(d);
    });
    return () => {
      cancelled = true;
    };
  }, [files]);

  // Watch: every save re-emits, so a running dev server stays in step.
  useEffect(() => {
    if (!store.ui.watchExport || !folder) return;
    let last = "";
    const timer = window.setInterval(() => {
      const signature = JSON.stringify(files.map((f) => f.contents.length));
      if (signature === last) return;
      last = signature;
      void diffFiles(files).then((d) => writeFiles(d));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [store.ui.watchExport, folder, files]);

  const current = diffs[active] ?? null;
  const issues = store.validate().filter((i) => i.level === "error");

  const doWrite = async (force = false) => {
    setBusy(true);
    try {
      const fresh = await diffFiles(files);
      const res = await writeFiles(fresh, { force });
      setResult(res);
      setDiffs(await diffFiles(files));
      store.markSaved();
      store.setStatus(
        res.mode === "disk"
          ? `Wrote ${res.written.length} file(s) to ${folder}`
          : `Downloaded ${res.written.length} file(s)`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Export to Phaser"
      subtitle="The generator is pure: the same scene in produces the same bytes out."
      onClose={onClose}
      wide
      footer={
        <>
          <label className="field check inline">
            <input
              type="checkbox"
              checked={store.ui.watchExport}
              onChange={(e) => store.setUi({ watchExport: e.target.checked })}
            />
            <span className="field-label">Watch — re-emit on every change (250ms debounce)</span>
          </label>
          <div className="toolbar-spacer" />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          {canWriteToDisk() && (
            <button
              className="ghost"
              onClick={async () => setFolder(await chooseFolder())}
              title="Grant the editor write access to your real source tree"
            >
              {folder ? `Folder: ${folder}` : "Choose folder…"}
            </button>
          )}
          <button className="primary" disabled={busy} onClick={() => void doWrite(false)}>
            Write {diffs.filter((d) => d.status !== "unchanged").length} file(s)
          </button>
        </>
      }
    >
      <div className="segmented">
        {TARGETS.map((t) => (
          <button key={t.id} className={target === t.id ? "active" : ""} onClick={() => setTarget(t.id)} title={t.blurb}>
            {t.label}
          </button>
        ))}
      </div>

      {issues.length > 0 && (
        <div className="banner error">
          {issues.length} validation error(s) — export will still write, but the game will not run
          clean: {issues[0].message}
        </div>
      )}

      {!canWriteToDisk() && (
        <div className="banner">
          This browser has no File System Access API, so Write downloads the files instead of
          writing them into the source tree.
        </div>
      )}

      <div className="export-layout">
        <div className="export-files">
          {diffs.map((diff, i) => (
            <button
              key={diff.path}
              className={`export-file ${i === active ? "active" : ""} ${diff.status}`}
              onClick={() => setActive(i)}
            >
              <span className="path">{diff.path}</span>
              <span className="status">
                {diff.status}
                {diff.status !== "unchanged" && ` +${diff.addedLines}/-${diff.removedLines}`}
              </span>
            </button>
          ))}
        </div>

        <div className="export-preview">
          {current ? (
            <>
              <div className="preview-head">
                <code>{current.path}</code>
                <span>
                  {current.status === "conflict"
                    ? "refuses to clobber — this file has edits outside a // <keep> region"
                    : `${current.contents.split("\n").length} lines`}
                </span>
                <button className="mini" onClick={() => downloadText(current.path.split("/").pop()!, current.contents)}>
                  download
                </button>
              </div>
              <pre>{current.contents}</pre>
            </>
          ) : (
            <div className="empty">Nothing to export.</div>
          )}
        </div>
      </div>

      {result && (
        <div className="banner">
          {result.written.length} written, {result.skipped.length} unchanged (skipped)
          {result.refused.length > 0 && (
            <>
              , <strong>{result.refused.length} refused</strong> — {result.refused.join(", ")}{" "}
              <button className="mini" onClick={() => void doWrite(true)}>
                overwrite anyway
              </button>
            </>
          )}
        </div>
      )}

      <p className="hint">
        Export changes nothing in the scene: the editor and the generated code both read the same
        scene.json, so there is no round-trip import to lose data in.
      </p>
    </Dialog>
  );
}
