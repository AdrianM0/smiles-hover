import { SMILES_CHAR } from "./smiles";

/**
 * How strongly the surrounding text vouches for a token. Short featureless
 * strings need vouching for: `ISC`, `CSS`, `CNN` and `SNP` all parse as
 * molecules and none are meant as one.
 */
export type Context =
  /** After a `smiles:` key, alone on its line, or in a file with a SMILES column. */
  | "declared"
  /** A quoted string or a CSV/TSV cell. */
  | "field"
  /** Running text or an expression. */
  | "prose";

export interface Candidate {
  text: string;
  /** Offsets into the line, `[start, end)`. */
  start: number;
  end: number;
  context: Context;
}

/** Lines longer than this are minified data, not something a human hovers. */
const MAX_LINE = 2000;

/** Punctuation that can't begin or end a SMILES, so it must be sentence noise. */
const LEADING_JUNK = /^[=#$:.,;/\\%@+\-*)]/;
const TRAILING_JUNK = /[=#$:.,;/\\%@+\-*(]$/;

const QUOTES = "\"'`“”‘’";
const SEPARATORS = "\t,;|";

/** Anything that tells a structure from an acronym. */
const STRUCTURAL = /[()[\]=#@/\\1-9]|Cl|Br|[bcnops]/;

/**
 * Split a line into SMILES-shaped tokens: runs of SMILES characters, with the
 * edges trimmed of characters that can't legally sit there.
 */
export function findCandidates(
  line: string,
  minLength = 4,
  /** The file's header row names a SMILES column. */
  declaredFile = false
): Candidate[] {
  if (line.length === 0 || line.length > MAX_LINE) return [];

  const keyed = declaredFile || hasSmilesKey(line);
  const out: Candidate[] = [];

  let i = 0;
  while (i < line.length) {
    if (!SMILES_CHAR.test(line[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < line.length && SMILES_CHAR.test(line[end])) end++;

    const trimmed = trimToken(line, i, end);
    if (trimmed) {
      const text = line.slice(trimmed[0], trimmed[1]);
      const context = keyed
        ? "declared"
        : contextOf(line, trimmed[0], trimmed[1]);
      if (isPlausible(text, context, minLength)) {
        out.push({ text, start: trimmed[0], end: trimmed[1], context });
      }
    }
    i = end;
  }
  return out;
}

/** The candidate the cursor sits inside, longest first when they nest. */
export function candidateAt(
  line: string,
  character: number,
  minLength = 4,
  declaredFile = false
): Candidate | undefined {
  let best: Candidate | undefined;
  for (const c of findCandidates(line, minLength, declaredFile)) {
    if (character < c.start || character >= c.end) continue;
    if (!best || c.text.length > best.text.length) best = c;
  }
  return best;
}

/** Narrow the token past characters the surrounding text left on it. */
function trimToken(
  line: string,
  start: number,
  end: number
): [number, number] | undefined {
  let s = start;
  let e = end;

  for (let pass = 0; pass < 8; pass++) {
    const before = `${s}:${e}`;
    while (s < e && LEADING_JUNK.test(line[s])) s++;
    while (s < e && TRAILING_JUNK.test(line[e - 1])) e--;

    // Brackets from the surrounding text: `(CCO` in `(CCO and`, `CCO)` in
    // `(see CCO)`. Only ever drop the unmatched one.
    const text = line.slice(s, e);
    if (count(text, ")") > count(text, "(") && line[e - 1] === ")") e--;
    else if (count(text, "(") > count(text, ")") && line[s] === "(") s++;

    if (count(text, "]") > count(text, "[") && line[e - 1] === "]") e--;
    else if (count(text, "[") > count(text, "]") && line[s] === "[") s++;

    // Square brackets around the whole token — a markdown link, an array
    // literal. A real bracket atom holds one atom, never a branch or a bond.
    // `[Na+].[Cl-]` merely starts and ends with brackets, hence the indexOf.
    if (
      line[s] === "[" &&
      line.indexOf("]", s + 1) === e - 1 &&
      /[()=#.]/.test(line.slice(s + 1, e - 1))
    ) {
      s++;
      e--;
    }

    if (`${s}:${e}` === before) break;
  }

  return s < e ? [s, e] : undefined;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Does the line say the value is a SMILES — `smiles: x`, `"SMILES" = x`, or a
 * call that takes one? No word boundary in front, so `MolFromSmiles("CCO")`,
 * the most-typed line in any chemistry notebook, counts.
 */
function hasSmilesKey(line: string): boolean {
  return /smiles["'`\]]*\s*[:=(]/i.test(line);
}

/**
 * Does this header row name a SMILES column? A CSV of molecules says so once,
 * at the top; one line of context then vouches for every bare cell below it.
 */
export function declaresSmilesColumn(headerLine: string): boolean {
  if (headerLine.length > MAX_LINE) return false;
  // Two or more spaces is a column gutter — that's how printed DataFrames and
  // aligned tables separate fields, where a CSV would use a comma.
  const fields = headerLine.split(/[\t,;|]|\s{2,}/);
  if (fields.length < 2) return false;
  // A whole field that is the word, give or take a qualifier:
  // `canonical_smiles`, `"smiles"`.
  return fields.some((f) =>
    /^["'`\s]*\w*[_ ]?smiles?[_ ]?\w*["'`\s]*$/i.test(f)
  );
}

/**
 * Does a block of text — a cell output, a table — announce SMILES anywhere in
 * it? Output is walked a text node at a time, so a column header and its
 * values never share a line; this is what carries the header's promise down
 * to the cells.
 */
export function blockDeclaresSmiles(text: string): boolean {
  return text
    .split("\n", MAX_DECLARING_LINES)
    .some(
      (line) =>
        declaresSmilesColumn(line) || /^\s*["']?smiles?["']?\s*$/i.test(line)
    );
}

/** A header is near the top, or it isn't a header. */
const MAX_DECLARING_LINES = 40;

function contextOf(line: string, start: number, end: number): Context {
  const prev = lastSignificant(line.slice(0, start));
  const next = firstSignificant(line.slice(end));

  // Alone on its line — a .smi file, or a scratch buffer.
  if (prev === undefined && next === undefined) return "declared";

  if (prev && QUOTES.includes(prev) && next && QUOTES.includes(next)) {
    return "field";
  }
  // A whole cell: separator or line edge on both sides. Whitespace alone
  // doesn't count — that's prose, where the strict rules belong.
  const prevOk = prev === undefined || SEPARATORS.includes(prev);
  const nextOk = next === undefined || SEPARATORS.includes(next);
  return prevOk && nextOk ? "field" : "prose";
}

// Look past plain spaces but not past tabs: a tab is itself a field separator.
function lastSignificant(s: string): string | undefined {
  return s.match(/([^ ]) *$/)?.[1];
}

function firstSignificant(s: string): string | undefined {
  return s.match(/^ *([^ ])/)?.[1];
}

/** Is this token worth handing to RDKit? */
function isPlausible(
  text: string,
  context: Context,
  minLength: number
): boolean {
  if (!/[A-Za-z]/.test(text)) return false; // needs at least one atom
  if (!syntaxOk(text)) return false;
  if (context === "declared") return true;

  if (text.length < minLength) return false;
  if (STRUCTURAL.test(text)) return true;

  // Letters only, no structure. Fine in a column; in prose it's an acronym
  // until it's longer than anyone abbreviates — decane is `CCCCCCCCCC`.
  return context === "field" || text.length >= 8;
}

/** Elements writable without brackets, longest symbol first. */
const ORGANIC_SUBSET = ["Cl", "Br", "B", "C", "N", "O", "P", "S", "F", "I"];
const AROMATIC = "bcnops";
const OPERATORS = "()=#-+/\\.:$*~@";

/**
 * Could this be SMILES at all, by the grammar's character rules? Outside
 * square brackets only ten element symbols are legal and only six letters may
 * be lowercase, which rules out essentially every English word — and so keeps
 * hundreds of tokens a screenful from waking RDKit to be told the obvious.
 */
function syntaxOk(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Bracket atoms may say anything ([Na+], [C@@H], [13C]); leave them to the
    // parser.
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close === -1) return false;
      i = close + 1;
      continue;
    }

    const element = ORGANIC_SUBSET.find((sym) => text.startsWith(sym, i));
    if (element) {
      i += element.length;
    } else if (AROMATIC.includes(ch) || OPERATORS.includes(ch)) {
      i++;
    } else if (ch >= "0" && ch <= "9") {
      i++;
    } else if (ch === "%") {
      if (!/^\d\d/.test(text.slice(i + 1))) return false; // ring closure
      i += 3;
    } else {
      return false;
    }
  }
  return true;
}
