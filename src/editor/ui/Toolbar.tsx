import { useEffect, useState } from "react";
import type { Tool } from "../store/project";
import { MosaicMark } from "./Logo";
import { useEditor, useStoreVersion } from "./context";

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: "select", label: "Select", key: "V", hint: "Click, marquee, drag handles" },
  { id: "place", label: "Place", key: "B", hint: "Click the canvas to instantiate the armed asset" },
  { id: "brush", label: "Brush", key: "P", hint: "Paint tiles — one undo per stroke" },
  { id: "rect", label: "Rect", key: "R", hint: "Drag a rectangle of tiles" },
  { id: "erase", label: "Erase", key: "E", hint: "Erase tiles (putTile -1)" },
];

export function Toolbar() {
  const { store, bridge } = useEditor();
  useStoreVersion(store);
  const [cursor, setCursor] = useState({ x: 0, y: 0, col: -1, row: -1 });
  const [snapped, setSnapped] = useState(false);

  useEffect(() => {
    const onCursor = (c: typeof cursor) => setCursor(c);
    const onSnap = (s: { x: number | null; y: number | null }) =>
      setSnapped(s.x !== null || s.y !== null);
    bridge.on("cursor", onCursor);
    bridge.on("snapHit", onSnap);
    return () => {
      bridge.off("cursor", onCursor);
      bridge.off("snapHit", onSnap);
    };
  }, [bridge]);

  const layer = store.activeLayer;
  const ui = store.ui;

  return (
    <div className="toolbar">
      {/* The mark alone at 14px — solid cut — where a wordmark would compete
          with the tool labels. */}
      <MosaicMark size={14} />

      <div className="tool-group">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className={`tool ${ui.tool === tool.id ? "active" : ""}`}
            onClick={() => store.setUi({ tool: tool.id })}
            title={`${tool.hint}  (${tool.key})`}
          >
            {tool.label}
            <kbd>{tool.key}</kbd>
          </button>
        ))}
      </div>

      <div className="tool-group">
        <button
          className={`toggle ${ui.snap ? "on" : ""} ${snapped ? "hit" : ""}`}
          onClick={() => store.setUi({ snap: !ui.snap })}
          title="Snap to the grid and to nearby object edges. Hold Alt to suspend for one drag."
        >
          SNAP
        </button>
        <button
          className={`toggle ${ui.showGrid ? "on" : ""}`}
          onClick={() => store.setUi({ showGrid: !ui.showGrid })}
        >
          GRID
        </button>
        <button
          className={`toggle ${ui.showBodies ? "on" : ""}`}
          onClick={() => store.setUi({ showBodies: !ui.showBodies })}
          title="Draw arcade bodies over the art, with drag handles"
        >
          BODIES
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-readout">
        <span className="chip">{layer ? `${layer.kind} · ${layer.name}` : "no layer"}</span>
        <span className="chip">
          x {cursor.x} y {cursor.y}
          {cursor.col >= 0 ? `  ·  c${cursor.col} r${cursor.row}` : ""}
        </span>
        <span className="chip">
          zoom {Math.round(store.view.camera.zoom * 100)}%
        </span>
      </div>
    </div>
  );
}
