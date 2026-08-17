import { useEffect, useMemo, useRef, useState } from "react";
import { searchPalette } from "../../commands";
import { useEditor } from "../context";

/**
 * Everything reachable by menu is reachable by keystroke. Prefixes scope the
 * search: scene:, asset:, prefab:, or > for commands only.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const ctx = useEditor();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => searchPalette(query, ctx), [query, ctx]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setCursor(0), [query]);

  const run = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    onClose();
    entry.run();
  };

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          ref={inputRef}
          value={query}
          placeholder="Command, scene, asset, prefab…   (scene:  asset:  prefab:  >)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, entries.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(cursor);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul>
          {entries.map((entry, i) => (
            <li
              key={entry.id}
              className={i === cursor ? "active" : ""}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                run(i);
              }}
            >
              <span className={`kind ${entry.kind}`}>{entry.kind}</span>
              <span className="title">{entry.title}</span>
              <span className="subtitle">{entry.subtitle}</span>
              {entry.binding && <kbd>{entry.binding}</kbd>}
            </li>
          ))}
          {entries.length === 0 && <li className="empty">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
