import * as vscode from "vscode";
import { Detector } from "./detect";
import { serveOutputRenderer } from "./output-messaging";
import { SmilesRenderer } from "./renderer";
import { cleanSmiles, splitReaction, tokenOccurrenceAt } from "./smiles";

let renderer: SmilesRenderer;
let detector: Detector;

/**
 * A molecule the user rendered by hand. Keyed by the SMILES, not the place:
 * position is looked up fresh on each hover, so edits and repeats just work.
 */
interface RememberedMolecule {
  smiles: string;
  svg: string;
  expiresAt: number;
  /** Fallback for selections the text scan won't find: mid-token picks. */
  anchor: { uri: string; range: vscode.Range };
}

/** Oldest first. Pruned lazily on access, capped so a long session can't grow. */
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
  detector = new Detector(renderer);

  // Every document, whatever its scheme. Files and notebook cells are the
  // obvious ones, but SMILES turn up in read-only views nobody registers for:
  // tool and command output opened in a tab, diffs, the Output panel, a
  // notebook output expanded into its own editor. All are documents; naming
  // schemes one at a time only ever misses the next one.
  const hover = vscode.languages.registerHoverProvider("*", { provideHover });

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
      detector.schedule(0);
    }
  );

  const toggleCmd = vscode.commands.registerCommand(
    "smilesHover.toggleAutoDetect",
    async () => {
      const cfg = vscode.workspace.getConfiguration("smilesHover");
      const next = !cfg.get<boolean>("autoDetect", true);
      await cfg.update("autoDetect", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(
        `SMILES Hover: auto-detect ${next ? "on" : "off"}.`,
        3000
      );
    }
  );

  // Keep what's on screen already drawn. These fire in bursts; the detector
  // coalesces them.
  const rescan = [
    vscode.window.onDidChangeActiveTextEditor(() => detector.schedule(50)),
    vscode.window.onDidChangeVisibleTextEditors(() => detector.schedule(50)),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => detector.schedule()),
    vscode.window.onDidChangeActiveNotebookEditor(() => detector.schedule(50)),
    vscode.window.onDidChangeNotebookEditorVisibleRanges(() =>
      detector.schedule()
    ),
    // Cells added, removed or run: the sources around them have moved.
    vscode.workspace.onDidChangeNotebookDocument(() => detector.schedule()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isOnScreen(e.document)) detector.schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("smilesHover")) detector.schedule(0);
    }),
  ];

  context.subscriptions.push(
    hover,
    showCmd,
    clearCmd,
    toggleCmd,
    detector,
    serveOutputRenderer(renderer),
    ...rescan
  );

  detector.schedule(0);
}

export function deactivate(): void {}

/** Is this document one the user can currently see? Cells count. */
function isOnScreen(doc: vscode.TextDocument): boolean {
  if (vscode.window.visibleTextEditors.some((e) => e.document === doc)) {
    return true;
  }
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  return doc.uri.scheme === "vscode-notebook-cell" && !!notebook;
}

/** Auto-detection first, then anything rendered by hand. */
async function provideHover(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  cancel: vscode.CancellationToken
): Promise<vscode.Hover | undefined> {
  const detected = await detector.moleculeAt(doc, pos);
  if (cancel.isCancellationRequested) return;

  if (detected) {
    try {
      const svg = await renderer.render(detected.smiles);
      if (cancel.isCancellationRequested) return;
      return new vscode.Hover(
        moleculeMarkdown(detected.smiles, svg),
        detected.range
      );
    } catch {
      // Parses but won't draw; a remembered entry may still cover it.
    }
  }

  return rememberedHover(doc, pos);
}

/** A molecule the user rendered by hand, re-located by its text. */
function rememberedHover(
  doc: vscode.TextDocument,
  pos: vscode.Position
): vscode.Hover | undefined {
  const entries = live();
  if (entries.length === 0) return;

  const line = doc.lineAt(pos.line).text;

  // Longest match wins; entries are newest first, so ties go to the recent one.
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
    // Fall back to where it was rendered, if that text still says the same.
    hit = entries.find(
      (e) =>
        e.anchor.uri === doc.uri.toString() &&
        e.anchor.range.contains(pos) &&
        cleanSmiles(doc.getText(e.anchor.range)) === e.smiles
    );
    if (!hit) return;
    range = hit.anchor.range;
  }

  return new vscode.Hover(moleculeMarkdown(hit.smiles, hit.svg), range);
}

function moleculeMarkdown(smiles: string, svg: string): vscode.MarkdownString {
  const dataUri =
    "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

  const label = splitReaction(smiles) ? "Reaction" : "SMILES";
  const md = new vscode.MarkdownString();
  md.supportHtml = false;
  md.appendMarkdown(`**${label}** \`${escapeMd(smiles)}\`\n\n`);
  md.appendMarkdown(`![molecule](${dataUri})`);
  return md;
}

/** SMILES never span lines, so the cursor's line is the search space. */
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

  // Not a molecule isn't an error worth a dialog — it's just a selection.
  if (!(await renderer.isValid(smiles))) {
    vscode.window.setStatusBarMessage(
      `SMILES Hover: not a SMILES — ${truncate(smiles, 40)}`,
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
