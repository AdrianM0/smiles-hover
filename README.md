# SMILES Hover

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/adrianm0.smiles-hover?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=adrianm0.smiles-hover)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/adrianm0.smiles-hover)](https://marketplace.visualstudio.com/items?itemName=adrianm0.smiles-hover)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Select a SMILES string anywhere — Python, JS, JSON, CSV, Markdown, plain text —
press `Ctrl+K M`, and see the 2D structure rendered with **RDKit** in
**ChemDraw style**.

No Python, no `pip install`, no configuration. RDKit ships inside the
extension as WebAssembly.

![SMILES Hover in action](https://raw.githubusercontent.com/AdrianM0/smiles-hover/main/images/demo.gif)

## Install

### VS Code

Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), search for
**SMILES Hover**, and click **Install**.

Or from a terminal:

```bash
code --install-extension adrianm0.smiles-hover
```

Or open the
[Marketplace page](https://marketplace.visualstudio.com/items?itemName=adrianm0.smiles-hover)
and click **Install**.

That's everything — there's nothing else to set up. Select a SMILES string and
press `Ctrl+K M`.

### Cursor, VSCodium, Windsurf

These can't reach the Microsoft Marketplace, so install the file directly:

1. Download `smiles-hover-<version>.vsix` from the
   [latest release](https://github.com/AdrianM0/smiles-hover/releases/latest).
2. In the editor: Command Palette (`Ctrl+Shift+P`) →
   **Extensions: Install from VSIX…** → pick the downloaded file.

Or from a terminal, using whichever CLI your editor installs
(`cursor`, `codium`, `windsurf`):

```bash
cursor --install-extension ~/Downloads/smiles-hover-<version>.vsix
```

The extension only uses stable VS Code API, so it should work on any current
fork — though it's only been tested on VS Code.

### Remote SSH, WSL, and containers

Install it on the **remote** side, where your files are. In the Extensions
view, an extension installed only locally shows an **Install in SSH: …** (or
**Install in WSL**, **Install in Container**) button — click that. From a
terminal, run the install command in the remote session.

## Usage

1. Select a SMILES string.
2. Press `Ctrl+K M` (`Cmd+K M` on macOS), or right-click → **SMILES Hover: Show
   Molecule for Selection**.
3. The structure appears in a hover over the selection, and stays available for
   60 seconds so you can re-hover without re-rendering.

Selections are cleaned before rendering — surrounding quotes, trailing commas,
and escape sequences like `\n` or `\"` are stripped — so grabbing a value
straight out of a JSONL dump works fine.

The first render loads the WASM module (~200 ms); everything after is a few
milliseconds, and results are cached per `(smiles, size, preset)`. Command
Palette → **SMILES Hover: Clear Cache** to reset.

## Configuration

| Setting                       | Default    | Description                                   |
| ----------------------------- | ---------- | --------------------------------------------- |
| `smilesHover.autoSize`        | `true`     | Size the canvas to the molecule (see below).  |
| `smilesHover.maxHoverWidth`   | `460`      | Max displayed width inside the hover, px.     |
| `smilesHover.maxHoverHeight`  | `240`      | Max displayed height inside the hover, px.    |
| `smilesHover.imageWidth`      | `500`      | Base render width in px.                      |
| `smilesHover.imageHeight`     | `350`      | Base render height in px.                     |
| `smilesHover.colorPreset`     | `chemdraw` | `chemdraw`, `bright`, or `mono` atom palette. |

With `autoSize` on (the default), the whole structure is always visible at a
legible scale: the canvas area grows with the atom count, and its aspect ratio
is taken from the generated 2D layout, so a long molecule gets a wide render
rather than a thin band floating in an empty box. `imageWidth`/`imageHeight`
set the base size this scales from. Turn `autoSize` off to pin every render to
exactly those dimensions.

Render size and *displayed* size are separate. VS Code's hover has a limited
height — roughly a quarter of the editor's — and clips content that overflows
rather than scaling it, which would cut the bottom off a large molecule. So the
image is scaled down to fit `maxHoverWidth` × `maxHoverHeight` on display while
the underlying canvas stays large. It's vector, so nothing gets blurry, and the
big canvas is what stops atom labels colliding on dense structures. If you work
in a tall editor, raising `maxHoverHeight` gets you bigger structures.

Color presets:

- **chemdraw** — muted, publication-friendly colors on white.
- **bright** — vivid CPK-like (saturated red O, blue N, yellow S).
- **mono** — pure black on white, no atom coloring.

## How it works

1. The command reads your selection and cleans it ([src/smiles.ts](src/smiles.ts)).
2. [src/renderer.ts](src/renderer.ts) hands it to RDKit's MinimalLib WASM build,
   using CoordGen for ChemDraw-like 2D geometry and draw options that
   approximate RDKit's ACS 1996 preset — bumped above the ACS print defaults
   for bond width and font size, which are calibrated for paper and read as
   spidery on screen.
3. The SVG is base64-encoded into a `data:` URI and embedded in the hover
   markdown. No webview, no temp files, no subprocess.

The background is always white, so molecules read the same in light and dark
themes.

## Development

```bash
npm install
npm run compile   # vendors RDKit's WASM into vendor/, then runs tsc
```

Press `F5` in VS Code to launch an Extension Development Host.

To build a `.vsix` locally:

```bash
npm run package
```

The README demo is generated, not screen-recorded —
[scripts/make-demo.js](scripts/make-demo.js) composites real renderer output
into a mock editor window and encodes the GIF, so it can never drift from what
the extension actually draws. Regenerate it with `npm run demo`.

Release and publishing notes live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Limitations

- No InChI, no reaction SMARTS.
- Invalid SMILES surface RDKit's parse error in a notification.
- The `.vsix` is ~7 MB, nearly all of it the RDKit WASM binary.

## License

MIT — see [LICENSE](LICENSE). Bundles
[RDKit](https://github.com/rdkit/rdkit) (BSD-3-Clause) via
[@rdkit/rdkit](https://www.npmjs.com/package/@rdkit/rdkit).
