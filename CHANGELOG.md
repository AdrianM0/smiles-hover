# Changelog

## 1.1.7

- **Fix: a molecule stopped previewing once its output was re-rendered.** The
  in-flow preview lives inside the output, so a cell re-run or a scroll took it
  with them, while the renderer still believed it was on screen and skipped
  re-showing it.

## 1.1.6

- **Fix: no preview on one-line outputs.** Showing the picture in flow grows
  the output, VS Code reflows the notebook, and the token slides out from
  under the cursor — the resulting `mouseout` tore the preview down as fast as
  it appeared. Hiding is now deferred and cancelled if the cursor is still
  there, and re-hovering the same molecule no longer touches the DOM.

## 1.1.5

- **Fix: the preview could still land over the cell above.** A truncated or
  scrolled output's element reaches well past the viewport, and the room above
  the token was measured against that off-screen top. Placement now uses only
  the visible part of the output box.

## 1.1.4

- **Fix: output previews were drawn behind the next cell.** The outputs webview
  spans the notebook, but VS Code paints the native cell editors on top of it,
  so anything overflowing an output's own rectangle disappears under a cell.
  The preview now fits itself to that rectangle — and when there's no room in
  it, as with a one-line `print`, it sits in flow at the end of the output and
  lets the output grow instead.

## 1.1.3

- **Output hovers now cover plain text**, not just HTML. The built-in renderer
  hooks HTML only, so rather than wait to be called the renderer watches the
  output DOM and marks up whatever appears — `print(smi)`, a dict repr, stdout,
  a DataFrame table. The hook is gone; one path covers every output.

## 1.1.2

- **Fix: output hovers still didn't appear.** 1.1.1 fixed the manifest, but the
  renderer used the wrong contract — an extending renderer's own
  `renderOutputItem` is never called. It has to fetch the base renderer with
  `getRenderer("vscode.builtin-renderer")` and register a hook, which is what
  it now does.
- Output hovers therefore cover **HTML outputs** — `df.head()` and anything
  with `_repr_html_`. The built-in renderer offers hooks for HTML and
  JavaScript only, so `print(smi)` and stdout can't be reached this way.

## 1.1.1

- **Fix: hovers in cell output never worked.** The renderer was contributed
  under `notebookRenderers`; the contribution point is `notebookRenderer`,
  singular, so VS Code ignored it and the renderer was never loaded. Cell
  sources were unaffected.
- Output hovers no longer wait on the validity round trip — the picture
  request answers the same question, so a slow or lost reply costs nothing.
- Molecules are tracked as elements rather than found by document query, so
  verdicts still land if an output renders into a shadow root.

## 1.1.0

- **Jupyter notebooks**, in cell sources and cell outputs alike. Sources —
  code and markdown — behave like any file; every visible cell is scanned, and
  each is its own document, so edits elsewhere don't disturb it.
- **Output too.** Output is DOM in a webview, where no hover provider reaches,
  so a notebook renderer extending the built-in one handles it: molecules in
  `print()` output and in `df.head()` tables get a dotted underline and draw on
  hover. It shares the detection code with the editor path and asks the
  extension host for verdicts and pictures, leaving RDKit's 7 MB out of the
  webview. Only mime types the built-in renderer draws are covered.
- A line that names SMILES vouches for its values, so `MolFromSmiles("CCO")`
  and `smiles = ["CCO", "CCN"]` are drawn despite being short. A `smiles`
  column header does the same for a whole printed table.

## 1.0.0

- **Molecules are found for you.** Every SMILES on screen is detected and drawn
  as you scroll and type, so hovering one shows it — nothing to select, no
  keypress. A SMILES column is live the moment it scrolls into view.
- **Anything that isn't chemistry is ignored, silently.** Tokens are cut out by
  character class, checked against the SMILES grammar's own rules (outside
  brackets only ten element symbols are legal and only six letters may be
  lowercase, which excludes essentially every English word), then confirmed by
  RDKit. Across a page of mixed prose, code and data, only real molecules reach
  the parser.
- **Context decides the ambiguous cases.** `CNN`, `ISC`, `CSS` and `SNP` all
  parse as molecules and none are meant as one. A `smiles:` key, a line of its
  own, or a header row naming a SMILES column takes a token at face value; a
  quoted string or CSV cell wants structure or
  `smilesHover.autoDetectMinLength` characters (default 4); prose wants both.
  So a SMILES column comes alive whole while a package-lock full of `"ISC"`
  stays quiet.
- Selecting something that isn't a SMILES no longer raises an error dialog —
  it says so in the status bar.
- New: `smilesHover.autoDetect`, `smilesHover.maxPrerender`, and **SMILES
  Hover: Toggle Automatic Detection**. Manual rendering (`Ctrl+K M`) still
  covers SMILES buried inside longer strings.

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
