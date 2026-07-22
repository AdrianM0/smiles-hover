import * as vscode from "vscode";
import { SmilesRenderer } from "./renderer";
import { cleanSmiles } from "./smiles";

let renderer: SmilesRenderer;

/**
 * A rendered molecule anchored to the selection the user invoked the command
 * on. Kept around after the hover closes so the same span stays hoverable.
 */
interface ShownMolecule {
  range: vscode.Range;
  smiles: string;
  svg: string;
  expiresAt: number;
}

/**
 * Molecules shown per document, newest last. Entries expire on their own TTL;
 * we prune lazily on access rather than running a timer, and cap each document
 * so a long session can't grow the SVGs without bound.
 */
const shown = new Map<string, ShownMolecule[]>();

const MAX_PER_DOC = 64;

function retentionMs(): number {
  const minutes = vscode.workspace
    .getConfiguration("smilesHover")
    .get<number>("retentionMinutes", 15);
  return Math.max(0, minutes) * 60_000;
}

/** Drop expired entries; returns the surviving list (undefined if none). */
function live(uri: string): ShownMolecule[] | undefined {
  const entries = shown.get(uri);
  if (!entries) return;
  const now = Date.now();
  const kept = entries.filter((e) => e.expiresAt > now);
  if (kept.length === 0) {
    shown.delete(uri);
    return;
  }
  if (kept.length !== entries.length) shown.set(uri, kept);
  return kept;
}

export function activate(context: vscode.ExtensionContext): void {
  renderer = new SmilesRenderer(context.extensionPath);

  // Hover provider is *passive* — it only returns content for a span the user
  // has explicitly rendered, and only while that render is still remembered.
  // No guessing whether a token is a SMILES.
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
      shown.clear();
      vscode.window.showInformationMessage("SMILES Hover: cache cleared.");
    }
  );

  // Nothing to re-hover in a document that's gone.
  const closed = vscode.workspace.onDidCloseTextDocument((doc) =>
    shown.delete(doc.uri.toString())
  );

  context.subscriptions.push(hover, showCmd, clearCmd, closed);
}

export function deactivate(): void {}

/**
 * Hover provider — only returns a molecule the user has already asked for at
 * this position, and only while it's still current. Otherwise silent.
 */
function provideHover(
  doc: vscode.TextDocument,
  pos: vscode.Position
): vscode.Hover | undefined {
  const entries = live(doc.uri.toString());
  if (!entries) return;

  // Newest first: a re-render of the same span wins over an older one. The
  // text check keeps a stale entry quiet after an edit shifts or rewrites the
  // span it was anchored to.
  const hit = [...entries]
    .reverse()
    .find(
      (e) =>
        e.range.contains(pos) && cleanSmiles(doc.getText(e.range)) === e.smiles
    );
  if (!hit) return;

  const dataUri =
    "data:image/svg+xml;base64," +
    Buffer.from(hit.svg, "utf8").toString("base64");

  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.appendMarkdown(`**SMILES** \`${escapeMd(hit.smiles)}\`\n\n`);
  md.appendMarkdown(`![molecule](${dataUri})`);

  return new vscode.Hover(md, hit.range);
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

    remember(editor.document.uri.toString(), {
      range: new vscode.Range(sel.start, sel.end),
      smiles,
      svg,
      expiresAt: Date.now() + retentionMs(),
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

/**
 * Store a molecule for this document, replacing any entry covering the same
 * span so repeated renders don't pile up.
 */
function remember(uri: string, entry: ShownMolecule): void {
  const entries = (live(uri) ?? []).filter(
    (e) => !e.range.isEqual(entry.range)
  );
  entries.push(entry);
  shown.set(uri, entries.slice(-MAX_PER_DOC));
}

function escapeMd(s: string): string {
  return s.replace(/`/g, "\\`");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
