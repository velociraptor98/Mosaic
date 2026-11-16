/**
 * Whether a folder may run its own code.
 *
 * Everywhere else Mosaic reads source. RUN executes it — it starts the
 * project's dev server — and importing a hand-written scene runs the project
 * to see what it builds. For your own project that is trust you already extend
 * every day; for a folder you were sent, it is not. So it is asked once per
 * folder, and remembered here.
 */

const TRUST_KEY = "mosaic:trusted-scripts:v1";

/**
 * Trust is stored by the EDITOR, per folder — never in the project, where the
 * project itself could grant it.
 */
export function trustedRoots(): string[] {
  try {
    const raw = localStorage.getItem(TRUST_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

export function isTrusted(root: string | null | undefined): boolean {
  return !!root && trustedRoots().includes(root);
}

export function trustRoot(root: string): void {
  if (isTrusted(root)) return;
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify([...trustedRoots(), root]));
  } catch {
    /* a full quota means the ask comes back next time, which is the safe way to fail */
  }
}

export function revokeRoot(root: string): void {
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify(trustedRoots().filter((r) => r !== root)));
  } catch {
    /* ignore */
  }
}
