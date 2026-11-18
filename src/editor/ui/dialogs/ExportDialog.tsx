import { useEffect, useMemo, useState } from "react";
import { generateSceneFiles } from "../../export/generate";
import {
  canWriteToDisk,
  chooseFolder,
  connectedFolder,
  diffFiles,
  downloadText,
  writeFiles,
  writesGoToProject,
  type FileDiff,
  type WriteResult,
} from "../../export/write";
import { Dialog } from "./Dialog";
import { useEditor, useStoreVersion } from "../context";

const STATUS_LABEL: Record<FileDiff["status"], string> = {
  new: "will be written",
  changed: "changes on save",
  unchanged: "in step",
  kept: "not touched",
};

/**
 * What Mosaic writes for the scene you are looking at.
 *
 * On desktop this is a window onto something that already happened: saving
 * writes these files, so there is no export to run. It is here so the code is
 * never a mystery — every file, whose it is, and what it currently says.
 *
 * The browser build has no folder to save into, so here it also offers to
 * write them to one you pick, or to download them.
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { store, workspace } = useEditor();
  const [active, setActive] = useState(0);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [folder, setFolder] = useState<string | null>(connectedFolder());
  const [busy, setBusy] = useState(false);

  const version = useStoreVersion(store);
  const scene = store.scene;
  const language = workspace.language;
  // `version` is the dependency that matters: the store mutates in place, so
  // the project/scene object identities do not change on edit.
  const files = useMemo(
    () => (scene ? generateSceneFiles(store.project, scene, { language }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scene, language, version],
  );

  useEffect(() => {
    let cancelled = false;
    void diffFiles(files).then((d) => {
      if (!cancelled) setDiffs(d);
    });
    return () => {
      cancelled = true;
    };
  }, [files, workspace.lastSavedAt]);

  const current = diffs[active] ?? null;
  const issues = store.validate().filter((i) => i.level === "error");
  const live = writesGoToProject();

  const doWrite = async () => {
    setBusy(true);
    try {
      const res = await writeFiles(await diffFiles(files));
      setResult(res);
      setDiffs(await diffFiles(files));
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
      title="Generated code"
      onClose={onClose}
      wide
      footer={
        <>
          <div className="toolbar-spacer" />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          {!live && canWriteToDisk() && (
            <button
              className="ghost"
              onClick={async () => setFolder(await chooseFolder())}
              title="Grant the editor write access to your real source tree"
            >
              {folder ? `Folder: ${folder}` : "Choose folder…"}
            </button>
          )}
          {!live && (
            <button className="primary" disabled={busy} onClick={() => void doWrite()}>
              Write {diffs.filter((d) => d.status === "new" || d.status === "changed").length} file(s)
            </button>
          )}
        </>
      }
    >
      {issues.length > 0 && (
        <div className="banner error">
          {issues.length} validation error(s) — the layout is still written, but the game will not
          run clean: {issues[0].message}
        </div>
      )}

      {live ? (
        <div className="banner">
          Nothing to export: saving writes these into <code>{folder}</code>, so a running dev server
          picks each change up as you make it.
        </div>
      ) : (
        !canWriteToDisk() && (
          <div className="banner">
            This browser has no File System Access API, so Write downloads the files instead of
            writing them into a source tree.
          </div>
        )
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
                {diff.owner === "generated" ? "generated" : "yours"} · {STATUS_LABEL[diff.status]}
                {(diff.status === "changed" || diff.status === "new") &&
                  ` +${diff.addedLines}/-${diff.removedLines}`}
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
                  {current.owner === "yours"
                    ? current.status === "kept"
                      ? "as it is on disk — Mosaic wrote the first version and has not opened it since"
                      : "a starting point, written once"
                    : `${current.contents.split("\n").length} lines, regenerated`}
                </span>
                <button className="mini" onClick={() => downloadText(current.path.split("/").pop()!, current.contents)}>
                  download
                </button>
              </div>
              <pre>{current.contents}</pre>
            </>
          ) : (
            <div className="empty">Nothing generated for this scene.</div>
          )}
        </div>
      </div>

      {result && (
        <div className="banner">
          {result.written.length} written, {result.skipped.length} left alone
          {result.failed.length > 0 && (
            <>
              , <strong>{result.failed.length} failed</strong> — {result.failed.join(", ")}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
