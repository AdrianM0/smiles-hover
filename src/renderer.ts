import * as path from "path";
import * as vscode from "vscode";
import { Reaction, splitReaction } from "./smiles";

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

    // A reaction is valid when its components are. MinimalLib's own reaction
    // drawing is unusable here — see drawReaction — so it never sees one.
    const rxn = splitReaction(smiles);
    if (rxn) {
      for (const part of componentsOf(rxn)) {
        if (await this.isValid(part)) continue;
        // An unremembered `false` means RDKit never answered; don't remember
        // this reaction as bad on the strength of that.
        if (this.validity.get(part) === false) this.validity.set(smiles, false);
        return false;
      }
      this.validity.set(smiles, true);
      return true;
    }

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
    const maxH = cfg.get<number>("maxHoverHeight", 190);

    const cacheKey = `${smiles}::${width}x${height}::${preset}::${autoSize}::${maxW}x${maxH}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.error) throw new Error(cached.error);
      return cached.svg!;
    }

    try {
      const rxn = splitReaction(smiles);
      const drawn = rxn
        ? await this.drawReaction(rxn, width, height, preset, autoSize)
        : cropToInk(await this.draw(smiles, width, height, preset, autoSize));
      const svg = fitForHover(drawn, maxW, maxH);
      this.cache.set(cacheKey, { svg });
      return svg;
    } catch (err) {
      const msg = (err as Error).message;
      this.cache.set(cacheKey, { error: msg });
      throw err;
    }
  }

  /**
   * A reaction, drawn a component at a time and laid out here.
   *
   * MinimalLib does expose `get_rxn`, but its drawing is no use: every
   * structure comes out grey whatever the palette, and the arrow's coordinates
   * are `-nan` in this build, so nothing points anywhere. Composing our own
   * from the molecule drawings costs a layout pass and gives reactions the
   * same styling, colours and line weight as everything else.
   */
  private async drawReaction(
    rxn: Reaction,
    width: number,
    height: number,
    preset: string,
    autoSize: boolean
  ): Promise<string> {
    // Components are drawn smaller than a lone molecule: a reaction is several
    // structures wide and the whole row still has to fit a hover.
    const piece = async (smiles: string, maxW: number, maxH: number) => {
      try {
        const raw = await this.draw(
          smiles,
          width * COMPONENT_SCALE,
          height * COMPONENT_SCALE,
          preset,
          autoSize
        );
        return measure(cropToInk(raw), maxW, maxH);
      } catch {
        // Undrawable, which for a component usually means a condition rather
        // than a structure — `[H+]`. Chemists write those as text anyway.
        return textPiece(smiles);
      }
    };

    const row = (all: string[], maxW: number, maxH: number) =>
      Promise.all(all.map((s) => piece(s, maxW, maxH)));

    const [reactants, agents, products] = await Promise.all([
      row(rxn.reactants, MAX_COMPONENT_W, MAX_COMPONENT_H),
      row(rxn.agents, MAX_AGENT_W, MAX_AGENT_H),
      row(rxn.products, MAX_COMPONENT_W, MAX_COMPONENT_H),
    ]);

    return composeReaction(reactants, agents, products);
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
      const svg = mol.get_svg_with_highlights(
        JSON.stringify(drawOptions(w, h, preset))
      );
      // Anything RDKit strips every atom from — `[H+]`, `[H][H]` — lays out
      // with no extent and comes back as `nan` coordinates: a blank box.
      if (/\bnan\b/.test(svg)) throw new Error(`Nothing to draw: ${smiles}`);
      return svg;
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

/** Every structure in a reaction, in drawing order. */
function componentsOf(rxn: Reaction): string[] {
  return [...rxn.reactants, ...rxn.agents, ...rxn.products];
}

/** Reactions are drawn at this fraction of a lone molecule's scale. */
const COMPONENT_SCALE = 0.62;
const MAX_COMPONENT_W = 300;
const MAX_COMPONENT_H = 220;
const MAX_AGENT_W = 150;
const MAX_AGENT_H = 110;

/** A drawn structure and the size it is to be shown at. */
interface Piece {
  svg: string;
  w: number;
  h: number;
}

/** The intrinsic size of an RDKit SVG, from its root element. */
function svgSize(svg: string): [number, number] | undefined {
  const m = svg.match(
    /<svg[^>]*?\bwidth=['"](\d+(?:\.\d+)?)px['"]\s+height=['"](\d+(?:\.\d+)?)px['"]/
  );
  if (!m) return undefined;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  return w > 0 && h > 0 ? [w, h] : undefined;
}

/** Shrink a drawing to fit a box, keeping its viewBox so it scales, not crops. */
function measure(svg: string, maxW: number, maxH: number): Piece {
  const size = svgSize(svg);
  if (!size) return { svg, w: maxW, h: maxH };
  const [w, h] = size;
  const scale = Math.min(1, maxW / w, maxH / h);
  return { svg, w: Math.round(w * scale), h: Math.round(h * scale) };
}

/** A component shown as its own text, for the ones that don't draw. */
function textPiece(label: string): Piece {
  const size = 14;
  const w = Math.round(label.length * size * 0.62) + 10;
  const h = size + 10;
  const text =
    `<text x='${w / 2}' y='${h / 2}' text-anchor='middle' ` +
    `dominant-baseline='central' font-family='sans-serif' font-size='${size}' ` +
    `fill='${INK}'>${escapeXml(label)}</text>`;
  return {
    svg:
      `<svg xmlns='http://www.w3.org/2000/svg' width='${w}px' height='${h}px' ` +
      `viewBox='0 0 ${w} ${h}'>` +
      `<rect style='fill:#FFFFFF;stroke:none' width='${w}' height='${h}' x='0' y='0'/>` +
      `${text}</svg>`,
    w,
    h,
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const GAP = 12;
/** Room for the `+` between two components. */
const PLUS = 24;
const ARROW_MIN = 76;
/** Clear space either side of the arrow. */
const ARROW_PAD = 12;
/** Between the agents and the arrow they sit above. */
const AGENT_LIFT = 8;
const MARGIN = 6;

/**
 * Lay the components out in a row: reactants, arrow, products, `+` between
 * components and any agents riding above the arrow.
 *
 * Each drawing goes in as a nested `<svg>`, which is its own viewport: the
 * viewBox does the scaling, so the composite stays vector all the way down.
 */
function composeReaction(
  reactants: Piece[],
  agents: Piece[],
  products: Piece[]
): string {
  const rowW = (ps: Piece[]) =>
    ps.reduce((n, p) => n + p.w, 0) +
    Math.max(0, ps.length - 1) * (PLUS + GAP * 2);
  const rowH = (ps: Piece[]) => ps.reduce((n, p) => Math.max(n, p.h), 0);

  const agentsW =
    agents.reduce((n, p) => n + p.w, 0) + Math.max(0, agents.length - 1) * GAP;
  const agentsH = rowH(agents);
  const arrowLen = Math.max(ARROW_MIN, agentsW + 24);
  // The arrow sits on the centre line, so the agents above it set how tall the
  // arrow's half of the row has to be.
  const above = agentsH > 0 ? agentsH + AGENT_LIFT : 0;

  const height = Math.max(rowH(reactants), rowH(products), (above + 10) * 2);
  const width =
    rowW(reactants) + rowW(products) + arrowLen + ARROW_PAD * 2 + GAP * 2;
  const cy = MARGIN + height / 2;

  const out: string[] = [];
  let x = MARGIN;

  const placeRow = (ps: Piece[]) => {
    ps.forEach((p, i) => {
      out.push(placeSvg(p, x, cy - p.h / 2));
      x += p.w;
      if (i < ps.length - 1) {
        out.push(plusSign(x + GAP + PLUS / 2, cy));
        x += GAP * 2 + PLUS;
      }
    });
  };

  placeRow(reactants);
  x += ARROW_PAD + GAP;

  let ax = x + (arrowLen - agentsW) / 2;
  for (const agent of agents) {
    out.push(placeSvg(agent, ax, cy - AGENT_LIFT - agentsH / 2 - agent.h / 2));
    ax += agent.w + GAP;
  }
  out.push(arrow(x, cy, arrowLen));
  x += arrowLen + ARROW_PAD + GAP;

  placeRow(products);

  const w = Math.round(width + MARGIN * 2);
  const h = Math.round(height + MARGIN * 2);
  return [
    `<?xml version='1.0' encoding='UTF-8'?>`,
    `<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' version='1.1' width='${w}px' height='${h}px' viewBox='0 0 ${w} ${h}'>`,
    `<rect style='opacity:1.0;fill:#FFFFFF;stroke:none' width='${w}' height='${h}' x='0' y='0'> </rect>`,
    ...out,
    `</svg>`,
  ].join("\n");
}

/** A drawing as a nested viewport at (x, y), shown at the size it was given. */
function placeSvg(piece: Piece, x: number, y: number): string {
  return piece.svg
    .replace(/^\s*<\?xml[^>]*\?>\s*/, "")
    .replace(
      /<svg\b([^>]*)>/,
      (_all, attrs: string) =>
        `<svg x='${round(x)}' y='${round(y)}'${attrs
          .replace(/\bwidth=['"][\d.]+px['"]/, `width='${piece.w}px'`)
          .replace(/\bheight=['"][\d.]+px['"]/, `height='${piece.h}px'`)}>`
    );
}

const INK = "#333333";

function arrow(x: number, cy: number, length: number): string {
  const tip = round(x + length);
  const back = round(x + length - 10);
  return (
    `<path d='M ${round(x)},${round(cy)} L ${tip},${round(cy)}' ` +
    `style='fill:none;stroke:${INK};stroke-width:2px;stroke-linecap:butt'/>` +
    `<path d='M ${tip},${round(cy)} L ${back},${round(cy - 4.5)} ` +
    `L ${back},${round(cy + 4.5)} Z' style='fill:${INK};stroke:none'/>`
  );
}

function plusSign(x: number, cy: number): string {
  return (
    `<text x='${round(x)}' y='${round(cy)}' text-anchor='middle' ` +
    `dominant-baseline='central' font-family='sans-serif' font-size='20' ` +
    `fill='${INK}'>+</text>`
  );
}

function round(n: number): string {
  return n.toFixed(1);
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
