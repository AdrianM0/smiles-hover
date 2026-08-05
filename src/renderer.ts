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
  /** Not in every build; we only ever call it if it's there. */
  disable_logging?(): void;
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
  // MinimalLib has no useBWAtomPalette(), so spell it out.
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
  /** Which strings RDKit accepts. Asked far more often than anything is drawn. */
  private validity = new Map<string, boolean>();
  private rdkit: Promise<RDKitModule> | undefined;
  private vendorDir: string;

  constructor(extensionPath: string) {
    this.vendorDir = path.join(extensionPath, "vendor");
  }

  clearCache(): void {
    this.cache.clear();
    this.validity.clear();
  }

  /** Already-known verdicts, without loading RDKit or awaiting anything. */
  knownValid(smiles: string): boolean | undefined {
    return this.validity.get(smiles);
  }

  /** Does RDKit parse this as a molecule? Cached for the session. */
  async isValid(smiles: string): Promise<boolean> {
    const known = this.validity.get(smiles);
    if (known !== undefined) return known;

    let ok = false;
    try {
      const rdkit = await this.load();
      let mol: RDKitMol | null = null;
      try {
        mol = rdkit.get_mol(smiles);
        ok = !!mol && mol.is_valid() && mol.get_num_atoms() > 0;
      } catch {
        ok = false;
      } finally {
        mol?.delete();
      }
    } catch {
      // RDKit unavailable — don't remember that as "not a molecule".
      return false;
    }

    this.validity.set(smiles, ok);
    return ok;
  }

  /** Load RDKit. Deferred to the first render: ~7 MB, slow to instantiate. */
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
        mod.prefer_coordgen(true); // ChemDraw-like geometry
        // Auto-detection asks about tokens that aren't molecules. Expected.
        mod.disable_logging?.();
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
      const svg = fitForHover(cropToInk(raw), maxW, maxH);
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
      // MinimalLib returns null for bad input; older builds throw.
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
 * Crop the canvas to what was actually drawn.
 *
 * RDKit fits the structure into whatever canvas it's given, preserving aspect,
 * so the leftover is white bands: ethanol used 19% of its canvas, a straight
 * chain 3%. The drawing is untouched — only the viewBox moves — so the picture
 * arrives the same size with the emptiness gone.
 */
function cropToInk(svg: string, margin = 12): string {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Drawn elements only: the background rect spans the whole canvas.
  for (const el of svg.match(/<(?:path|ellipse|line|text)[^>]*>/g) ?? []) {
    for (const [, x, y] of el.matchAll(/(-?\d+\.?\d*)[, ](-?\d+\.?\d*)/g)) {
      const px = parseFloat(x);
      const py = parseFloat(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }
  if (!(maxX > minX && maxY > minY)) return svg;

  const x = Math.max(0, minX - margin);
  const y = Math.max(0, minY - margin);
  const w = Math.round(maxX - x + margin);
  const h = Math.round(maxY - y + margin);

  return (
    svg
      .replace(/\bwidth='[\d.]+px'/, `width='${w}px'`)
      .replace(/\bheight='[\d.]+px'/, `height='${h}px'`)
      .replace(/\bviewBox='[^']*'/, `viewBox='${x.toFixed(1)} ${y.toFixed(1)} ${w} ${h}'`)
      // The background rect covers the original canvas, which a tight drawing
      // can spill past — leaving the margin transparent. Move it to the crop.
      .replace(
        /(<rect[^>]*?)width='[\d.]+' height='[\d.]+' x='[-\d.]+' y='[-\d.]+'/,
        `$1width='${w}' height='${h}' x='${x.toFixed(1)}' y='${y.toFixed(1)}'`
      )
  );
}

/**
 * Shrink the SVG's *displayed* size to fit the hover, leaving the viewBox
 * alone. VS Code clips oversized markdown images rather than scaling them, and
 * since this is vector, the canvas can stay large — which is what keeps atom
 * labels from colliding — while the intrinsic size comes down.
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
  // Root width/height only — the viewBox stays, so it scales, not crops.
  return svg.replace(
    m[0],
    m[0]
      .replace(/\bwidth=['"][\d.]+px['"]/, `width='${dispW}px'`)
      .replace(/\bheight=['"][\d.]+px['"]/, `height='${dispH}px'`)
  );
}

/**
 * The layout's bounding box, in molfile units. Molblock atom lines are fixed
 * width — x, y, z in 10-char fields from line 4 — with the atom count in the
 * first 3 chars of the counts line.
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
 * A canvas sized to the layout, at a fixed number of pixels per bond.
 *
 * RDKit fits the structure to whatever canvas it's given and scales bond width
 * with it, so the canvas *is* the drawing scale. Sizing it by atom count blew
 * small molecules up to fill it — `[Xe][Xe]` drew a 10 px bar between two
 * label-sized specks, and ethanol wasn't far behind. Holding the scale fixed
 * keeps line weight and labels in proportion at every size; big molecules
 * still clamp to the maxima and shrink from there.
 */
function canvasFor(
  mol: RDKitMol,
  baseWidth: number,
  baseHeight: number
): [number, number] {
  const PX_PER_BOND = 96; // a bond is 1 unit long; tuned on caffeine
  const MIN_SIDE = 0.9; // so a flat or single-atom layout isn't a sliver
  const MIN_W = 120;
  const MIN_H = 90;
  const MAX_W = 820;
  const MAX_H = 620;

  const bbox = layoutBBox(mol.get_molblock());
  if (!bbox) return [baseWidth, baseHeight];

  // imageWidth/imageHeight stay meaningful: they scale the whole drawing.
  const unit = PX_PER_BOND * Math.sqrt((baseWidth * baseHeight) / (500 * 350));
  // No margin added here: RDKit fills whatever it's given, so extra room only
  // magnifies the drawing again. Its own `padding` reserves the edge.
  const side = (extent: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, Math.max(extent, MIN_SIDE) * unit)));

  return [side(bbox.w, MIN_W, MAX_W), side(bbox.h, MIN_H, MAX_H)];
}

/**
 * RDKit's ACS 1996 preset, which MinimalLib doesn't expose, plus screen
 * tuning — ACS bond widths are for print and read as spidery in a popup.
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
    // No fixedFontSize: it overlaps labels on anything dense. Scale, with a
    // floor that stays readable.
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
