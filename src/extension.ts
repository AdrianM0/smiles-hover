import * as vscode from "vscode";
import { SmilesRenderer } from "./renderer";
import { cleanSmiles } from "./smiles";

let renderer: SmilesRenderer;

/**
 * A rendered molecule waiting to be shown in a hover, anchored to the
 * selection the user invoked the command on.
 */
interface PendingHover {
  uri: string;
  range: vscode.Range;
  smiles: string;
  svg: string;
  expiresAt: number;
}

let pending: PendingHover | undefined;

export function activate(context: vscode.ExtensionContext): void {
  renderer = new SmilesRenderer(context.extensionPath);

  // Hover provider is now *passive* — it only returns content when there's
  // a pending payload that matches the current cursor position. No more
  // guessing whether a token is a SMILES.
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
      vscode.window.showInformationMessage("SMILES Hover: cache cleared.");
    }
  );

  context.subscriptions.push(hover, showCmd, clearCmd);
}

export function deactivate(): void {}

/**
 * Hover provider — only returns the molecule when there's a pending render
 * matching the cursor's position. Otherwise silent.
 */
function provideHover(
  doc: vscode.TextDocument,
  pos: vscode.Position
): vscode.Hover | undefined {
  if (!pending) return;
  if (pending.uri !== doc.uri.toString()) return;
  if (Date.now() > pending.expiresAt) {
    pending = undefined;
    return;
  }
  if (!pending.range.contains(pos)) return;

  const dataUri =
    "data:image/svg+xml;base64," +
    Buffer.from(pending.svg, "utf8").toString("base64");

  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.appendMarkdown(`**SMILES** \`${escapeMd(pending.smiles)}\`\n\n`);
  md.appendMarkdown(`![molecule](${dataUri})`);

  return new vscode.Hover(md, pending.range);
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

    pending = {
      uri: editor.document.uri.toString(),
      range: sel,
      smiles,
      svg,
      expiresAt: Date.now() + 60_000,
    };

    await vscode.commands.executeCommand("editor.action.showHover");
  } catch (err) {
    vscode.window.showErrorMessage(
      `SMILES Hover — could not render '${truncate(smiles, 40)}': ${
        (err as Error).message
      }`
    );
  }
}

function escapeMd(s: string): string {
  return s.replace(/`/g, "\\`");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
