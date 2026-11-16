import type { PropertyType } from "../../shared/scripts";

/**
 * Reads editable-field declarations out of a project's own source.
 *
 * A field is editable when its doc comment carries an `@editable` tag:
 *
 *   /** Pixels per second. @editable { min: 0, max: 600 } *\/
 *   speed = 220;
 *
 * That is a comment, so the class compiles and runs exactly as it would
 * without Mosaic: no import, no decorator, no compiler setting, and it works
 * in plain JavaScript. The comment's description becomes the inspector's hint.
 * The older `@property(...)` decorator is still read, so projects written
 * against it keep working.
 *
 * Mosaic never executes your code to find out what a script exposes — the
 * editor is a scene editor, not a sandbox for game code — so the class's
 * declarations are read statically. That is also why the index survives a file
 * that does not compile: this parser looks at declarations, not at semantics.
 *
 * Deliberately line-oriented: the inspector needs the LINE of each declaration
 * (the source drawer highlights them, and "Open in…" jumps to one), which a
 * pure-regex pass over the whole file cannot give.
 */

export interface ScriptProperty {
  name: string;
  type: PropertyType;
  /** The value the class initialises the field to. */
  default: unknown;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  hint?: string;
  /** 1-based line of the annotation: the `@editable` doc comment or the decorator. */
  line: number;
  /** 1-based line of the field itself. */
  endLine: number;
  /** Objects and callbacks are rendered read-only: they are code, not data. */
  codeOnly: boolean;
}

export interface ScriptClass {
  name: string;
  /** Project-relative POSIX path. */
  src: string;
  base: string | null;
  exported: boolean;
  abstract: boolean;
  /** True for `export default class`, which is imported without braces. */
  isDefault: boolean;
  /**
   * The constructor's parameter names, in order. Empty when it declares none
   * and `null` when the class has no constructor of its own.
   *
   * Read because anything that wants to CONSTRUCT one of these classes has to
   * know its shape, and the shape is not conventional: across the Phaser
   * examples the signatures include `(scene, x, y)`, `(name, scene, x, y)`,
   * `(scene, track)` and `(config)`. Assuming the first would generate calls
   * that silently pass a scene where a name was wanted.
   */
  ctorParams: string[] | null;
  /** 1-based line of the class declaration. */
  line: number;
  properties: ScriptProperty[];
}

export interface ParsedFile {
  src: string;
  classes: ScriptClass[];
  /**
   * Set when the file looks broken (unbalanced braces). The caller keeps the
   * last good metadata rather than emptying the inspector on every keystroke
   * an external editor saves mid-edit.
   */
  error?: string;
}

const CLASS_RE =
  /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s*<[^>]*>)?(?:\s+extends\s+([\w$.]+))?/;

const FIELD_RE =
  /^\s*(?:(?:public|private|protected|readonly|declare|static|override|accessor)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::\s*([^=;]+?))?\s*(?:=\s*([\s\S]+?))?\s*;?\s*$/;

/**
 * Blanks comments so the scanners below cannot match inside one, and reports
 * the brace depth at the start of each line. String and template contents are
 * left alone: initialisers are read from them.
 */
function scan(source: string): { code: string[]; depth: number[]; balanced: boolean } {
  const code: string[] = [];
  const depth: number[] = [];
  let level = 0;
  let inBlockComment = false;
  let inTemplate = 0; // nesting of `...` literals

  for (const line of source.split(/\r?\n/)) {
    depth.push(level);
    let out = "";
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (inBlockComment) {
        out += " ";
        if (ch === "*" && next === "/") {
          out += " ";
          i++;
          inBlockComment = false;
        }
        continue;
      }
      if (quote) {
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i++;
        } else if (ch === quote) quote = null;
        continue;
      }
      if (inTemplate > 0) {
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i++;
        } else if (ch === "`") inTemplate--;
        continue;
      }
      if (ch === "/" && next === "/") {
        out += " ".repeat(line.length - i);
        break;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        out += "  ";
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "`") {
        inTemplate++;
        out += ch;
        continue;
      }
      if (ch === "{") level++;
      if (ch === "}") level--;
      out += ch;
    }
    code.push(out);
  }

  return { code, depth, balanced: level === 0 && !inBlockComment };
}

export function parseScriptFile(src: string, source: string): ParsedFile {
  const { code, depth, balanced } = scan(source);
  const raw = source.split(/\r?\n/);
  const classes: ScriptClass[] = [];

  let current: ScriptClass | null = null;
  let currentDepth = 0;
  /** Whether `current`'s body has actually been entered yet. */
  let bodyOpened = false;
  /** Decorator options waiting for the field they annotate. */
  let pending: { options: Record<string, unknown>; line: number } | null = null;

  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    const at = depth[i];

    // Back out to the declaration's own depth: the class body has closed. This
    // runs before the class regex below, so a class declared on the line right
    // after another one's closing brace opens a new class rather than having
    // its members read as the previous one's.
    //
    // The body has to have OPENED first. With the brace on its own line — the
    // style the Phaser examples are written in — the `{` sits at the
    // declaration's own depth, and treating that as a close threw the class
    // away before a single member was read. Nothing Mosaic generates is
    // written that way, which is why it went unnoticed.
    if (current && bodyOpened && at <= currentDepth) {
      current = null;
      pending = null;
    }
    if (current && at > currentDepth) bodyOpened = true;

    const cls = CLASS_RE.exec(line);
    if (cls && !current) {
      current = {
        name: cls[4],
        src,
        base: cls[5] ?? null,
        exported: !!cls[1],
        abstract: !!cls[3],
        isDefault: !!cls[2],
        ctorParams: null,
        line: i + 1,
        properties: [],
      };
      currentDepth = at;
      classes.push(current);
      pending = null;
      // `class Derived extends Base {}` opens and closes on its own line, so
      // there is no body to wait for and nothing after it belongs to this
      // class.
      //
      // Both halves of the test are needed. The next line's depth alone cannot
      // tell that case from a brace on the following line — `depth` is the
      // depth BEFORE a line, so both read as unchanged — and the declaration
      // having a brace at all is what separates them.
      bodyOpened = false;
      const opensHere = line.includes("{");
      if (opensHere && i + 1 < depth.length && depth[i + 1] <= at) current = null;
      continue;
    }

    if (!current) continue;

    // The constructor's own line. Parameters may wrap, so the text is taken
    // from the opening paren to its match rather than from this line alone.
    if (current.ctorParams === null) {
      const ctor = /^\s*constructor\s*\(/.exec(line);
      if (ctor) {
        let text = "";
        let depth = 0;
        let done = false;
        for (let j = i; j < code.length && !done; j += 1) {
          const from = j === i ? code[j].indexOf("(") : 0;
          for (let k = from; k < code[j].length; k += 1) {
            const ch = code[j][k];
            if (ch === "(") depth += 1;
            else if (ch === ")") {
              depth -= 1;
              if (depth === 0) { done = true; break; }
              continue;
            }
            if (depth >= 1 && !(j === i && k === from)) text += ch;
          }
          text += " ";
        }
        current.ctorParams = splitParams(text);
      }
    }

    // Only the class's own members, never a nested object literal's keys.
    if (at !== currentDepth + 1) continue;

    if (/^\s*@property\b/.test(line)) {
      // `@property` without a call takes no options — and must not send the
      // reader hunting for a "(" that belongs to the next method.
      if (!/^\s*@property\s*\(/.test(line)) {
        pending = { options: {}, line: i + 1 };
        continue;
      }
      const decorator = readDecorator(code, i);
      pending = { options: parseOptions(decorator.argument), line: i + 1 };
      i = decorator.endLine;
      // The field may sit on the same line the decorator closed on.
      const tail = code[decorator.endLine].replace(/^[\s\S]*?\)\s*/, "");
      const inline = tail.trim() ? FIELD_RE.exec(tail) : null;
      if (inline) {
        const property = toProperty(inline, pending, decorator.endLine + 1);
        if (property) current.properties.push(property);
        pending = null;
      }
      continue;
    }

    // A field whose doc comment says `@editable`.
    if (!pending && line.trim()) {
      const doc = editableDoc(raw, i);
      if (doc && !isMethodLine(line)) {
        const field = FIELD_RE.exec(line);
        const property = field ? toProperty(field, doc, i + 1) : null;
        if (property) current.properties.push(property);
      }
      continue;
    }

    if (!pending) continue;
    if (!line.trim()) continue;
    // A decorator that annotates a method, not a field, exposes nothing.
    if (isMethodLine(line)) {
      pending = null;
      continue;
    }
    const field = FIELD_RE.exec(line);
    if (field) {
      const property = toProperty(field, pending, i + 1);
      if (property) current.properties.push(property);
    }
    pending = null;
  }

  return {
    src,
    classes,
    error: balanced ? undefined : "unbalanced braces — the file may not compile",
  };
}

/** A member line that declares a method rather than a field. */
function isMethodLine(line: string): boolean {
  return /\(.*\)\s*\{?\s*$/.test(line) && !/=/.test(line);
}

/**
 * The `@editable` doc comment that annotates line `i`, if there is one: either
 * a `/** … *\/` block ending on the line directly above, or one that sits on
 * the same line in front of the field.
 */
function editableDoc(
  raw: string[],
  i: number,
): { options: Record<string, unknown>; line: number } | null {
  let text: string | null = null;
  let line = i + 1;
  const inline = /^\s*\/\*\*([\s\S]*?)\*\/\s*\S/.exec(raw[i]);
  if (inline) text = inline[1];
  else if (i > 0 && /\*\/\s*$/.test(raw[i - 1])) {
    for (let k = i - 1; k >= 0; k--) {
      const open = raw[k].indexOf("/**");
      if (open >= 0) {
        text = raw
          .slice(k, i)
          .join("\n")
          .slice(open + 3)
          .replace(/\*\/\s*$/, "");
        line = k + 1;
        break;
      }
      // Stop at a plain block comment or anything that is not comment body.
      if (raw[k].includes("/*") || (k < i - 1 && !/^\s*\*/.test(raw[k]))) break;
    }
  }
  if (text === null) return null;
  // Strip the leading `*` of each comment line.
  const body = text
    .split("\n")
    .map((l) => l.replace(/^\s*\*(?!\/)\s?/, ""))
    .join("\n");
  const tag = /@editable\b/.exec(body);
  if (!tag) return null;

  const after = body.slice(tag.index + tag[0].length).trimStart();
  let options: Record<string, unknown> = {};
  if (after.startsWith("{")) {
    let open = 0;
    for (let c = 0; c < after.length; c++) {
      if (after[c] === "{") open++;
      else if (after[c] === "}" && --open === 0) {
        options = parseOptions(after.slice(0, c + 1));
        break;
      }
    }
  }
  // The description: everything before the first tag, as one line.
  const description = body
    .slice(0, body.search(/(^|\s)@\w/) >= 0 ? body.search(/(^|\s)@\w/) : body.length)
    .replace(/\s+/g, " ")
    .trim();
  if (description && options.hint === undefined) options = { ...options, hint: description };
  return { options, line };
}

/** Accumulates a decorator call that may run over several lines. */
function readDecorator(code: string[], start: number): { argument: string; endLine: number } {
  let text = "";
  let open = 0;
  let seen = false;
  for (let i = start; i < code.length; i++) {
    for (const ch of code[i]) {
      if (ch === "(") {
        open++;
        seen = true;
        if (open === 1) continue;
      } else if (ch === ")") {
        open--;
        if (open === 0) return { argument: text, endLine: i };
      }
      if (seen && open > 0) text += ch;
    }
    text += " ";
    if (seen && open === 0) return { argument: text, endLine: i };
  }
  return { argument: text, endLine: code.length - 1 };
}

function toProperty(
  match: RegExpExecArray,
  pending: { options: Record<string, unknown>; line: number },
  endLine: number,
): ScriptProperty | null {
  const name = match[1];
  if (!name || name === "constructor") return null;
  const annotation = match[2]?.trim();
  const initialiser = match[3]?.trim().replace(/;+$/, "");
  const options = pending.options;

  const literal = initialiser ? parseLiteral(initialiser) : { value: undefined, kind: null };
  const declared = typeof options.type === "string" ? (options.type as PropertyType) : null;
  const enumOptions = Array.isArray(options.options) ? (options.options as string[]) : undefined;

  const type: PropertyType =
    declared ??
    (enumOptions ? "enum" : null) ??
    fromAnnotation(annotation) ??
    literal.kind ??
    "string";

  return {
    name,
    type,
    default: literal.value,
    label: typeof options.label === "string" ? options.label : undefined,
    min: typeof options.min === "number" ? options.min : undefined,
    max: typeof options.max === "number" ? options.max : undefined,
    step: typeof options.step === "number" ? options.step : undefined,
    options: enumOptions ?? unionOptions(annotation),
    hint: typeof options.hint === "string" ? options.hint : undefined,
    line: pending.line,
    endLine,
    codeOnly: type === "object" || type === "function",
  };
}

function fromAnnotation(annotation: string | undefined): PropertyType | null {
  if (!annotation) return null;
  const t = annotation.trim().replace(/\s+/g, " ");
  if (/=>|\bFunction\b/.test(t)) return "function";
  if (/^number$/.test(t)) return "number";
  if (/^string$/.test(t)) return "string";
  if (/^boolean$/.test(t)) return "boolean";
  if (unionOptions(t)) return "enum";
  if (/\[\]$|^Array<|^Record<|^\{|^object$|^Map<|^Set</.test(t)) return "object";
  if (/^(any|unknown)$/.test(t)) return null;
  // A class or interface type: the editor stores the NAME of the thing, and
  // resolving it is the game's job.
  return "ref";
}

/** `"a" | "b"` becomes an enum picker rather than a free-text field. */
function unionOptions(annotation: string | undefined): string[] | undefined {
  if (!annotation || !annotation.includes("|")) return undefined;
  const parts = annotation.split("|").map((p) => p.trim());
  if (!parts.length) return undefined;
  const values: string[] = [];
  for (const part of parts) {
    const m = /^["'](.*)["']$/.exec(part);
    if (!m) return undefined;
    values.push(m[1]);
  }
  return values;
}

/** The initialiser, as data where it is data and as a kind where it is code. */
export function parseLiteral(text: string): { value: unknown; kind: PropertyType | null } {
  const t = text.trim();
  if (!t) return { value: undefined, kind: null };
  if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(t)) return { value: Number(t), kind: "number" };
  if (t === "true" || t === "false") return { value: t === "true", kind: "boolean" };
  if (t === "null") return { value: null, kind: null };
  if (t === "undefined") return { value: undefined, kind: null };
  const str = /^(["'`])([\s\S]*)\1$/.exec(t);
  if (str) return { value: str[2], kind: "string" };
  if (/^(\(|function\b|async\b)/.test(t) || t.includes("=>")) return { value: undefined, kind: "function" };
  if (t.startsWith("[") || t.startsWith("{")) {
    const parsed = looseJson(t);
    return { value: parsed ?? undefined, kind: "object" };
  }
  // `new Vec2()`, another identifier, an enum member: code, not data.
  return { value: undefined, kind: "object" };
}

/**
 * Decorator arguments are JS object literals, not JSON: keys are unquoted and
 * strings are often single-quoted. Parsing is best effort — an option we
 * cannot read is an option the inspector does without.
 */
export function parseOptions(argument: string): Record<string, unknown> {
  const text = argument.trim();
  if (!text) return {};
  const parsed = looseJson(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function looseJson(text: string): unknown {
  const normalised = text
    // 'single' -> "double", leaving escaped quotes alone
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, body: string) => JSON.stringify(body.replace(/\\'/g, "'")))
    .replace(/`((?:[^`\\]|\\.)*)`/g, (_m, body: string) => JSON.stringify(body))
    // bare keys -> quoted keys
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    // trailing commas
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(normalised);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface ScriptIndex {
  /** Every class found, in path order. */
  classes: ScriptClass[];
  /**
   * Every file read, whether or not it declared a class.
   *
   * Kept because a project's most important file often declares none — the
   * entry point that constructs the game is usually a handful of statements —
   * and an inventory that only listed class-bearing files left it out.
   */
  files: string[];
  byKey: Map<string, ScriptClass>;
  errors: { src: string; error: string }[];
}

/** `src/scripts/Foo.ts::Foo` — unique even when two files export one name. */
export function scriptKey(src: string, className: string): string {
  return `${src}::${className}`;
}

export function buildIndex(files: ParsedFile[]): ScriptIndex {
  const classes = files.flatMap((f) => f.classes);
  return {
    classes,
    files: files.map((f) => f.src).sort((a, b) => a.localeCompare(b)),
    byKey: new Map(classes.map((c) => [scriptKey(c.src, c.name), c])),
    errors: files.flatMap((f) => (f.error ? [{ src: f.src, error: f.error }] : [])),
  };
}

export interface SourceFile {
  src: string;
  /** Every class the file declares, in declaration order. */
  classes: ScriptClass[];
}

/**
 * Every source file the project has, with the classes in it, for the Project
 * panel. A file that declares no class (the entry point, usually) is listed
 * too: it is still the project's code.
 */
export function sourceFiles(index: ScriptIndex): SourceFile[] {
  const bySrc = new Map<string, ScriptClass[]>();
  for (const src of index.files) bySrc.set(src, []);
  for (const cls of index.classes) {
    const list = bySrc.get(cls.src) ?? [];
    list.push(cls);
    bySrc.set(cls.src, list);
  }
  return [...bySrc]
    .map(([src, classes]) => ({ src, classes }))
    .sort((a, b) => a.src.localeCompare(b.src));
}

/** Every property a class exposes, including those it inherits. */
export function propertiesOf(index: ScriptIndex, cls: ScriptClass): ScriptProperty[] {
  const chain: ScriptClass[] = [];
  const seen = new Set<string>();
  let node: ScriptClass | undefined = cls;
  while (node && !seen.has(node.name)) {
    seen.add(node.name);
    chain.unshift(node);
    const baseName: string | undefined = node.base?.split(".").pop();
    node = baseName ? index.classes.find((c) => c.name === baseName) : undefined;
  }
  const out: ScriptProperty[] = [];
  for (const link of chain) {
    for (const property of link.properties) {
      const at = out.findIndex((p) => p.name === property.name);
      if (at >= 0) out[at] = property;
      else out.push(property);
    }
  }
  return out;
}

/**
 * Parameter names out of a constructor's parameter list.
 *
 * Only the NAME matters to a caller building an argument list, so defaults,
 * types and modifiers are stripped. Nested parens, brackets and braces are
 * tracked so a default like `= new Foo(1, 2)` or a destructured `{ a, b }`
 * does not split the list in the wrong place.
 */
function splitParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);

  return out
    .map((raw) => {
      const noDefault = raw.split("=")[0];
      const noType = noDefault.split(":")[0];
      const name = noType
        .replace(/\b(public|private|protected|readonly|override)\b/g, "")
        .replace(/\.\.\./, "")
        .trim();
      return name;
    })
    .filter((n) => n.length > 0 && /^[A-Za-z_$][\w$]*$/.test(n));
}
