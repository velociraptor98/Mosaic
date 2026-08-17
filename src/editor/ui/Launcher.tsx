import { useCallback, useEffect, useState } from "react";
import type { RecentEntry } from "../platform/types";
import type { Workspace } from "../project/workspace";
import { MosaicLockup } from "./Logo";

/**
 * The start screen the desktop build opens on. Mosaic works on a folder, so
 * there is no editor to show until one is chosen.
 */
export function Launcher({ workspace }: { workspace: Workspace }) {
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
      const ok = await fn();
      if (!ok) refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="launcher">
      <div className="launcher-panel blueprint">
        <i className="corner tl" />
        <i className="corner tr" />
        <i className="corner bl" />
        <i className="corner br" />

        <div className="launcher-head">
          <MosaicLockup size={52} descriptor />
        </div>

        <div className="launcher-actions">
          <button
            className="primary"
            disabled={!!busy}
            onClick={() => void guard("new", () => workspace.createAndOpen())}
          >
            {busy === "new" ? "Creating…" : "New project…"}
          </button>
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() => void guard("open", () => workspace.pickAndOpen())}
          >
            {busy === "open" ? "Opening…" : "Open folder…"}
          </button>
        </div>

        <p className="hint">
          Mosaic opens a folder, not a file. Scene files in <code>src/scenes</code> are the
          source of truth — edit them here or in your editor, and both sides stay in step.
        </p>

        {error && <div className="banner error">{error}</div>}

        <div className="section-title">Recent</div>
        {recents.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <ul className="recents">
            {recents.map((entry) => (
              <li key={entry.root}>
                <button
                  className="recent"
                  disabled={!!busy}
                  onClick={() => void guard(entry.root, () => workspace.open(entry))}
                >
                  <span className="recent-name">{entry.name}</span>
                  <span className="recent-path">{entry.root}</span>
                </button>
                <button
                  className="mini"
                  title="Remove from this list"
                  onClick={() => void workspace.forget(entry.root).then(refresh)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
