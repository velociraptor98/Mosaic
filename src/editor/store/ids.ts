let counter = 0;

export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36).slice(-4)}${counter.toString(36)}`;
}

/** "Coin" -> "Coin 2" when "Coin" is taken. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/** "Level 1" -> "Level_1", collision-free against existing keys. */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const clean = base.trim().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "Scene";
  const used = new Set(taken);
  if (!used.has(clean)) return clean;
  let n = 2;
  while (used.has(`${clean}_${n}`)) n += 1;
  return `${clean}_${n}`;
}
