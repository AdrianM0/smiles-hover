import { SMILES_CHAR, splitReaction } from "./smiles";

/**
 * How strongly the text vouches for a token. `ISC`, `CSS`, `CNN` and `SNP` all
 * parse as molecules and none are meant as one, so short ones need vouching.
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
const LEADING_JUNK = /^[=#$:.,;/\\%@+\-*)>]/;
const TRAILING_JUNK = /[=#$:.,;/\\%@+\-*(>]$/;

const QUOTES = "\"'`“”‘’";
const SEPARATORS = "\t,;|";

/** Anything that tells a structure from an acronym. */
const STRUCTURAL = /[()[\]=#@/\\1-9]|Cl|Br|[bcnops]/;

/** Runs of SMILES characters, edges trimmed of what can't legally sit there. */
export function findCandidates(
  line: string,
  minLength = 4,
  /** The file's header row names a SMILES column. */
  declaredFile = false
): Candidate[] {
  if (line.length === 0 || line.length > MAX_LINE) return [];

  const keyed = declaredFile || hasSmilesKey(line);
  const out: Candidate[] = [];

  /** Take this span if it holds a molecule. Says whether it did. */
  const consider = (start: number, stop: number): boolean => {
    const trimmed = trimToken(line, start, stop);
    if (!trimmed) return false;
    const text = line.slice(trimmed[0], trimmed[1]);
    const context = keyed ? "declared" : contextOf(line, trimmed[0], trimmed[1]);
    if (!isPlausible(text, context, minLength)) return false;
    out.push({ text, start: trimmed[0], end: trimmed[1], context });
    return true;
  };

  let i = 0;
  while (i < line.length) {
    if (!SMILES_CHAR.test(line[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < line.length && SMILES_CHAR.test(line[end])) end++;

    const run = line.slice(i, end);
    // A run holding `>` is a reaction or it isn't. When it isn't, the `>` came
    // from the text around it — a tag, a shell redirect — so the molecules on
    // either side are still molecules: `<span>CC(=O)O</span>`.
    if (!consider(i, end) && run.includes(">")) {
      let at = i;
      for (const segment of run.split(">")) {
        consider(at, at + segment.length);
        at += segment.length + 1;
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

    // Brackets from the text around it — only drop the unmatched one.
    const text = line.slice(s, e);
    if (count(text, ")") > count(text, "(") && line[e - 1] === ")") e--;
    else if (count(text, "(") > count(text, ")") && line[s] === "(") s++;

    if (count(text, "]") > count(text, "[") && line[e - 1] === "]") e--;
    else if (count(text, "[") > count(text, "]") && line[s] === "[") s++;

    // Brackets wrapping the whole token — a markdown link, an array literal.
    // A bracket atom holds one atom; `[Na+].[Cl-]` merely starts with one.
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
 * `smiles: x`, `"SMILES" = x`, or a call taking one. No word boundary in
 * front, so `MolFromSmiles("CCO")` counts.
 */
function hasSmilesKey(line: string): boolean {
  return /smiles["'`\]]*\s*[:=(]/i.test(line);
}

/** A CSV says `smiles` once, at the top, and vouches for every cell below. */
export function declaresSmilesColumn(headerLine: string): boolean {
  if (headerLine.length > MAX_LINE) return false;
  // Two or more spaces is a column gutter, as printed DataFrames use.
  const fields = headerLine.split(/[\t,;|]|\s{2,}/);
  if (fields.length < 2) return false;
  // A whole field that is the word: `canonical_smiles`, `"smiles"`.
  return fields.some((f) =>
    /^["'`\s]*\w*[_ ]?smiles?[_ ]?\w*["'`\s]*$/i.test(f)
  );
}

/**
 * Same, for a whole block. Output is walked a text node at a time, so a header
 * and its values never share a line.
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

  // A reaction vouches for itself: two `>` separators with molecules either
  // side is a shape nothing else in a source file has, however short.
  if (text.includes(">")) return isReactionShaped(text);

  if (!syntaxOk(text)) return false;
  if (context === "declared") return true;

  if (text.length < minLength) return false;
  if (STRUCTURAL.test(text)) return true;

  // Letters only: an acronym in prose until longer than anyone abbreviates.
  return context === "field" || text.length >= 8;
}

/** Every component of every side parses as SMILES, and there is a component. */
function isReactionShaped(text: string): boolean {
  const rxn = splitReaction(text);
  if (!rxn) return false;
  return [...rxn.reactants, ...rxn.agents, ...rxn.products].every(
    (part) => /[A-Za-z]/.test(part) && syntaxOk(part)
  );
}

/** Elements writable without brackets, longest symbol first. */
const ORGANIC_SUBSET = ["Cl", "Br", "B", "C", "N", "O", "P", "S", "F", "I"];
const AROMATIC = "bcnops";
const OPERATORS = "()=#-+/\\.:$*~@";

/**
 * Could this be SMILES at all? Outside brackets only ten element symbols are
 * legal and six letters may be lowercase — which excludes English, and so
 * keeps hundreds of tokens a screenful from waking RDKit.
 */
function syntaxOk(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Bracket atoms may say anything; leave them to the parser.
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
