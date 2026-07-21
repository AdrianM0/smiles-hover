import * as path from "path";
import * as vscode from "vscode";

interface CacheEntry {
  svg?: string;
  error?: string;
}

/** Subset of the RDKit MinimalLib surface we use. */
interface RDKitMol {
  is_valid(): boolean;
  get_svg_with_highlights(details: string): string;
  delete(): void;
}

interface RDKitModule {
  version(): string;
  prefer_coordgen(yes: boolean): void;
  get_mol(smiles: string, details?: string): RDKitMol | null;
}

/**
 * Atom-number → [R, G, B] in [0, 1].
 * Atomic numbers: H=1, B=5, C=6, N=7, O=8, F=9, P=15, S=16, Cl=17, Br=35, I=53.
 */
type Palette = Record<number, [number, number, number]>;

const PRESETS: Record<string, Palette> = {
  // Inspired by the classic ChemDraw scheme: muted, print-friendly.
  chemdraw: {
    1: [0.4, 0.4, 0.4], // H
    5: [0.9, 0.55, 0.3], // B
    6: [0.1, 0.1, 0.1], // C
    7: [0.15, 0.3, 0.85], // N — deep blue
    8: [0.85, 0.15, 0.15], // O — crimson
    9: [0.2, 0.65, 0.3], // F — green
    15: [0.95, 0.55, 0.1], // P — orange
    16: [0.85, 0.7, 0.1], // S — gold
    17: [0.2, 0.65, 0.3], // Cl — green
    35: [0.55, 0.2, 0.1], // Br — dark brown-red
    53: [0.55, 0.1, 0.65], // I — purple
  },
  bright: {
    1: [0.55, 0.55, 0.55],
    5: [1.0, 0.65, 0.3],
    6: [0.0, 0.0, 0.0],
    7: [0.2, 0.3, 1.0],
    8: [1.0, 0.1, 0.1],
    9: [0.2, 0.85, 0.3],
    15: [1.0, 0.55, 0.0],
    16: [1.0, 0.85, 0.0],
    17: [0.2, 0.85, 0.3],
    35: [0.65, 0.16, 0.16],
    53: [0.58, 0.0, 0.83],
  },
  // Everything black. MinimalLib has no useBWAtomPalette(), so we spell it out
  // for the elements that would otherwise pick up a default colour.
  mono: {
    1: [0, 0, 0],
    5: [0, 0, 0],
    6: [0, 0, 0],
    7: [0, 0, 0],
    8: [0, 0, 0],
    9: [0, 0, 0],
    15: [0, 0, 0],
    16: [0, 0, 0],
    17: [0, 0, 0],
    35: [0, 0, 0],
    53: [0, 0, 0],
  },
};

export class SmilesRenderer {
  private cache = new Map<string, CacheEntry>();
  private rdkit: Promise<RDKitModule> | undefined;
  private vendorDir: string;

  constructor(extensionPath: string) {
    this.vendorDir = path.join(extensionPath, "vendor");
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Load the RDKit WASM module. Deferred until the first render so extension
   * startup stays cheap — the module is ~7 MB and takes a moment to
   * instantiate. Cached for the session.
   */
  private load(): Promise<RDKitModule> {
    if (!this.rdkit) {
      this.rdkit = (async () => {
        const jsPath = path.join(this.vendorDir, "RDKit_minimal.js");
        const wasmPath = path.join(this.vendorDir, "RDKit_minimal.wasm");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const initRDKitModule = require(jsPath);
        const mod: RDKitModule = await initRDKitModule({
          locateFile: () => wasmPath,
        });
        // CoordGen gives ChemDraw-like geometry; RDKit's default layout is
        // more utilitarian.
        mod.prefer_coordgen(true);
        return mod;
      })().catch((err: Error) => {
        // Don't cache a failed load — a reload might succeed.
        this.rdkit = undefined;
        throw new Error(`Failed to load RDKit: ${err.message}`);
      });
    }
    return this.rdkit;
  }

  /** Returns SVG string, or throws with a user-facing error message. */
  async render(smiles: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration("smilesHover");
    const width = cfg.get<number>("imageWidth", 500);
    const height = cfg.get<number>("imageHeight", 350);
    const preset = cfg.get<string>("colorPreset", "chemdraw");

    const cacheKey = `${smiles}::${width}x${height}::${preset}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.error) throw new Error(cached.error);
      return cached.svg!;
    }

    try {
      const svg = await this.draw(smiles, width, height, preset);
      this.cache.set(cacheKey, { svg });
      return svg;
    } catch (err) {
      const msg = (err as Error).message;
      this.cache.set(cacheKey, { error: msg });
      throw err;
    }
  }

  private async draw(
    smiles: string,
    width: number,
    height: number,
    preset: string
  ): Promise<string> {
    const rdkit = await this.load();

    let mol: RDKitMol | null = null;
    try {
      // MinimalLib returns null for bad input, but older builds throw — handle
      // both.
      mol = rdkit.get_mol(smiles);
    } catch {
      mol = null;
    }
    if (!mol || !mol.is_valid()) {
      mol?.delete();
      throw new Error(`Invalid SMILES: ${smiles}`);
    }

    try {
      return mol.get_svg_with_highlights(
        JSON.stringify(drawOptions(width, height, preset))
      );
    } finally {
      // WASM heap isn't garbage-collected for us.
      mol.delete();
    }
  }
}

/**
 * Drawing options approximating RDKit's ACS 1996 preset (which MinimalLib
 * doesn't expose) plus the on-screen tuning it needs: ACS bond widths are
 * calibrated for print density and read as spidery in a hover popup.
 */
function drawOptions(width: number, height: number, preset: string) {
  return {
    width,
    height,
    // Geometry/labelling in the ACS house style.
    explicitMethyl: true,
    multipleBondOffset: 0.18,
    addStereoAnnotation: true,
    // Bolder than ACS print defaults so the molecule pops on screen.
    bondLineWidth: 2.4,
    scaleBondWidth: true,
    minFontSize: 18,
    maxFontSize: 22,
    fixedFontSize: 20,
    annotationFontScale: 0.75,
    additionalAtomLabelPadding: 0.1,
    padding: 0.1,
    // White background reads as a paper document in both light and dark
    // editor themes.
    clearBackground: true,
    backgroundColour: [1.0, 1.0, 1.0, 1.0],
    atomColourPalette: PRESETS[preset] ?? PRESETS.chemdraw,
  };
}
