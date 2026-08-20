import { useEffect, useRef, useState } from "react";

/**
 * The label of a field, with its two prefab markers: the revert arrow when the
 * instance has claimed the value, and the lock when the definition owns it.
 *
 * A locked field is SHOWN rather than hidden. Hiding it would leave a level
 * designer wondering where the value went; showing it locked says who owns it
 * and where to go to change that.
 */
function FieldLabel({
  label,
  marked,
  onRevert,
  locked,
}: {
  label: string;
  marked?: boolean;
  onRevert?: () => void;
  locked?: string;
}) {
  return (
    <span className="field-label">
      {label}
      {locked && (
        <span className="lock" title={locked}>
          🔒
        </span>
      )}
      {marked && !locked && (
        <button
          className="revert"
          title="Revert this override to the prefab's value"
          onClick={(e) => {
            e.preventDefault();
            onRevert?.();
          }}
        >
          ⟲
        </button>
      )}
    </span>
  );
}

/**
 * Numeric field that commits on blur or ⏎ and never clobbers what you are
 * typing when the canvas pushes a new value mid-drag.
 */
export function NumberField({
  label,
  value,
  step = 1,
  onCommit,
  onLive,
  marked,
  onRevert,
  disabled,
  locked,
}: {
  label: string;
  value: number;
  step?: number;
  onCommit: (v: number) => void;
  onLive?: (v: number) => void;
  marked?: boolean;
  onRevert?: () => void;
  disabled?: boolean;
  /** Why the definition owns this value, when it does. */
  locked?: string;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(text);
    if (text.trim() === "" || Number.isNaN(n)) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };

  return (
    <label className={`field ${marked ? "overridden" : ""} ${locked ? "locked" : ""}`}>
      <FieldLabel label={label} marked={marked} onRevert={onRevert} locked={locked} />
      <input
        type="number"
        step={step}
        value={text}
        disabled={disabled || !!locked}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (onLive && !Number.isNaN(n)) onLive(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onCommit,
  placeholder,
  marked,
  onRevert,
  locked,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  marked?: boolean;
  onRevert?: () => void;
  locked?: string;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <label className={`field ${marked ? "overridden" : ""} ${locked ? "locked" : ""}`}>
      <FieldLabel label={label} marked={marked} onRevert={onRevert} locked={locked} />
      <input
        value={text}
        disabled={!!locked}
        placeholder={placeholder}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          if (text !== value) onCommit(text);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function CheckField({
  label,
  value,
  onCommit,
  marked,
  onRevert,
  locked,
}: {
  label: string;
  value: boolean;
  onCommit: (v: boolean) => void;
  marked?: boolean;
  onRevert?: () => void;
  locked?: string;
}) {
  return (
    <label className={`field check ${marked ? "overridden" : ""} ${locked ? "locked" : ""}`}>
      <input
        type="checkbox"
        checked={value}
        disabled={!!locked}
        onChange={(e) => onCommit(e.target.checked)}
      />
      <FieldLabel label={label} marked={marked} onRevert={onRevert} locked={locked} />
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  onCommit,
  marked,
  onRevert,
  locked,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onCommit: (v: string) => void;
  marked?: boolean;
  onRevert?: () => void;
  locked?: string;
}) {
  return (
    <label className={`field ${marked ? "overridden" : ""} ${locked ? "locked" : ""}`}>
      <FieldLabel label={label} marked={marked} onRevert={onRevert} locked={locked} />
      <select value={value} disabled={!!locked} onChange={(e) => onCommit(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function JsonField({
  label,
  value,
  onCommit,
  locked,
}: {
  label: string;
  value: unknown;
  onCommit: (v: unknown) => void;
  locked?: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(JSON.stringify(value ?? {}, null, 2));
  }, [value]);

  return (
    <div className={`field json ${locked ? "locked" : ""}`}>
      <FieldLabel label={label} locked={locked} />
      <textarea
        rows={6}
        value={text}
        disabled={!!locked}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false;
          try {
            onCommit(JSON.parse(text));
            setError(null);
          } catch {
            setError("Not valid JSON — fix the syntax and click away again.");
          }
        }}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
