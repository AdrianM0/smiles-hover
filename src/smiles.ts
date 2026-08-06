/**
 * Characters that can be part of a SMILES token. Rejects fragments of longer
 * runs: `CCO` shouldn't match inside `CCOCC` or inside `Cocoa`. `>` is here for
 * reaction SMILES, so `CCO>>CCBr` is one token rather than two molecules.
 */
export const SMILES_CHAR = /[A-Za-z0-9@+\-[\]()\\/#=%.:$*>]/;

/** Reaction SMILES: reactants, agents, products, each a list of components. */
export interface Reaction {
  reactants: string[];
  /** Catalysts, solvents, conditions — empty for the usual `>>`. */
  agents: string[];
  products: string[];
}

/**
 * Split `reactants>agents>products`. Exactly two `>` separators: one is a
 * comparison, not a reaction, and RDKit rejects it too. Both ends must hold
 * something — `CCO>>` is a reaction with nothing made.
 */
export function splitReaction(text: string): Reaction | undefined {
  const parts = text.split(">");
  if (parts.length !== 3) return undefined;
  const [reactants, agents, products] = parts.map(components);
  if (reactants.length === 0 || products.length === 0) return undefined;
  return { reactants, agents, products };
}

/** `.` separates components within a side; `CCO..O` is just sloppy. */
function components(side: string): string[] {
  return side.split(".").filter((c) => c.length > 0);
}

/**
 * The occurrence of `needle` that `character` sits inside, as a whole token.
 * Returns `[start, end)`, or undefined. Searching afresh rather than pinning a
 * position is what makes a remembered molecule survive edits.
 */
export function tokenOccurrenceAt(
  line: string,
  character: number,
  needle: string
): [number, number] | undefined {
  if (!needle) return undefined;
  for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (character < i || character >= end) continue;
    if (SMILES_CHAR.test(line[i - 1] ?? "")) continue;
    if (SMILES_CHAR.test(line[end] ?? "")) continue;
    return [i, end];
  }
  return undefined;
}

/** Strip what a selection picks up: quotes, commas, escapes like `\n`. */
export function cleanSmiles(raw: string): string {
  let s = raw.trim();
  if (!s) return s;

  // Before the quotes, or a trailing comma hides the closing one.
  s = s.replace(/[,;]+$/, "");

  // Repeated, for `\"...\"` wrapping `"..."`.
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ['\\"', '\\"'],
    ["\\'", "\\'"],
  ];

  for (let pass = 0; pass < 3; pass++) {
    let stripped = false;
    for (const [open, close] of quotePairs) {
      if (
        s.startsWith(open) &&
        s.endsWith(close) &&
        s.length > open.length + close.length
      ) {
        s = s.slice(open.length, s.length - close.length);
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }

  // Leading junk.
  while (s.length > 0) {
    const lead = s.match(/^(?:\\[ntr\\"']|[=#$:./\\,;])/);
    if (!lead) break;
    s = s.slice(lead[0].length);
  }

  // Trailing junk.
  while (s.length > 0) {
    const tail = s.match(/(?:\\[ntr\\"']|[/\\.,;])$/);
    if (!tail) break;
    s = s.slice(0, s.length - tail[0].length);
  }

  return s.trim();
}
