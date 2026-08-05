import * as vscode from "vscode";
import { SmilesRenderer } from "./renderer";
import { candidateAt, declaresSmilesColumn, findCandidates } from "./scan";

/**
 * Draws the SMILES on screen before anyone hovers them. Nothing is stored per
 * document: scanning only warms caches keyed by the string, so edits need no
 * invalidation and an unscanned hover still works, a beat slower.
 */
export class Detector {
  /** Bumped on every new scan; in-flight work checks it and gives up. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly renderer: SmilesRenderer) {}

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.generation++;
  }

  /** Coalesce the bursts that scrolling and typing produce into one scan. */
  schedule(delayMs = 250): void {
    if (this.timer) clearTimeout(this.timer);
    if (!config().autoDetect) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan();
    }, delayMs);
  }

  /** The molecule at `pos`, or undefined if the text there isn't one. */
  async moleculeAt(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): Promise<{ smiles: string; range: vscode.Range } | undefined> {
    const cfg = config();
    if (!cfg.autoDetect) return undefined;
    if (pos.line >= doc.lineCount) return undefined;

    const found = candidateAt(
      doc.lineAt(pos.line).text,
      pos.character,
      cfg.minLength,
      hasSmilesHeader(doc)
    );
    if (!found) return undefined;
    if (!(await this.renderer.isValid(found.text))) return undefined;

    return {
      smiles: found.text,
      range: new vscode.Range(pos.line, found.start, pos.line, found.end),
    };
  }

  /** Validate and draw everything in view, yielding between molecules. */
  private async scan(): Promise<void> {
    const cfg = config();
    const mine = ++this.generation;

    const candidates = new Set<string>();
    outer: for (const { doc, first, last } of visibleRegions(cfg.margin)) {
      const declared = hasSmilesHeader(doc);
      for (let n = first; n <= last; n++) {
        const line = doc.lineAt(n).text;
        for (const c of findCandidates(line, cfg.minLength, declared)) {
          candidates.add(c.text);
        }
        if (candidates.size >= cfg.maxCandidates) break outer;
      }
    }

    let drawn = 0;
    for (const text of candidates) {
      if (mine !== this.generation) return; // superseded by a newer scan
      if (!(await this.renderer.isValid(text))) continue;
      if (drawn >= cfg.maxPrerender) continue; // known good, drawn on demand
      try {
        await this.renderer.render(text);
        drawn++;
      } catch {
        // Parses but won't draw — the hover reports that, not the scanner.
      }
      await tick();
    }
  }
}

interface Region {
  doc: vscode.TextDocument;
  first: number;
  last: number;
}

/**
 * The viewport plus a margin, so a small scroll lands on warm ground. In a
 * notebook: every visible cell, each its own document, taken whole.
 */
function visibleRegions(margin: number): Region[] {
  const notebook = vscode.window.activeNotebookEditor;
  if (notebook) {
    const cells = notebook.notebook.getCells();
    const out: Region[] = [];
    for (const range of notebook.visibleRanges) {
      const first = Math.max(0, range.start - CELL_MARGIN);
      const last = Math.min(cells.length - 1, range.end + CELL_MARGIN);
      for (let i = first; i <= last; i++) {
        const doc = cells[i].document;
        out.push({ doc, first: 0, last: Math.min(doc.lineCount, MAX_CELL) - 1 });
      }
    }
    return out;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) return [];
  const doc = editor.document;
  return editor.visibleRanges.map((range) => ({
    doc,
    first: Math.max(0, range.start.line - margin),
    last: Math.min(doc.lineCount - 1, range.end.line + margin),
  }));
}

/** Cells either side of the visible ones, and lines taken from each cell. */
const CELL_MARGIN = 2;
const MAX_CELL = 500;

/** First few lines, so a comment doesn't hide the header. */
function hasSmilesHeader(doc: vscode.TextDocument): boolean {
  const limit = Math.min(doc.lineCount, 3);
  for (let line = 0; line < limit; line++) {
    if (declaresSmilesColumn(doc.lineAt(line).text)) return true;
  }
  return false;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function config() {
  const cfg = vscode.workspace.getConfiguration("smilesHover");
  return {
    autoDetect: cfg.get<boolean>("autoDetect", true),
    minLength: Math.max(1, cfg.get<number>("autoDetectMinLength", 4)),
    maxPrerender: Math.max(0, cfg.get<number>("maxPrerender", 40)),
    /** Extra lines scanned above and below the viewport. */
    margin: 60,
    /** Hard ceiling on tokens examined per scan. */
    maxCandidates: 600,
  };
}
