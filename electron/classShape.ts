import fs from "node:fs/promises";
import path from "node:path";
import { parseAst } from "rolldown/parseAst";
import type { AddCall, ClassShape, MethodShape } from "./contract";

/**
 * The parts of a scene class that wiring a layout into it touches.
 *
 * Parsed here rather than in the renderer because the parser is native, and
 * described rather than rewritten here because the rewrite needs the layout's
 * field names, which only the renderer's generator knows. Offsets are into
 * `source`, which is returned alongside so the renderer splices exactly the
 * text that was parsed.
 */

// ESTree, loosely: only what is walked here is named.
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const FACTORY_OWNERS = new Set(["this.add", "this.physics.add"]);

export async function analyzeClass(root: string, rel: string, cls: string): Promise<ClassShape> {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return fail(rel, "", "outside the project");
  let source: string;
  try {
    source = await fs.readFile(abs, "utf8");
  } catch {
    return fail(rel, "", "could not be read");
  }
  return shapeOf(rel, source, cls);
}

/** Pure, so the check can run it on text without a folder. */
export function shapeOf(rel: string, source: string, cls: string): ClassShape {
  let program: Node;
  try {
    program = parseAst(source, { lang: rel.endsWith(".ts") ? "ts" : "js" }) as unknown as Node;
  } catch (err) {
    return fail(rel, source, `does not parse: ${(err as Error).message.split("\n")[0]}`);
  }

  const body = program.body as Node[];
  const imports = body.filter((n) => n.type === "ImportDeclaration");
  const module = imports.length > 0 || body.some((n) => /^Export/.test(n.type));

  const classNode = findClass(program, cls);
  if (!classNode) return fail(rel, source, `has no class ${cls} that this can find`, module);
  const classBody = classNode.body as Node;
  const members = classBody.body as Node[];

  const method = (name: string): MethodShape | null | "unsupported" => {
    const m = members.find(
      (n) => (n.type === "MethodDefinition" || n.type === "PropertyDefinition") && keyName(n) === name && !n.static,
    );
    if (!m) return null;
    if (m.type !== "MethodDefinition" || (m.kind as string) !== "method") return "unsupported";
    const fn = m.value as Node;
    const fnBody = fn.body as Node | null;
    if (!fnBody) return "unsupported";
    const statements = fnBody.body as Node[];
    return {
      start: m.start,
      keyStart: (m.key as Node).start,
      bodyStart: fnBody.start + 1,
      bodyEnd: fnBody.end - 1,
      firstStatement: statements[0]?.start ?? null,
      async: !!fn.async,
    };
  };
  const create = method("create");
  const preload = method("preload");
  if (create === "unsupported" || preload === "unsupported") {
    return fail(rel, source, "defines create() or preload() in a form this cannot edit", module);
  }

  const calls: AddCall[] = [];
  if (create) {
    const createNode = members.find((n) => n.type === "MethodDefinition" && keyName(n) === "create")!;
    const fnBody = (createNode.value as Node).body as Node;
    collectCalls(fnBody, source, calls);
  }

  return {
    ok: true,
    rel,
    source,
    module,
    importEnd: imports.length ? imports[imports.length - 1].end : null,
    classBodyStart: classBody.start + 1,
    classBodyEnd: classBody.end - 1,
    create: create ?? null,
    preload: preload ?? null,
    calls,
    names: create ? declaredNames(source.slice(create.bodyStart, create.bodyEnd)) : [],
  };
}

function fail(rel: string, source: string, reason: string, module = false): ClassShape {
  return {
    ok: false,
    reason,
    rel,
    source,
    module,
    importEnd: null,
    classBodyStart: 0,
    classBodyEnd: 0,
    create: null,
    preload: null,
    calls: [],
    names: [],
  };
}

function keyName(n: Node): string | null {
  const key = n.key as Node | undefined;
  if (!key || n.computed) return null;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

/** The class declared under this name, or the file's default-exported class. */
function findClass(program: Node, cls: string): Node | null {
  let found: Node | null = null;
  let fallback: Node | null = null;
  walk(program, (node) => {
    if (found) return false;
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      const id = node.id as Node | null;
      if (id && id.name === cls) {
        found = node;
        return false;
      }
    }
    if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration as Node;
      if (decl.type === "ClassDeclaration" || decl.type === "ClassExpression") fallback = decl;
    }
    return true;
  });
  return found ?? fallback;
}

/**
 * `this.add.<factory>(…)` calls that run exactly once per create(): straight
 * in its body, not inside a loop, a condition, a callback or a nested
 * function. Only those can be swapped for one object the layout made.
 */
function collectCalls(fnBody: Node, source: string, out: AddCall[]): void {
  const visit = (node: Node, chain: { node: Node; key: string }[]) => {
    if (node.type === "CallExpression" && isFactoryCall(node, source)) {
      if (chain.every(isStraightLine)) out.push(describeCall(node, chain, source));
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      const kids = Array.isArray(value) ? value : [value];
      for (const kid of kids) {
        if (kid && typeof kid === "object" && typeof (kid as Node).type === "string") {
          visit(kid as Node, [...chain, { node, key }]);
        }
      }
    }
  };
  for (const statement of fnBody.body as Node[]) visit(statement, []);
}

/**
 * Whether stepping from this ancestor into the child named `key` keeps the
 * call on the straight-line path of the method. Only the shapes a creation
 * line actually takes: a declaration, an assignment, a chain of setters.
 */
function isStraightLine({ node, key }: { node: Node; key: string }): boolean {
  switch (node.type) {
    case "ExpressionStatement":
      return key === "expression";
    case "VariableDeclaration":
      return key === "declarations";
    case "VariableDeclarator":
      return key === "init";
    case "AssignmentExpression":
      return key === "right" && node.operator === "=";
    case "MemberExpression":
      return key === "object";
    case "CallExpression":
      return key === "callee";
    case "ChainExpression":
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
      return key === "expression";
    default:
      return false;
  }
}

function isFactoryCall(node: Node, source: string): boolean {
  const callee = node.callee as Node;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const owner = (callee.object as Node);
  return FACTORY_OWNERS.has(source.slice(owner.start, owner.end).replace(/\s+/g, ""));
}

function describeCall(node: Node, chain: { node: Node; key: string }[], source: string): AddCall {
  const callee = node.callee as Node;
  const parent = chain[chain.length - 1]?.node;
  const statement = chain[0]?.node;
  let binding: string | null = null;
  for (const { node: n } of chain) {
    if (n.type === "VariableDeclarator" && (n.id as Node).type === "Identifier") binding = (n.id as Node).name as string;
    if (n.type === "AssignmentExpression") {
      const left = n.left as Node;
      if (left.type === "Identifier") binding = left.name as string;
      if (left.type === "MemberExpression" && !left.computed && (left.property as Node).type === "Identifier") {
        binding = (left.property as Node).name as string;
      }
    }
  }
  return {
    start: node.start,
    end: node.end,
    line: lineOf(source, node.start),
    factory: ((callee.property as Node).name as string) ?? "",
    // The call is the whole statement — its result is never used — so taking
    // it over removes the line rather than leaving `layout.x;` behind.
    statement:
      parent && parent.type === "ExpressionStatement" && statement === parent
        ? { start: parent.start, end: parent.end }
        : null,
    binding,
  };
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Identifiers declared anywhere in a method body, so a new local cannot shadow one. */
function declaredNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return [...out];
}

function walk(node: Node, fn: (node: Node) => boolean): void {
  if (!fn(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "type") continue;
    const kids = Array.isArray(value) ? value : [value];
    for (const kid of kids) {
      if (kid && typeof kid === "object" && typeof (kid as Node).type === "string") walk(kid as Node, fn);
    }
  }
}
