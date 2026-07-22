# Changelog

## 0.5.0

- **A molecule is now remembered by its SMILES, not by where you rendered it.**
  0.4.3 pinned each render to the span it was invoked on, which meant an edit
  anywhere above it retired the hover, and the same SMILES three rows down was
  a stranger. Position is now resolved on every hover by looking for the string
  in the document, so *every* occurrence hovers: elsewhere in the file, in
  other files, and after edits move it around. Render one cell of a SMILES
  column and the whole column comes alive.
- Matching is on whole delimited tokens, so `CCO` doesn't light up inside
  `CCOCC` — a different molecule — or inside the word `Cocoa`.
- Added unit tests for selection cleaning and token matching: `npm test`.

## 0.4.3

- **Rendered molecules stay hoverable.** Previously a render was a one-shot
  payload that lived 60 seconds and was replaced by the next one, so hovering a
  SMILES you'd already looked at showed nothing. Molecules are now remembered
  for 15 minutes each, and hovering shows them again — no keypress.
- Added `smilesHover.retentionMinutes` (default 15). "Clear Cache" forgets
  everything immediately.

## 0.4.2

- Ship RDKit's BSD-3-Clause notice with the extension. The bundled WASM is a
  binary redistribution, which requires reproducing the copyright notice and
  disclaimer alongside it; only the `.vsix` changes, not the code.

## 0.4.1

- **Fixed molecules being clipped in the hover.** 0.4.0 grew the canvas for
  bigger structures, but VS Code's hover widget has its own height limit
  (roughly a quarter of the editor height) and clips overflowing content behind
  a scrollbar instead of scaling it — so the taller renders lost their bottom
  half. The SVG's displayed size is now capped independently of its render
  size. Since the render is vector, the canvas stays large (which is what keeps
  atom labels from colliding) while the image shown fits the popup.
- Added `smilesHover.maxHoverWidth` (460) and `smilesHover.maxHoverHeight`
  (240). Raise them if you run a tall editor and want larger structures.

## 0.4.0

- **The whole structure is now visible by default.** The canvas is sized from
  the molecule instead of being fixed at 500×350: area grows with atom count,
  and the aspect ratio is taken from the generated 2D layout. Long molecules
  no longer render as a thin band in the middle of a mostly-empty box.
- Dropped `fixedFontSize`, which pinned atom labels at 20 px however dense the
  structure was — on anything bigger than a drug fragment the labels collided
  with the bonds. Fonts now scale with the drawing, with a 12 px floor.
- Added `smilesHover.autoSize` (default `true`). Turn it off to always render
  at exactly `imageWidth` × `imageHeight`.
- `imageWidth`/`imageHeight` are now the *base* size that auto-sizing scales
  from, rather than a hard canvas size.

## 0.3.0

- **No more Python dependency.** Rendering now runs on RDKit's MinimalLib
  WebAssembly build, bundled with the extension. Nothing to install.
- First render takes ~200 ms (WASM load); subsequent renders are single-digit
  milliseconds, down from a ~100 ms Python subprocess spawn each time.
- Removed the `smilesHover.pythonPath` setting — it no longer means anything.
- Removed the 5-second render timeout, which existed to bound subprocess hangs.

## 0.2.1

- Selection-driven: select a SMILES and press `Ctrl+K M` (`Cmd+K M`) instead of
  relying on hover-time SMILES detection.
- Added `smilesHover.colorPreset` (`chemdraw`, `bright`, `mono`).
- Selections are cleaned of quotes, trailing commas, and escape sequences.
- Larger default render size (500×350).

## 0.1.0

- Initial release: automatic SMILES detection on hover, RDKit via a Python
  subprocess.
