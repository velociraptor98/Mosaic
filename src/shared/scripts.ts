import type { PropertyType } from "../runtime/scripts";
import type { SceneObject, ScriptRef } from "./types";

/**
 * The scene-data half of script components: where their source lives, how an
 * instance addresses one value of one script, and how a stored value is
 * compared against the type its class declares.
 *
 * Imported by both the editor and the runtime loader, so nothing here knows
 * about React, the store, or the filesystem.
 */

export const SCRIPT_DIR = "src/scripts";
/** The base class + decorator Mosaic writes into a new project. */
export const SCRIPT_BASE_FILE = `${SCRIPT_DIR}/ScriptComponent.ts`;
export const SCRIPT_BASE_CLASS = "ScriptComponent";

/** Files the script index will read. Everything else in src/ is ignored. */
export const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mts|mjs)$/;

export function scriptFilePath(className: string): string {
  return `${SCRIPT_DIR}/${className}.ts`;
}

export function scriptsOf(obj: Pick<SceneObject, "scripts">): ScriptRef[] {
  return obj.scripts ?? [];
}

/**
 * Override paths for a prefab instance.
 *
 * Values are addressed per script index so `resolveObject`'s existing
 * definition ← overrides walk handles them with no special case: the prefab
 * supplies the whole `scripts` array, and the instance writes single leaves
 * back into it.
 */
export function scriptPropPath(index: number, field: string): string {
  return `scripts.${index}.props.${field}`;
}

export function scriptEnabledPath(index: number): string {
  return `scripts.${index}.enabled`;
}

/** The path an instance uses when it changes the LIST itself, not a value. */
export const SCRIPT_LIST_PATH = "scripts";

export function isScriptOverridePath(path: string): boolean {
  return path === SCRIPT_LIST_PATH || path.startsWith("scripts.");
}

export function newScriptRef(className: string, src: string): ScriptRef {
  return { class: className, src, enabled: true, props: {} };
}

/** The type a stored JSON value reads as, for comparison against the class. */
export function valueType(value: unknown): PropertyType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "function") return "function";
  return "object";
}

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
