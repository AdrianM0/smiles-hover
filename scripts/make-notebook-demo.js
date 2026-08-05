/**
 * Build images/notebook.gif: a mock notebook where molecules in a printed list
 * and in a `df.head()` table are underlined, and hovering one grows the output
 * with its structure — pushing what's below down, which is what the real thing
 * does.
 *
 * Molecules come from the extension's own renderer, so the GIF can't drift
 * from what users see.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { Resvg } = require("@resvg/resvg-js");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");

const EXT = path.join(__dirname, "..");
const OUT = path.join(EXT, "images");

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

// ----------------------------------------------------------------- content
const MOLECULES = [
  { smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C", name: "caffeine" },
  { smiles: "CC(=O)Oc1ccccc1C(=O)O", name: "aspirin" },
  { smiles: "CN1CCC[C@H]1c1cccnc1", name: "nicotine" },
];

// Two outputs, each with its own molecules: a printed list, then a table.
const LIST = [0, 1];
const TABLE = [0, 1, 2];
const LIST_LINE = `['${MOLECULES[0].smiles}', '${MOLECULES[1].smiles}']`;

// ------------------------------------------------------------------ layout
const W = 760;
const H = 540;

const MONO = "DejaVu Sans Mono";
const UI = "DejaVu Sans";
const FS = 12.5;
const CW = FS * 0.6023; // DejaVu Sans Mono advance width
const LH = 20;
const TITLEBAR = 34;

const RUN_W = 40; // run-button gutter, left of every cell
const CELL_X = 30;
const CELL_W = W - CELL_X * 2;
const CODE_X = CELL_X + RUN_W + 10;
const PAD = 10; // inside a cell, above the first baseline

const ROW_H = 22;
const COL_I = 34; // index column
const COL_S = MOLECULES[0].smiles.length * CW + 18;
const COL_N = 110;

const MW = 230; // molecule width inside the preview
const BOX_PAD = 6;

const C = {
  chrome: "#252526",
  bg: "#1e1e1e",
  cell: "#1f1f1f",
  border: "#3c3c3c",
  focus: "#0e639c",
  gutter: "#6e7681",
  dotted: "#8b949e",
  fg: "#d4d4d4",
  keyword: "#c586c0",
  ident: "#9cdcfe",
  string: "#ce9178",
  fn: "#dcdcaa",
  out: "#cccccc",
  rule: "#454545",
};

const CELL1 = [
  ['df = pd.read_csv("molecules.csv")', [[0, 2, C.ident], [5, 2, C.ident], [8, 8, C.fn], [17, 15, C.string]]],
  ["print(df.smiles.tolist())", [[0, 5, C.fn], [6, 2, C.ident], [16, 7, C.fn]]],
];
const CELL2 = [["df.head()", [[0, 2, C.ident], [3, 4, C.fn]]]];

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function codeLine(text, spans, y, x = CODE_X) {
  let out = `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${FS}" fill="${C.fg}" xml:space="preserve">${esc(text)}</text>`;
  for (const [start, len, color] of spans) {
    out += `<text x="${x + start * CW}" y="${y}" font-family="${MONO}" font-size="${FS}" fill="${color}" xml:space="preserve">${esc(text.slice(start, start + len))}</text>`;
  }
  return out;
}

/** A detected molecule: dotted underline always, lit while hovered. */
function token(x, baseline, width, on) {
  let out = "";
  if (on) {
    out += `<rect x="${x - 2}" y="${baseline - FS}" width="${width + 4}" height="${FS + 4}" fill="#ffffff" opacity="0.08" rx="2"/>`;
  }
  out += `<line x1="${x}" y1="${baseline + 3}" x2="${x + width}" y2="${baseline + 3}" stroke="${on ? "#9cdcfe" : C.dotted}" stroke-width="1.2" stroke-dasharray="2 2"/>`;
  return out;
}

/** The preview, in flow at the end of an output. */
function preview(x, y, h, molSvg, aspect, fade) {
  const bw = MW + BOX_PAD * 2;
  const full = Math.round(MW * aspect);
  const b64 = Buffer.from(molSvg, "utf8").toString("base64");
  return (
    `<g opacity="${Math.min(1, fade * 1.6).toFixed(2)}">` +
    `<rect x="${x + 2}" y="${y + 3}" width="${bw}" height="${h}" rx="4" fill="#000" opacity="0.35"/>` +
    `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="#ffffff"/>` +
    `<svg x="${x + BOX_PAD}" y="${y + BOX_PAD}" width="${MW}" height="${Math.max(0, h - BOX_PAD * 2)}" viewBox="0 0 ${MW} ${full}" preserveAspectRatio="xMidYMin slice">` +
    `<image x="0" y="0" width="${MW}" height="${full}" xlink:href="data:image/svg+xml;base64,${b64}"/></svg></g>`
  );
}

function cellBox(y, h, focused) {
  return `<rect x="${CELL_X + RUN_W}" y="${y}" width="${CELL_W - RUN_W}" height="${h}" rx="4" fill="${C.cell}" stroke="${focused ? C.focus : C.border}" stroke-width="1"/>`;
}

function runButton(cy, label) {
  const x = CELL_X + 12;
  return (
    `<polygon points="${x},${cy - 6} ${x + 10},${cy} ${x},${cy + 6}" fill="#6e7681"/>` +
    `<text x="${CELL_X + RUN_W - 4}" y="${cy + 20}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${C.gutter}">${label}</text>`
  );
}

function pointer(x, y) {
  return (
    `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
    `<path d="M0 0 L0 16 L4.2 12.2 L7 18 L10 16.6 L7.2 11 L12 10.6 Z" fill="#ffffff" stroke="#000" stroke-width="1" stroke-linejoin="round"/></g>`
  );
}

/**
 * Where everything sits. `openIn` is the output holding the preview ("list" or
 * "table"), `grow` how far it has opened.
 */
function layout({ openIn = null, grow = 0, aspect = 1 } = {}) {
  const boxH = Math.round((BOX_PAD * 2 + MW * aspect) * grow);
  const c1y = TITLEBAR + 18;
  const c1h = CELL1.length * LH + PAD * 2;
  const o1y = c1y + c1h + 6;
  const o1h = LH + 10 + (openIn === "list" ? boxH + 6 : 0);
  const c2y = o1y + o1h + 8;
  const c2h = CELL2.length * LH + PAD * 2;
  const o2y = c2y + c2h + 6;
  const tableH = (TABLE.length + 1) * ROW_H + 8;
  const o2h = tableH + (openIn === "table" ? boxH + 6 : 0);
  return { c1y, c1h, o1y, o1h, c2y, c2h, o2y, o2h, tableH, boxH };
}

/** One frame. `hover` is "list:i" / "table:i", or null. */
function frame({ hover = null, grow = 0, cursor = null, mol = null, aspect = 1 }) {
  const [openIn, hoverRow] = hover ? hover.split(":") : [null, null];
  const L = layout({ openIn: grow > 0 ? openIn : null, grow, aspect });

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<rect width="${W}" height="${H}" rx="8" fill="${C.bg}"/>`;

  // Title bar
  svg += `<path d="M0 8a8 8 0 0 1 8-8h${W - 16}a8 8 0 0 1 8 8v${TITLEBAR - 8}H0z" fill="${C.chrome}"/>`;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((d, i) => {
    svg += `<circle cx="${20 + i * 17}" cy="${TITLEBAR / 2}" r="5.5" fill="${d}"/>`;
  });
  svg += `<text x="${W / 2}" y="${TITLEBAR / 2 + 4}" text-anchor="middle" font-family="${UI}" font-size="11.5" fill="#8a8a8a">molecules.ipynb</text>`;
  svg += `<rect x="0" y="${TITLEBAR}" width="${W}" height="1" fill="${C.border}"/>`;

  // ---- cell 1 and its printed list
  svg += cellBox(L.c1y, L.c1h, openIn === "list");
  svg += runButton(L.c1y + L.c1h / 2, "[1]");
  CELL1.forEach(([text, spans], i) => {
    svg += codeLine(text, spans, L.c1y + PAD + FS + i * LH, CODE_X);
  });

  const listBase = L.o1y + 8 + FS;
  svg += `<text x="${CODE_X}" y="${listBase}" font-family="${MONO}" font-size="${FS}" fill="${C.out}" xml:space="preserve">${esc(LIST_LINE)}</text>`;
  LIST.forEach((m, i) => {
    const smiles = MOLECULES[m].smiles;
    svg += token(
      CODE_X + LIST_LINE.indexOf(smiles) * CW,
      listBase,
      smiles.length * CW,
      openIn === "list" && +hoverRow === i
    );
  });
  if (openIn === "list" && grow > 0 && mol) {
    svg += preview(CODE_X, L.o1y + LH + 8, L.boxH, mol, aspect, grow);
  }

  // ---- cell 2 and its DataFrame, pushed down by whatever is above
  svg += cellBox(L.c2y, L.c2h, openIn === "table");
  svg += runButton(L.c2y + L.c2h / 2, "[2]");
  CELL2.forEach(([text, spans], i) => {
    svg += codeLine(text, spans, L.c2y + PAD + FS + i * LH, CODE_X);
  });
  svg += table(L, openIn === "table" ? +hoverRow : -1);
  if (openIn === "table" && grow > 0 && mol) {
    svg += preview(CODE_X, L.o2y + L.tableH + 2, L.boxH, mol, aspect, grow);
  }

  if (cursor) svg += pointer(cursor.x, cursor.y);
  svg += `</svg>`;
  return svg;
}

/** What `df.head()` renders: a header row vouching for the cells under it. */
function table(L, hoverRow) {
  const x = CODE_X;
  const w = COL_I + COL_S + COL_N;
  let out = `<text x="${x + COL_I}" y="${L.o2y + ROW_H - 7}" font-family="${UI}" font-size="11.5" font-weight="bold" fill="${C.out}">smiles</text>`;
  out += `<text x="${x + COL_I + COL_S}" y="${L.o2y + ROW_H - 7}" font-family="${UI}" font-size="11.5" font-weight="bold" fill="${C.out}">name</text>`;
  out += `<line x1="${x}" y1="${L.o2y + ROW_H - 1}" x2="${x + w}" y2="${L.o2y + ROW_H - 1}" stroke="${C.rule}" stroke-width="1"/>`;

  TABLE.forEach((m, i) => {
    const { smiles, name } = MOLECULES[m];
    const base = L.o2y + (i + 2) * ROW_H - 7;
    out += `<text x="${x + COL_I - 10}" y="${base}" text-anchor="end" font-family="${UI}" font-size="11.5" fill="${C.gutter}">${i}</text>`;
    out += `<text x="${x + COL_I}" y="${base}" font-family="${MONO}" font-size="${FS}" fill="${C.out}" xml:space="preserve">${esc(smiles)}</text>`;
    out += token(x + COL_I, base, smiles.length * CW, hoverRow === i);
    out += `<text x="${x + COL_I + COL_S}" y="${base}" font-family="${UI}" font-size="11.5" fill="${C.out}">${name}</text>`;
  });
  return out;
}

// ------------------------------------------------------------------- build
(async () => {
  const r = new SmilesRenderer(EXT);
  const svgs = [];
  for (const m of MOLECULES) svgs.push(await r.render(m.smiles));
  const aspects = svgs.map((s) => {
    const d = s.match(/width=['"](\d+)px['"] height=['"](\d+)px['"]/);
    return d ? +d[2] / +d[1] : 0.7;
  });
  console.log("molecules rendered");

  /** Cursor target for a molecule, measured in the closed layout. */
  const at = (where, i) => {
    const L = layout();
    if (where === "list") {
      const smiles = MOLECULES[LIST[i]].smiles;
      return {
        x: CODE_X + (LIST_LINE.indexOf(smiles) + smiles.length / 2) * CW,
        y: L.o1y + 8 + 2,
      };
    }
    const open = layout({ openIn: "list", grow: 0 });
    return {
      x: CODE_X + COL_I + (MOLECULES[TABLE[i]].smiles.length / 2) * CW,
      y: open.o2y + (i + 2) * ROW_H - FS - 5,
    };
  };

  const timeline = [];
  const push = (spec, delay) => timeline.push([frame(spec), delay]);
  const shown = (m) => ({ mol: svgs[m], aspect: aspects[m] });
  const glide = (from, to, steps, spec, delay = 55) => {
    for (let k = 1; k <= steps; k++) {
      push({
        ...spec,
        cursor: {
          x: from.x + ((to.x - from.x) * k) / steps,
          y: from.y + ((to.y - from.y) * k) / steps,
        },
      }, delay);
    }
  };

  // Idle: everything detected is already underlined.
  push({}, 900);

  // Into the printed list.
  const l0 = at("list", 0);
  glide({ x: W - 150, y: TITLEBAR + 12 }, l0, 5, {});
  for (const g of [0.3, 0.65, 1]) {
    push({ hover: "list:0", grow: g, cursor: l0, ...shown(0) }, 60);
  }
  push({ hover: "list:0", grow: 1, cursor: l0, ...shown(0) }, 2000);

  // Across to the next molecule: same box, new picture, no flicker.
  const l1 = at("list", 1);
  glide(l0, l1, 4, { hover: "list:0", grow: 1, ...shown(0) });
  push({ hover: "list:1", grow: 1, cursor: l1, ...shown(1) }, 2000);

  // Out, and the notebook closes back up.
  for (const g of [0.55, 0.2]) {
    push({ hover: "list:1", grow: g, cursor: { x: l1.x, y: l1.y + 40 }, ...shown(1) }, 60);
  }

  // Into the DataFrame: a `smiles` column header vouches for its cells.
  const t2 = at("table", 2);
  glide({ x: l1.x, y: l1.y + 40 }, t2, 5, {});
  for (const g of [0.3, 0.65, 1]) {
    push({ hover: "table:2", grow: g, cursor: t2, ...shown(2) }, 60);
  }
  push({ hover: "table:2", grow: 1, cursor: t2, ...shown(2) }, 2000);

  const t0 = at("table", 0);
  glide(t2, t0, 4, { hover: "table:2", grow: 1, ...shown(2) });
  push({ hover: "table:0", grow: 1, cursor: t0, ...shown(0) }, 2000);

  for (const g of [0.55, 0.2]) {
    push({ hover: "table:0", grow: g, cursor: { x: t0.x + 40, y: t0.y - 30 }, ...shown(0) }, 60);
  }
  push({}, 900);

  console.log(`rasterizing ${timeline.length} frames…`);
  const enc = GIFEncoder();
  for (let i = 0; i < timeline.length; i++) {
    const [svg, delay] = timeline[i];
    const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render();
    const rgba = new Uint8Array(png.pixels.buffer);
    const palette = quantize(rgba, 256);
    enc.writeFrame(applyPalette(rgba, palette), png.width, png.height, {
      palette,
      delay,
    });
    process.stdout.write(`\r  ${i + 1}/${timeline.length}`);
  }
  enc.finish();
  const gif = Buffer.from(enc.bytes());
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "notebook.gif"), gif);
  console.log(`\nwrote notebook.gif (${(gif.length / 1024).toFixed(0)} KB)`);

  // Stills for quick inspection.
  const stills = [
    ["notebook", { hover: "list:0", grow: 1, cursor: at("list", 0), ...{ mol: svgs[0], aspect: aspects[0] } }],
    ["dataframe", { hover: "table:2", grow: 1, cursor: at("table", 2), ...{ mol: svgs[2], aspect: aspects[2] } }],
  ];
  for (const [name, spec] of stills) {
    fs.writeFileSync(
      path.join(OUT, `screenshot-${name}.png`),
      new Resvg(frame(spec), { font: { loadSystemFonts: true } }).render().asPng()
    );
  }
  console.log("wrote stills");
})();
