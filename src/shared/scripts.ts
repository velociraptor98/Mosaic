/**
 * The scene-data half of editable class fields: what kind of value a field
 * holds, which source files the index reads, and how a stored value is
 * compared against the type its class declares.
 *
 * Imported by the editor and the store, so nothing here knows about React or
 * the filesystem.
 */

/** What an editable field holds, as the inspector renders it. */
export type PropertyType =
  | "number"
  | "string"
  | "boolean"
  | "enum"
  | "object"
  | "function"
  | "ref";

/** Files the source index will read. Everything else in src/ is ignored. */
export const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * Whether a stored value still fits the declared type. `enum` and `ref` are
 * carried as strings, and a null default fits anything — a field that was
 * never given a value should not read as a type error.
 */
export function fitsType(declared: PropertyType, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (declared) {
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string":
    case "enum":
    case "ref":
      return typeof value === "string";
    case "object":
    case "function":
      return true;
  }
}

/**
 * Best-effort conversion, used by the "convert" action the inspector offers
 * when a field's type changed under a value the scene already holds. Returns
 * null when there is no sensible reading, so the editor can say so instead of
 * writing a 0 nobody asked for.
 */
export function convertValue(declared: PropertyType, value: unknown): unknown | null {
  switch (declared) {
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      return null;
    case "string":
    case "enum":
    case "ref":
      return typeof value === "object" ? null : String(value);
    default:
      return null;
  }
}
