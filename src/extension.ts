import * as vscode from "vscode";
import { SmilesRenderer } from "./renderer";
import { cleanSmiles, tokenOccurrenceAt } from "./smiles";

let renderer: SmilesRenderer;

/**
 * A molecule the user has rendered, kept so it can be hovered again.
 *
 * Keyed by the SMILES itself rather than by where it was rendered: the string
 * is the identity of the molecule, and the same string means the same picture
 * wherever it turns up. Position is looked up fresh on every hover instead of
 * being stored, so edits, moved lines and repeated occurrences all just work.
 */
interface RememberedMolecule {
  smiles: string;
  svg: string;
  expiresAt: number;
  /**
   * Where it was first rendered. A fallback for selections that aren't
   * delimited — a SMILES picked out of the middle of a longer token won't be
   * found by the text scan, but the user did explicitly render it there.
   */
  anchor: { uri: string; range: vscode.Range };
}

/**
 * Remembered molecules, oldest first (Map keeps insertion order). Entries
 * expire on their own TTL; we prune lazily on access rather than running a
 * timer, and cap the map so a long session can't hold SVGs without bound.
 */
const remembered = new Map<string, RememberedMolecule>();

const MAX_ENTRIES = 64;

function retentionMs(): number {
  const minutes = vscode.workspace
    .getConfiguration("smilesHover")
    .get<number>("retentionMinutes", 15);
  return Math.max(0, minutes) * 60_000;
}

/** Live entries, newest first, expired ones dropped. */
function live(): RememberedMolecule[] {
  const now = Date.now();
  const alive: RememberedMolecule[] = [];
  for (const [smiles, entry] of remembered) {
    if (entry.expiresAt > now) alive.push(entry);
    else remembered.delete(smiles);
  }
  return alive.reverse();
}

export function activate(context: vscode.ExtensionContext): void {
  renderer = new SmilesRenderer(context.extensionPath);

  // Hover provider is *passive* — it only returns content for a molecule the
  // user has explicitly rendered, and only while that render is still
  // remembered. No guessing whether a token is a SMILES.
  const hover = vscode.languages.registerHoverProvider(
    [{ scheme: "file" }, { scheme: "untitled" }],
    { provideHover }
  );

  const showCmd = vscode.commands.registerTextEditorCommand(
    "smilesHover.showSelection",
    showMoleculeForSelection
  );

  const clearCmd = vscode.commands.registerCommand(
    "smilesHover.clearCache",
    () => {
      renderer.clearCache();
      remembered.clear();
      vscode.window.showInformationMessage("SMILES Hover: cache cleared.");
    }
  );

  context.subscriptions.push(hover, showCmd, clearCmd);
}

export function deactivate(): void {}

/**
 * Hover provider — shows a remembered molecule when the cursor is on an
 * occurrence of its SMILES. Otherwise silent.
 */
function provideHover(
  doc: vscode.TextDocument,
  pos: vscode.Position
): vscode.Hover | undefined {
  const entries = live();
  if (entries.length === 0) return;

  const line = doc.lineAt(pos.line).text;

  // Longest match wins, so that hovering inside `CCO` while both `CCO` and
  // `CCOc1ccccc1` are remembered picks whichever one the cursor is actually
  // sitting in. Entries are newest first, so ties go to the recent render.
  let hit: RememberedMolecule | undefined;
  let range: vscode.Range | undefined;
  for (const entry of entries) {
    const found = occurrenceAt(line, pos, entry.smiles);
    if (found && (!range || entry.smiles.length > hit!.smiles.length)) {
      hit = entry;
      range = found;
    }
  }

  if (!hit) {
    // Nothing found by text; fall back to the spot it was rendered at, as long
    // as that text still says what it said then.
    hit = entries.find(
      (e) =>
        e.anchor.uri === doc.uri.toString() &&
        e.anchor.range.contains(pos) &&
        cleanSmiles(doc.getText(e.anchor.range)) === e.smiles
    );
    if (!hit) return;
    range = hit.anchor.range;
  }

  const dataUri =
    "data:image/svg+xml;base64," +
    Buffer.from(hit.svg, "utf8").toString("base64");

  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.appendMarkdown(`**SMILES** \`${escapeMd(hit.smiles)}\`\n\n`);
  md.appendMarkdown(`![molecule](${dataUri})`);

  return new vscode.Hover(md, range);
}

/**
 * Locate `smiles` on the cursor's line. SMILES never span lines, so that line
 * is the whole search space.
 */
function occurrenceAt(
  line: string,
  pos: vscode.Position,
  smiles: string
): vscode.Range | undefined {
  const found = tokenOccurrenceAt(line, pos.character, smiles);
  return found && new vscode.Range(pos.line, found[0], pos.line, found[1]);
}

async function showMoleculeForSelection(
  editor: vscode.TextEditor
): Promise<void> {
  const sel = editor.selection;
  if (sel.isEmpty) {
    vscode.window.setStatusBarMessage(
      "SMILES Hover: select a SMILES string first.",
      3000
    );
    return;
  }

  const raw = editor.document.getText(sel);
  const smiles = cleanSmiles(raw);
  if (!smiles) {
    vscode.window.setStatusBarMessage(
      "SMILES Hover: selection is empty after cleaning.",
      3000
    );
    return;
  }

  try {
    const svg = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Rendering ${truncate(smiles, 40)}`,
      },
      () => renderer.render(smiles)
    );

    remember({
      smiles,
      svg,
      expiresAt: Date.now() + retentionMs(),
      anchor: {
        uri: editor.document.uri.toString(),
        range: new vscode.Range(sel.start, sel.end),
      },
    });

    await vscode.commands.executeCommand("editor.action.showHover");
  } catch (err) {
    vscode.window.showErrorMessage(
      `SMILES Hover — could not render '${truncate(smiles, 40)}': ${
        (err as Error).message
      }`
    );
  }
}

/** Store a molecule, refreshing its TTL and recency if already known. */
function remember(entry: RememberedMolecule): void {
  remembered.delete(entry.smiles); // re-insert so it counts as newest
  remembered.set(entry.smiles, entry);
  for (const smiles of remembered.keys()) {
    if (remembered.size <= MAX_ENTRIES) break;
    remembered.delete(smiles); // oldest first
  }
}

function escapeMd(s: string): string {
  return s.replace(/`/g, "\\`");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
