/**
 * Build the README demo GIF: a mock VS Code window where a SMILES string is
 * selected, Ctrl+K M is pressed, and the molecule pops up in a hover.
 *
 * The molecules are rendered by the real extension renderer, not drawn by
 * hand, so the GIF shows exactly what users get.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { Resvg } = require("@resvg/resvg-js");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");

const EXT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "..", "images");

// ---------------------------------------------------------------- renderer
const settings = {
  imageWidth: 500,
  imageHeight: 350,
  colorPreset: "chemdraw",
  autoSize: true,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode-stub";
  return origResolve.call(this, request, ...rest);
};
require.cache["vscode-stub"] = {
  id: "vscode-stub",
  filename: "vscode-stub",
  loaded: true,
  exports: {
    workspace: { getConfiguration: () => ({ get: (k, d) => settings[k] ?? d }) },
  },
};
const { SmilesRenderer } = require(path.join(EXT, "out", "renderer.js"));

// ------------------------------------------------------------------ layout
const W = 760;
const H = 530;

const MONO = "DejaVu Sans Mono";
const UI = "DejaVu Sans";
const FS = 13; // code font size
const CW = FS * 0.6023; // DejaVu Sans Mono advance width
const LH = 21; // line height
const CODE_X = 62;
const CODE_Y = 74; // baseline of line 1
const TITLEBAR = 34;

// VS Code Dark+ palette
const C = {
  chrome: "#252526",
  bg: "#1e1e1e",
  gutter: "#858585",
  fg: "#d4d4d4",
  keyword: "#c586c0",
  ident: "#9cdcfe",
  string: "#ce9178",
  comment: "#6a9955",
  fn: "#dcdcaa",
  const: "#4fc1ff",
  sel: "#264f78",
  border: "#3c3c3c",
  accent: "#0e639c",
};

/** Code as [indent-preserved text, [[start, len, color], ...]] spans. */
const LINES = [
  ["from rdkit import Chem", [[0, 4, C.keyword], [5, 5, C.ident], [11, 6, C.keyword], [18, 4, C.ident]]],
  ["", []],
  ["LIGANDS = {", [[0, 7, C.const]]],
  ['    "caffeine": "CN1C=NC2=C1C(=O)N(C)C(=O)N2C",', [[4, 10, C.string], [16, 31, C.string]]],
  ['    "imatinib": "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1",', [[4, 10, C.string], [16, 61, C.string]]],
  ["}", []],
  ["", []],
  ["for name, smi in LIGANDS.items():", [[0, 3, C.keyword], [14, 2, C.keyword], [17, 7, C.const], [25, 5, C.fn]]],
  ["    mol = Chem.MolFromSmiles(smi)", [[10, 4, C.ident], [15, 13, C.fn]]],
];

// The two beats: which line, and the column span of the SMILES literal.
const SCENES = [
  { line: 3, col: 17, len: 29, smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C" },
  { line: 4, col: 17, len: 59, smiles: "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1" },
];

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function codeLine(text, spans, y) {
  // Draw base text, then colored spans on top of it, all monospaced so
  // per-character x positions line up.
  let out = `<text x="${CODE_X}" y="${y}" font-family="${MONO}" font-size="${FS}" fill="${C.fg}" xml:space="preserve">${esc(text)}</text>`;
  for (const [start, len, color] of spans) {
    const sub = text.slice(start, start + len);
    out += `<text x="${CODE_X + start * CW}" y="${y}" font-family="${MONO}" font-size="${FS}" fill="${color}" xml:space="preserve">${esc(sub)}</text>`;
  }
  return out;
}

/** One frame of the mock window. */
function frame({ scene, selChars = 0, keycap = 0, popup = 0, molSvg = null }) {
  const s = SCENES[scene];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;

  svg += `<rect width="${W}" height="${H}" rx="8" fill="${C.bg}"/>`;

  // Title bar
  svg += `<path d="M0 8a8 8 0 0 1 8-8h${W - 16}a8 8 0 0 1 8 8v${TITLEBAR - 8}H0z" fill="${C.chrome}"/>`;
  const dots = ["#ff5f57", "#febc2e", "#28c840"];
  dots.forEach((d, i) => {
    svg += `<circle cx="${20 + i * 17}" cy="${TITLEBAR / 2}" r="5.5" fill="${d}"/>`;
  });
  svg += `<text x="${W / 2}" y="${TITLEBAR / 2 + 4}" text-anchor="middle" font-family="${UI}" font-size="11.5" fill="#8a8a8a">screen.py</text>`;
  svg += `<rect x="0" y="${TITLEBAR}" width="${W}" height="1" fill="${C.border}"/>`;

  // Selection highlight — drawn under the text.
  if (selChars > 0) {
    const y = CODE_Y + s.line * LH;
    svg += `<rect x="${CODE_X + s.col * CW}" y="${y - FS + 1.5}" width="${selChars * CW}" height="${LH - 3}" fill="${C.sel}" rx="2"/>`;
  }

  // Gutter + code
  LINES.forEach(([text, spans], i) => {
    const y = CODE_Y + i * LH;
    svg += `<text x="46" y="${y}" text-anchor="end" font-family="${MONO}" font-size="${FS}" fill="${C.gutter}">${i + 1}</text>`;
    svg += codeLine(text, spans, y);
  });

  // Keycap badge
  if (keycap > 0) {
    const kx = W - 168;
    const ky = TITLEBAR + 14;
    svg += `<g opacity="${keycap.toFixed(2)}">`;
    svg += `<rect x="${kx}" y="${ky}" width="150" height="30" rx="6" fill="#2d2d30" stroke="${C.accent}" stroke-width="1.5"/>`;
    svg += `<text x="${kx + 75}" y="${ky + 20}" text-anchor="middle" font-family="${UI}" font-size="13" fill="#e8e8e8">Ctrl</text>`;
    svg += `</g>`;
    // Rendered as three keycaps for legibility.
    const caps = ["Ctrl", "K", "M"];
    let cx = kx + 10;
    svg += `<g opacity="${keycap.toFixed(2)}">`;
    svg += `<rect x="${kx}" y="${ky}" width="150" height="30" rx="6" fill="#2d2d30" stroke="${C.accent}" stroke-width="1.5"/>`;
    for (const cap of caps) {
      const cwid = cap.length > 1 ? 40 : 26;
      svg += `<rect x="${cx}" y="${ky + 5}" width="${cwid}" height="20" rx="4" fill="#3c3c3c" stroke="#555" stroke-width="0.8"/>`;
      svg += `<text x="${cx + cwid / 2}" y="${ky + 19}" text-anchor="middle" font-family="${UI}" font-size="11" fill="#e8e8e8">${cap}</text>`;
      cx += cwid + 8;
    }
    svg += `</g>`;
  }

  // Hover popup
  if (popup > 0 && molSvg) {
    // Mirror VS Code: the image goes in at its natural aspect, capped to a
    // sane popup width.
    const dim = molSvg.match(/width='(\d+)px' height='(\d+)px'/) ||
      molSvg.match(/width="(\d+)px" height="(\d+)px"/);
    const natW = dim ? +dim[1] : 500;
    const natH = dim ? +dim[2] : 350;
    const MW = 300;
    const MH = Math.round((MW * natH) / natW);
    const PAD = 10;
    const HEAD = 24;
    const pw = MW + PAD * 2;
    const ph = MH + HEAD + PAD * 2;
    const px = CODE_X + s.col * CW - 8;
    const py = CODE_Y + s.line * LH + 12;

    const scale = 0.94 + 0.06 * popup;
    const ox = px + (pw * (1 - scale)) / 2;
    const oy = py + 6 * (1 - popup);

    const b64 = Buffer.from(molSvg, "utf8").toString("base64");
    svg += `<g opacity="${popup.toFixed(2)}" transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)}) scale(${scale.toFixed(3)})">`;
    svg += `<rect x="2" y="4" width="${pw}" height="${ph}" rx="6" fill="#000" opacity="0.35"/>`;
    svg += `<rect x="0" y="0" width="${pw}" height="${ph}" rx="6" fill="#252526" stroke="#454545" stroke-width="1"/>`;
    svg += `<text x="${PAD}" y="${PAD + 12}" font-family="${UI}" font-size="10.5" fill="#9d9d9d">SMILES</text>`;
    svg += `<text x="${PAD + 46}" y="${PAD + 12}" font-family="${MONO}" font-size="10.5" fill="${C.string}">${esc(
      s.smiles.length > 30 ? s.smiles.slice(0, 29) + "…" : s.smiles
    )}</text>`;
    svg += `<image x="${PAD}" y="${HEAD + PAD - 4}" width="${MW}" height="${MH}" xlink:href="data:image/svg+xml;base64,${b64}"/>`;
    svg += `</g>`;
  }

  svg += `</svg>`;
  return svg;
}

// ------------------------------------------------------------------- build
(async () => {
  const r = new SmilesRenderer(EXT);
  const mols = [];
  for (const s of SCENES) mols.push(await r.render(s.smiles));
  console.log("molecules rendered");

  /** [svgString, delayMs] */
  const timeline = [];
  const push = (spec, delay) => timeline.push([frame(spec), delay]);

  SCENES.forEach((s, i) => {
    const mol = mols[i];
    // Idle
    push({ scene: i }, i === 0 ? 900 : 500);
    // Selection sweep
    const STEPS = 7;
    for (let k = 1; k <= STEPS; k++) {
      push({ scene: i, selChars: Math.round((s.len * k) / STEPS) }, 45);
    }
    push({ scene: i, selChars: s.len }, 260);
    // Keycap
    for (const o of [0.45, 1]) push({ scene: i, selChars: s.len, keycap: o }, 70);
    push({ scene: i, selChars: s.len, keycap: 1 }, 300);
    // Popup in
    for (const p of [0.35, 0.7, 1]) {
      push({ scene: i, selChars: s.len, keycap: 1, popup: p, molSvg: mol }, 55);
    }
    // Hold
    push({ scene: i, selChars: s.len, keycap: 1, popup: 1, molSvg: mol }, 2000);
    push({ scene: i, selChars: s.len, popup: 1, molSvg: mol }, 700);
  });

  console.log(`rasterizing ${timeline.length} frames…`);
  const enc = GIFEncoder();
  for (let i = 0; i < timeline.length; i++) {
    const [svg, delay] = timeline[i];
    const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render();
    const { width, height } = png;
    const rgba = new Uint8Array(png.pixels.buffer);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    enc.writeFrame(index, width, height, { palette, delay });
    process.stdout.write(`\r  ${i + 1}/${timeline.length}`);
  }
  enc.finish();
  const gif = Buffer.from(enc.bytes());
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "demo.gif"), gif);
  console.log(`\nwrote demo.gif (${(gif.length / 1024).toFixed(0)} KB)`);

  // Stills for quick inspection.
  SCENES.forEach((s, i) => {
    const still = frame({
      scene: i,
      selChars: s.len,
      keycap: 1,
      popup: 1,
      molSvg: mols[i],
    });
    fs.writeFileSync(
      path.join(OUT, `screenshot-${["caffeine", "imatinib"][i]}.png`),
      new Resvg(still, { font: { loadSystemFonts: true } }).render().asPng()
    );
  });
  console.log("wrote stills");
})();
