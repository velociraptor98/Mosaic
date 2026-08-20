import { useCallback, useEffect, useState } from "react";
import type { RecentEntry } from "../platform/types";
import type { Workspace } from "../project/workspace";
import { MosaicMark } from "./Logo";

const VERSION = "0.3.1";

/**
 * Screen 1 of the flow: the only window with no project loaded.
 *
 * Recents carry enough metadata — scene count, Phaser version, last opened —
 * to pick the right one without opening it. A folder that has moved or been
 * deleted greys out with a Locate… action; it is never silently dropped.
 */
export function Launcher({
  workspace,
  onNewProject,
}: {
  workspace: Workspace;
  onNewProject: () => void;
}) {
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void workspace.recents().then(setRecents);
  }, [workspace]);

  useEffect(refresh, [refresh]);

  const guard = async (label: string, fn: () => Promise<boolean>) => {
    setBusy(label);
    setError(null);
    try {
      if (!(await fn())) refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="launcher">
      <div className="launcher-window blueprint">
        <i className="corner tl" />
        <i className="corner tr" />
        <i className="corner bl" />
        <i className="corner br" />

        <div className="launcher-main">
          <div className="launcher-lockup">
            <MosaicMark size={58} title="Mosaic" />
            <div>
              <div className="wordmark" style={{ fontSize: 40 }}>
                MOSAIC
              </div>
              <div className="descriptor">SCENE EDITOR FOR PHASER · {VERSION}</div>
            </div>
          </div>

          <div className="launcher-actions">
            <button className="primary block" disabled={!!busy} onClick={onNewProject}>
              New project…
            </button>
            <button
              className="ghost block"
              disabled={!!busy}
              onClick={() => void guard("open", () => workspace.pickAndOpen())}
            >
              {busy === "open" ? "Opening…" : "Open a folder…"}
            </button>
          </div>

          {error && <div className="banner error">{error}</div>}

          <div className="launcher-spacer" />
          <p className="hint">
            Mosaic edits a folder on disk. There is no proprietary project file — scenes, prefabs
            and atlases are plain JSON your repo already understands.
          </p>
        </div>

        <div className="launcher-recents">
          <div className="section-title">Recent</div>
          {/* The list scrolls; the window does not grow. However many folders
              someone has opened, the launcher is the same size. */}
          <div className="recent-list">
            {recents.length === 0 && <div className="empty">Nothing yet.</div>}
            {recents.map((entry) => (
            <div key={entry.root} className={`recent-card ${entry.missing ? "missing" : ""}`}>
              <button
                className="recent-open"
                disabled={!!busy}
                onClick={() =>
                  entry.missing
                    ? void guard(entry.root, () => workspace.pickAndOpen())
                    : void guard(entry.root, () => workspace.open(entry))
                }
                title={entry.missing ? "Folder is missing — locate it" : entry.root}
              >
                <span className="recent-head">
                  <span className="recent-name">{entry.name}</span>
                  <span className="recent-when">{relativeTime(entry.lastOpened)}</span>
                </span>
                <span className="recent-path">{entry.root}</span>
                <span className="recent-tags">
                  {entry.missing ? (
                    <span className="tag-outline warn-tag">missing — Locate…</span>
                  ) : (
                    <>
                      <span className="tag-outline">
                        {entry.scenes ?? 0} scene{entry.scenes === 1 ? "" : "s"}
                      </span>
                      {entry.phaser && <span className="tag-outline">phaser {entry.phaser.replace(/^[\^~]/, "")}</span>}
                    </>
                  )}
                </span>
              </button>
              <button
                className="mini"
                title="Remove from this list"
                onClick={() => void workspace.forget(entry.root).then(refresh)}
              >
                ×
              </button>
            </div>
            ))}
          </div>
          <div className="hint mono">missing folders are greyed, never silently dropped</div>
        </div>
      </div>
    </div>
  );
}

function relativeTime(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days`;
  return `${Math.round(days / 7)} weeks`;
}

export { VERSION };
