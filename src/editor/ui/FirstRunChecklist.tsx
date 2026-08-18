import { useEffect, useMemo, useRef, useState } from "react";
import type { TileLayer } from "../../shared/types";
import { useEditor, useStoreVersion } from "./context";

const KEY = "mosaic:firstrun-dismissed:v1";

function dismissedFor(root: string): boolean {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]).includes(root) : false;
  } catch {
    return false;
  }
}

function dismiss(root: string): void {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    if (!list.includes(root)) list.push(root);
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* dismissal is a convenience, never a hard failure */
  }
}

function tileCount(scene: { layers: { kind: string }[] } | null): number {
  if (!scene) return 0;
  let n = 0;
  for (const layer of scene.layers) {
    if (layer.kind !== "tile") continue;
    for (const row of (layer as TileLayer).data) {
      for (const t of row) if (t >= 0) n += 1;
    }
  }
  return n;
}

/**
 * Screen 7: a five-item checklist tied to the real first actions.
 *
 * Items tick from DOING the thing, not from clicking the list — each is bound
 * to observable state, so it ticks itself if the user gets there before
 * reading it. Dismissal is stored per project and never returns.
 */
export function FirstRunChecklist({ root, installing }: { root: string; installing: boolean }) {
  const { store, bridge } = useEditor();
  useStoreVersion(store);
  const [hidden, setHidden] = useState(() => dismissedFor(root));
  const [ran, setRan] = useState(false);

  // Baseline captured when the project opens, so "painted" means painted SINCE
  // the template drew its terrain.
  const baseline = useRef({ tiles: 0, objects: 0 });
  useEffect(() => {
    baseline.current = {
      tiles: tileCount(store.scene),
      objects: store.scene?.objects.length ?? 0,
    };
  }, [root, store]);

  useEffect(() => {
    const onPlay = (s: { playing: boolean }) => {
      if (s.playing) setRan(true);
    };
    bridge.on("playtest", onPlay);
    return () => {
      bridge.off("playtest", onPlay);
    };
  }, [bridge]);

  const items = useMemo(() => {
    const scene = store.scene;
    return [
      { label: "project created", done: true },
      { label: `${scene?.key ?? "Level_01"} opened`, done: true },
      { label: "paint terrain — press P", done: tileCount(scene) !== baseline.current.tiles },
      {
        label: "place the player — press B",
        done: (scene?.objects.length ?? 0) > baseline.current.objects,
      },
      { label: "press ▶ to run it", done: ran },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.scene, store.version, ran]);

  if (hidden) return null;
  const remaining = items.filter((i) => !i.done).length;

  return (
    <div className="firstrun blueprint">
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      <div className="section-title">First five minutes</div>
      <div className="firstrun-items">
        {items.map((item) => (
          <div key={item.label} className={`firstrun-item ${item.done ? "done" : ""}`}>
            <span className="mark">{item.done ? "✓" : "○"}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      {installing && (
        <div className="hint mono">npm install · running — Run stays disabled until it finishes</div>
      )}
      <button
        className="mini"
        onClick={() => {
          dismiss(root);
          setHidden(true);
        }}
      >
        {remaining === 0 ? "Done — dismiss" : "Dismiss checklist"}
      </button>
    </div>
  );
}
