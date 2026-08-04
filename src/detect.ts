import * as vscode from "vscode";
import { SmilesRenderer } from "./renderer";
import { candidateAt, declaresSmilesColumn, findCandidates } from "./scan";

/**
 * Finds the SMILES on screen and gets them drawn before anyone hovers them.
 *
 * Nothing is stored per document — scanning warms the renderer's caches, which
 * are keyed by the string itself, so edits and scrolling need no invalidation
 * and a hover on unscanned text still works, just a beat slower.
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
  schedule(editor: vscode.TextEditor | undefined, delayMs = 250): void {
    if (this.timer) clearTimeout(this.timer);
    if (!editor || !config().autoDetect) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan(editor);
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

  /**
   * Validate and draw everything in view, plus a margin so a small scroll
   * lands on warm ground. Yields between molecules to keep the host free.
   */
  private async scan(editor: vscode.TextEditor): Promise<void> {
    const cfg = config();
    const mine = ++this.generation;
    const doc = editor.document;
    const declared = hasSmilesHeader(doc);

    const candidates = new Set<string>();
    for (const range of editor.visibleRanges) {
      const first = Math.max(0, range.start.line - cfg.margin);
      const last = Math.min(doc.lineCount - 1, range.end.line + cfg.margin);
      for (let n = first; n <= last; n++) {
        const line = doc.lineAt(n).text;
        for (const c of findCandidates(line, cfg.minLength, declared)) {
          candidates.add(c.text);
        }
        if (candidates.size >= cfg.maxCandidates) break;
      }
      if (candidates.size >= cfg.maxCandidates) break;
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

/** Checked on the first few lines, so a comment doesn't hide the header. */
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
