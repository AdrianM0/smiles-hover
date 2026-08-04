/**
 * Clean a user-selected string into something we can hand to RDKit.
 *
 * When users select SMILES from JSON/JSONL/log dumps, the selection often
 * picks up extra junk: surrounding quotes, trailing commas, escape
 * sequences like `\n` or `\"`. We strip that lot before sending to the
 * renderer.
 *
 * What gets stripped:
 *   - Surrounding whitespace
 *   - Surrounding quotes (single, double, backtick)
 *   - Leading/trailing escape sequences (\n, \t, \r, \\, \", \')
 *   - Trailing punctuation that can't end a SMILES (, ; comma, semicolon)
 *   - Dangling bond-direction operators (lone trailing / or \)
 *   - Leading bond operators (= # $ : . — none can start a valid SMILES)
 *
 * What we don't do: validate the result. That's RDKit's job and the user
 * gets a clean error message if it fails.
 */
/**
 * Characters that can be part of a SMILES token. Used to reject matches that
 * are only a fragment of a longer run of text: `CCO` shouldn't match inside
 * `CCOCC` (a different molecule) or inside the word `Cocoa`. SMILES in the
 * wild sit inside quotes, whitespace or delimiters, all outside this class.
 */
export const SMILES_CHAR = /[A-Za-z0-9@+\-[\]()\\/#=%.:$*]/;

/**
 * Find the occurrence of `needle` in `line` that `character` sits inside, as a
 * whole delimited token. Returns its `[start, end)` offsets, or undefined.
 *
 * This is how a remembered molecule is re-located on hover: the SMILES string
 * is searched for afresh rather than being pinned to the position it was
 * rendered at, so it survives edits and matches every occurrence.
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

export function cleanSmiles(raw: string): string {
  let s = raw.trim();
  if (!s) return s;

  // First pass: strip outer trailing commas/semicolons that prevent quote
  // pairs from being detected as a pair.
  s = s.replace(/[,;]+$/, "");

  // Outer quote pairs (repeated, in case of `\"...\"` wrapping `"..."`).
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

  // Iteratively strip leading garbage.
  while (s.length > 0) {
    const lead = s.match(/^(?:\\[ntr\\"']|[=#$:./\\,;])/);
    if (!lead) break;
    s = s.slice(lead[0].length);
  }

  // Iteratively strip trailing garbage.
  while (s.length > 0) {
    const tail = s.match(/(?:\\[ntr\\"']|[/\\.,;])$/);
    if (!tail) break;
    s = s.slice(0, s.length - tail[0].length);
  }

  return s.trim();
}
