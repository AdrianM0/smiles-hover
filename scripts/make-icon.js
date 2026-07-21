#!/usr/bin/env node
/**
 * Generate the Marketplace icon: a molecule on a dark rounded tile.
 *
 * Drawn by RDKit rather than by hand, for the same reason the demo GIF is
 * generated — it's the same renderer the extension ships.
 */
const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const SIZE = 256; // rendered at 2x, Marketplace wants >=128
const OUT = path.join(__dirname, "..", "images");

// Caffeine's purine core: two fused rings read clearly even at 128px, where a
// full drug structure would turn to mush.
const SMILES = "Cn1cnc2c1c(=O)[nH]c(=O)n2C";

const base = path.join(__dirname, "..", "node_modules", "@rdkit", "rdkit", "dist");

(async () => {
  const initRDKitModule = require(path.join(base, "RDKit_minimal.js"));
  const RDKit = await initRDKitModule({
    locateFile: () => path.join(base, "RDKit_minimal.wasm"),
  });
  RDKit.prefer_coordgen(true);

  const mol = RDKit.get_mol(SMILES);
  const molSvg = mol.get_svg_with_highlights(
    JSON.stringify({
      width: 200,
      height: 200,
      // Light-on-dark: the tile is dark, so invert the usual palette.
      atomColourPalette: {
        6: [0.95, 0.95, 0.95],
        7: [0.45, 0.68, 1.0],
        8: [1.0, 0.42, 0.42],
      },
      bondLineWidth: 5,
      scaleBondWidth: false,
      minFontSize: 22,
      maxFontSize: 30,
      explicitMethyl: true,
      clearBackground: false, // transparent — the tile shows through
      padding: 0.06,
    })
  );
  mol.delete();

  const b64 = Buffer.from(molSvg, "utf8").toString("base64");
  const r = SIZE * 0.22; // corner radius
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b3550"/>
      <stop offset="1" stop-color="#161c2b"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${r}" fill="url(#bg)"/>
  <rect x="1" y="1" width="${SIZE - 2}" height="${SIZE - 2}" rx="${r - 1}" fill="none" stroke="#4a5a80" stroke-width="2" opacity="0.5"/>
  <image x="${(SIZE - 200) / 2}" y="${(SIZE - 200) / 2}" width="200" height="200" xlink:href="data:image/svg+xml;base64,${b64}"/>
</svg>`;

  fs.mkdirSync(OUT, { recursive: true });
  const png = new Resvg(tile, { font: { loadSystemFonts: true } })
    .render()
    .asPng();
  fs.writeFileSync(path.join(OUT, "icon.png"), png);
  console.log(`wrote images/icon.png (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`);
})();
