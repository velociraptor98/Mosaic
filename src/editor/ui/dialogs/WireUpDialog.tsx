import { useState } from "react";
import { platform } from "../../platform";
import type { Wiring } from "../../project/adopt";
import { useEditor } from "../context";
import { Dialog } from "./Dialog";

/**
 * What happened to each scene class once its layout exists.
 *
 * When the user let Mosaic edit their classes, this is the record of what it
 * changed: per file, which objects now come from the layout and which the code
 * still makes. Otherwise — they declined, or a class could not be edited — it
 * gives the exact lines to add, and where. Importing a whole game lists every
 * scene here at once, rather than a dialog per scene.
 */
export function WireUpDialog() {
  const { workspace } = useEditor();
  const wirings = workspace.wiring;
  if (!wirings?.length) return null;

  const close = () => workspace.dismissWiring();
  const one = wirings.length === 1 ? wirings[0] : null;
  const pending = wirings.filter((w) => !w.wired);
  const edited = wirings.filter((w) => w.applied);
  const asked = wirings.some((w) => w.applied || w.failed);

  return (
    <Dialog
      wide
      title={
        asked
          ? `Updated ${edited.length} of ${wirings.length} scene class${wirings.length === 1 ? "" : "es"}`
          : one
            ? one.wired
              ? `${one.cls} already uses its layout`
              : `Wire ${one.cls} to its layout`
            : `Wire ${wirings.length} scenes to their layouts`
      }
      subtitle={
        asked
          ? "Mosaic wrote a layout beside each scene class and changed the classes below to use them."
          : one
            ? `Mosaic wrote ${one.layout}. ${one.src} is yours and was not touched.`
            : `Mosaic wrote a layout beside each scene class. None of your classes were touched.`
      }
      onClose={close}
      footer={
        <button className="primary" onClick={close}>
          Done
        </button>
      }
    >
      <div className="stack">
        <p className="muted">
          {pending.length
            ? asked
              ? "The classes that could not be changed are listed with the lines to add by hand. Until they have them, what you lay out for them here is saved but not used."
              : "Add these lines to each class. Until you do, the game runs exactly as it did, and what you lay out here is saved but not used."
            : "Every class imports its layout now, so every save in the editor reaches the game."}
        </p>
        {wirings.map((w) => (
          <WiringBlock key={w.layout} wiring={w} />
        ))}
        {workspace.wiringNotes.length > 0 && (
          <details className="wire-dupes">
            <summary>Notes from the import ({workspace.wiringNotes.length})</summary>
            {workspace.wiringNotes.map((note, i) => (
              <div key={i} className="check-row">
                <span className="mark">·</span>
                {note}
              </div>
            ))}
          </details>
        )}
        {pending.length > 0 && (
          <p className="hint">
            If a class already has <code>preload()</code> or <code>create()</code>, add the line to the one
            it has. A layout's preload only queues what it places, and a key your Preloader already loaded
            is skipped by Phaser rather than loaded twice.
          </p>
        )}
      </div>
    </Dialog>
  );
}

function WiringBlock({ wiring }: { wiring: Wiring }) {
  const { workspace } = useEditor();
  const [copied, setCopied] = useState(false);
  const snippet = `${wiring.importLine}

  preload ()
  {
    ${wiring.preloadLine}
  }

  create ()
  {
    ${wiring.createLine}
    // layout.<name> is every object placed in the editor, by name.
  }`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="wire-block">
      <div className="wire-head">
        <code>{wiring.src}</code>
        {wiring.applied ? (
          <span className="tag-outline">updated</span>
        ) : (
          wiring.wired && <span className="tag-outline">already wired</span>
        )}
        <span className="wire-actions">
          <button className="mini" onClick={() => void copy()}>
            {copied ? "copied" : "copy"}
          </button>
          {workspace.location && (
            <button
              className="mini"
              onClick={() => void platform.openInEditor(workspace.location!.root, wiring.src, wiring.line)}
            >
              open
            </button>
          )}
        </span>
      </div>
      {wiring.failed && !wiring.wired && (
        <div className="muted">Not changed — it {wiring.failed}. Add these lines by hand:</div>
      )}
      {!wiring.wired && <pre className="code-preview wire-snippet">{snippet}</pre>}
      {wiring.applied && (
        <div className="wire-applied">
          <div className="muted">
            Imports <code>{wiring.layout.split("/").pop()}</code> and calls <code>preload{wiring.cls}(this)</code>{" "}
            and <code>create{wiring.cls}(this)</code>.
          </div>
          {wiring.applied.taken.length > 0 && (
            <details className="wire-dupes">
              <summary>
                {wiring.applied.taken.length} object{wiring.applied.taken.length === 1 ? "" : "s"} now come
                from the layout
              </summary>
              <div className="file-tree">
                {wiring.applied.taken.map((d) => (
                  <div key={d} className="file-row">
                    <span className="sign">→</span>layout.{d}
                  </div>
                ))}
              </div>
            </details>
          )}
          {wiring.applied.left.length > 0 && (
            <details className="wire-dupes">
              <summary>
                {wiring.applied.left.length} object{wiring.applied.left.length === 1 ? "" : "s"} stay in your
                code, not the layout
              </summary>
              <div className="file-tree">
                {wiring.applied.left.map((d, i) => (
                  <div key={`${d.name}-${i}`} className="file-row">
                    <span className="sign">·</span>
                    {d.name} — {d.why}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {wiring.duplicates && wiring.duplicates.length > 0 && (
        <details className="wire-dupes">
          <summary>
            Its create() still builds {wiring.duplicates.length} object
            {wiring.duplicates.length === 1 ? "" : "s"} the layout now builds too — remove that code
            once you call <code>create{wiring.cls}</code>
          </summary>
          <div className="file-tree">
            {wiring.duplicates.map((d) => (
              <div key={d} className="file-row">
                <span className="sign">=</span>
                {d}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
