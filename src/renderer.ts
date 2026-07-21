import * as path from "path";
import * as vscode from "vscode";

interface CacheEntry {
  svg?: string;
  error?: string;
}

/** Subset of the RDKit MinimalLib surface we use. */
interface RDKitMol {
  is_valid(): boolean;
  get_num_atoms(): number;
  get_molblock(): string;
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
    const autoSize = cfg.get<boolean>("autoSize", true);
    const maxW = cfg.get<number>("maxHoverWidth", 460);
    const maxH = cfg.get<number>("maxHoverHeight", 240);

    const cacheKey = `${smiles}::${width}x${height}::${preset}::${autoSize}::${maxW}x${maxH}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.error) throw new Error(cached.error);
      return cached.svg!;
    }

    try {
      const raw = await this.draw(smiles, width, height, preset, autoSize);
      const svg = fitForHover(raw, maxW, maxH);
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
    preset: string,
    autoSize: boolean
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
      const [w, h] = autoSize ? canvasFor(mol, width, height) : [width, height];
      return mol.get_svg_with_highlights(
        JSON.stringify(drawOptions(w, h, preset))
      );
    } finally {
      // WASM heap isn't garbage-collected for us.
      mol.delete();
    }
  }
}

/**
 * Shrink the SVG's *displayed* size to fit inside a hover popup, leaving the
 * viewBox alone.
 *
 * VS Code's hover widget is small — its max height is derived from the editor
 * height (roughly a quarter of it, with a floor around 250px), and markdown
 * images render at their intrinsic size. An image taller than that isn't
 * scaled to fit, it's clipped behind a scrollbar, so half the molecule
 * disappears.
 *
 * Because the render is vector, display size and render size are independent:
 * the canvas can stay large (which is what gives the layout room and keeps
 * atom labels from colliding) while the intrinsic width/height come down to
 * something the hover will actually show in full. Scaling is uniform, so the
 * aspect ratio survives.
 */
function fitForHover(svg: string, maxW: number, maxH: number): string {
  const m = svg.match(
    /<svg[^>]*?\bwidth=['"](\d+(?:\.\d+)?)px['"]\s+height=['"](\d+(?:\.\d+)?)px['"]/
  );
  if (!m) return svg; // unrecognised header — better to show it than mangle it

  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!(w > 0 && h > 0)) return svg;

  const scale = Math.min(1, maxW / w, maxH / h);
  if (scale >= 1) return svg;

  const dispW = Math.round(w * scale);
  const dispH = Math.round(h * scale);
  // Replace only the root element's width/height; the viewBox stays as-is so
  // the drawing scales rather than being cropped.
  return svg.replace(
    m[0],
    m[0]
      .replace(/\bwidth=['"][\d.]+px['"]/, `width='${dispW}px'`)
      .replace(/\bheight=['"][\d.]+px['"]/, `height='${dispH}px'`)
  );
}

/**
 * Measure the 2D layout's bounding box from the molblock RDKit generates.
 * Returns width/height in molfile coordinate units.
 *
 * Molblock atom lines are fixed-width: x, y, z each in a 10-char field,
 * starting at line 4 (0-indexed), with the atom count in the first 3 chars
 * of the counts line.
 */
function layoutBBox(molblock: string): { w: number; h: number } | undefined {
  const lines = molblock.split("\n");
  const numAtoms = parseInt(lines[3]?.slice(0, 3) ?? "", 10);
  if (!Number.isFinite(numAtoms) || numAtoms < 1) return undefined;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < numAtoms; i++) {
    const line = lines[4 + i];
    if (!line) return undefined;
    const x = parseFloat(line.slice(0, 10));
    const y = parseFloat(line.slice(10, 20));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { w: maxX - minX, h: maxY - minY };
}

/**
 * Pick a canvas that shows the whole structure at a legible scale.
 *
 * Two things go wrong with a fixed canvas. RDKit scales coordinates to fit
 * whatever it's given, so a big molecule isn't cropped — it's crushed, with
 * atom labels colliding into a pile. And a long thin molecule on a 10:7
 * canvas fits to width, wasting most of the height and shrinking the
 * structure for no reason.
 *
 * So: grow the *area* with the atom count (sub-linear, since 2D layouts
 * spread in both dimensions), and match the *aspect* to the actual layout.
 * Both are clamped — a popup shouldn't be taller than the editor, and
 * decane shouldn't render as a 15:1 ribbon.
 */
function canvasFor(
  mol: RDKitMol,
  baseWidth: number,
  baseHeight: number
): [number, number] {
  const REFERENCE_ATOMS = 16; // ~caffeine; what the defaults were tuned for
  const MAX_SCALE = 1.6;
  const MIN_ASPECT = 0.8;
  const MAX_ASPECT = 2.5;
  const MAX_W = 820;
  const MAX_H = 620;

  const scale = Math.min(
    MAX_SCALE,
    Math.max(1, Math.sqrt(mol.get_num_atoms() / REFERENCE_ATOMS))
  );
  const area = baseWidth * baseHeight * scale * scale;

  let aspect = baseWidth / baseHeight;
  const bbox = layoutBBox(mol.get_molblock());
  if (bbox && bbox.w > 0.01 && bbox.h > 0.01) {
    aspect = bbox.w / bbox.h;
  } else if (bbox && bbox.w > 0.01) {
    aspect = MAX_ASPECT; // perfectly linear layout, e.g. a short alkane
  }
  aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));

  const w = Math.min(MAX_W, Math.round(Math.sqrt(area * aspect)));
  const h = Math.min(MAX_H, Math.round(w / aspect));
  return [w, h];
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
    // No fixedFontSize: it pins labels at one size regardless of how dense
    // the structure is, so anything bigger than a drug fragment ends up with
    // labels overlapping the bonds. Let RDKit scale them to the drawing, with
    // a floor that keeps them readable.
    minFontSize: 12,
    maxFontSize: 22,
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
