#!/usr/bin/env node
/**
 * Copy the RDKit MinimalLib WASM build out of node_modules into vendor/.
 *
 * node_modules is excluded from the packaged .vsix, but the extension needs
 * these two files at runtime, so they get vendored in as part of the build.
 */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "@rdkit", "rdkit", "dist");
const dest = path.join(__dirname, "..", "vendor");

const FILES = ["RDKit_minimal.js", "RDKit_minimal.wasm"];

if (!fs.existsSync(src)) {
  console.error(`RDKit dist not found at ${src} — run 'npm install' first.`);
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  const { size } = fs.statSync(path.join(dest, f));
  console.log(`vendor/${f} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}
