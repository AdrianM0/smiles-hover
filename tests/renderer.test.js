// Run with: npm test
//
// Renders real molecules through RDKit and checks what the picture is made of.
const assert = require("node:assert");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");

const EXT = path.join(__dirname, "..");
const settings = {
  imageWidth: 500,
  imageHeight: 350,
  colorPreset: "chemdraw",
  autoSize: true,
  maxHoverWidth: 460,
  maxHoverHeight: 240,
};

// The renderer imports `vscode` for settings; stub it.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "vscode" ? "vscode-stub" : resolve.call(this, request, ...rest);
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
const renderer = new SmilesRenderer(EXT);

const strokes = (svg) =>
  [...svg.matchAll(/stroke-width:([\d.]+)px/g)].map((m) => +m[1]).filter((n) => n > 0);

test("line weight holds from two atoms to sixty", async () => {
  // RDKit scales bond width with the drawing, so sizing the canvas by atom
  // count magnified small molecules until their bonds were bars: [Xe][Xe] drew
  // at 10.9 px against caffeine's 3.3.
  const widths = [];
  for (const smiles of [
    "[Xe][Xe]",
    "CCO",
    "c1ccccc1",
    "C1CCC2(OCCO2)CC1",
    "CC(=O)Oc1ccccc1C(=O)O",
    "CN1C=NC2=C1C(=O)N(C)C(=O)N2C",
    "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1",
  ]) {
    const found = strokes(await renderer.render(smiles));
    assert.ok(found.length > 0, `no bonds drawn for ${smiles}`);
    widths.push(Math.max(...found));
  }

  const max = Math.max(...widths);
  assert.ok(max <= 4.5, `bonds too heavy: ${widths.join(", ")}`);
  assert.ok(
    max / Math.min(...widths) < 2.5,
    `line weight not consistent: ${widths.join(", ")}`
  );
});

test("the background covers the cropped picture", async () => {
  // Crop margin can reach past the canvas the background rect was drawn for,
  // which leaves the edge transparent — grey molecules on a dark theme.
  const svg = await renderer.render("C1CCC2(OCCO2)CC1");
  const view = svg.match(/viewBox='([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)'/).slice(1).map(Number);
  const rect = svg
    .match(/<rect[^>]*width='([\d.]+)' height='([\d.]+)' x='([-\d.]+)' y='([-\d.]+)'/)
    .slice(1)
    .map(Number);
  const [vx, vy, vw, vh] = view;
  const [w, h, x, y] = rect;

  assert.ok(x <= vx && y <= vy, "background starts inside the view");
  assert.ok(x + w >= vx + vw && y + h >= vy + vh, "background ends inside the view");
});

test("the canvas follows the molecule, not the base size", async () => {
  // Ethanol has no business filling a 500x350 canvas.
  const small = await renderer.render("CCO");
  const big = await renderer.render("CN1C=NC2=C1C(=O)N(C)C(=O)N2C");
  const width = (svg) => +svg.match(/width='([\d.]+)px'/)[1];
  assert.ok(width(small) < width(big) / 1.5, "small molecule drawn too large");
});
