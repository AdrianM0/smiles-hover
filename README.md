# SMILES Hover

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/adrianm0.smiles-hover?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=adrianm0.smiles-hover)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/adrianm0.smiles-hover)](https://marketplace.visualstudio.com/items?itemName=adrianm0.smiles-hover)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Hover a SMILES string anywhere — Python, JS, JSON, CSV, Markdown, Jupyter
notebooks, plain text — and see the 2D structure rendered with **RDKit** in
**ChemDraw style**.
Molecules on screen are found and drawn before you reach for them; anything
that isn't chemistry is silently ignored.

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

That's everything — there's nothing else to set up. Open a file with molecules
in it and hover one.

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

Just hover. Everything on screen is scanned as you scroll and type, and every
molecule found is drawn ahead of time, so the structure is already waiting. A
SMILES column comes alive the moment it scrolls into view.

**What counts as a molecule.** Only tokens RDKit parses, so prose, identifiers
and paths never hover. The ambiguous cases are short uppercase strings — `CNN`,
`ISC`, `CSS`, `SNP` are all valid molecules and none are meant as one — so how
short a token may be depends on where it sits:

- **Declared** — after a `smiles:` key, alone on its line, or in a file whose
  header row names a SMILES column. Any length.
- **A field** — a quoted string or a CSV/TSV cell. Needs structure (a ring,
  branch, bracket atom or bond) or `smilesHover.autoDetectMinLength`
  characters, default 4. `CCCC` and `CC(=O)O` pass; `ISC` doesn't.
- **Prose** — running text or an expression. Needs both, or eight-plus
  characters of pure chain.

A line that names SMILES vouches for its values, so `Chem.MolFromSmiles("CCO")`
and `smiles = ["CCO", "CCN"]` are drawn even though `CCO` is short. Lower
`autoDetectMinLength` to `3` if you write bare `CCO` in prose. Anything
detection skips is still one selection and `Ctrl+K M` away.

**Jupyter notebooks** work in cell sources — code and markdown alike, exactly
like a file — and in **cell output**: `print(smi)`, a dict repr, a `df.head()`
table. Molecules there get a dotted underline and draw on hover, and a `smiles`
column header vouches for the cells beneath it, so short entries like `CCO` are
picked up too.

**Rendering by hand.** For a SMILES buried inside a longer string, select it
and press `Ctrl+K M` (`Cmd+K M` on macOS), or right-click → **SMILES Hover:
Show Molecule for Selection**. That molecule stays hoverable at every
occurrence of its string for 15 minutes (`smilesHover.retentionMinutes`).
Selections are cleaned first — quotes, trailing commas, escapes like `\n` — so
grabbing a value out of a JSONL dump works. A selection that isn't a molecule
just reports in the status bar.

Command Palette → **SMILES Hover: Toggle Automatic Detection** turns scanning
off.

The first render loads the WASM module (~200 ms); everything after is a few
milliseconds, and results are cached per `(smiles, size, preset)`. Command
Palette → **SMILES Hover: Clear Cache** to reset.

## Configuration

| Setting                            | Default    | Description                                      |
| ---------------------------------- | ---------- | ------------------------------------------------ |
| `smilesHover.autoDetect`           | `true`     | Find and draw molecules on screen automatically. |
| `smilesHover.autoDetectMinLength`  | `4`        | Shortest bare token considered a molecule.       |
| `smilesHover.maxPrerender`         | `40`       | Molecules drawn ahead per screenful.             |
| `smilesHover.autoSize`             | `true`     | Size the canvas to the molecule (see below).     |
| `smilesHover.maxHoverWidth`        | `460`      | Max displayed width inside the hover, px.        |
| `smilesHover.maxHoverHeight`       | `240`      | Max displayed height inside the hover, px.       |
| `smilesHover.imageWidth`           | `500`      | Base render width in px.                         |
| `smilesHover.imageHeight`          | `350`      | Base render height in px.                        |
| `smilesHover.colorPreset`          | `chemdraw` | `chemdraw`, `bright`, or `mono` atom palette.    |
| `smilesHover.retentionMinutes`     | `15`       | How long a hand-render stays hoverable, minutes. |

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

1. [src/scan.ts](src/scan.ts) splits each visible line into SMILES-shaped
   tokens and drops what can't be chemistry, by grammar then by context.
   [src/detect.ts](src/detect.ts) puts the survivors past RDKit and draws the
   ones that parse, debounced against scrolling and typing. Nothing is stored
   per document — the caches are keyed by the string itself, so edits need no
   invalidation. Hand-picked selections are cleaned instead
   ([src/smiles.ts](src/smiles.ts)).
2. [src/renderer.ts](src/renderer.ts) hands it to RDKit's MinimalLib WASM build,
   using CoordGen for ChemDraw-like 2D geometry and draw options that
   approximate RDKit's ACS 1996 preset — bumped above the ACS print defaults
   for bond width and font size, which are calibrated for paper and read as
   spidery on screen.
3. The SVG is base64-encoded into a `data:` URI and embedded in the hover
   markdown. No temp files, no subprocess.
4. Cell output is the exception: no hover provider reaches into a webview, so
   [src/output-renderer.ts](src/output-renderer.ts) runs there and watches the
   output DOM. It imports the same [src/scan.ts](src/scan.ts) and asks the host
   for verdicts and pictures ([src/output-messaging.ts](src/output-messaging.ts));
   RDKit's 7 MB stays out of the webview.

The background is always white, so molecules read the same in light and dark
themes.

## Development

```bash
npm install
npm run compile   # vendors RDKit's WASM into vendor/, then runs tsc
npm test          # unit tests for detection, selection cleaning, token matching
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

Pushing a `v*` tag builds the `.vsix`, attaches it to a GitHub Release, and
publishes to the Marketplace — see
[.github/workflows/release.yml](.github/workflows/release.yml).

## Limitations

- No InChI, no reaction SMARTS.
- Notebook output rendered by a third-party renderer — a plotly or ipywidget
  view — draws into its own frame and isn't reached.
- Auto-detection is conservative with short featureless tokens, because `CNN`,
  `ISC` and `CSS` are valid molecules and much more often not meant as ones.
  Put them under a `smiles` column header, on a line of their own, after a
  `smiles:` key, or lower `autoDetectMinLength`.
- A selection you render by hand and RDKit rejects reports quietly in the
  status bar; a molecule that parses but fails to draw still raises a
  notification.
- The `.vsix` is ~7 MB, nearly all of it the RDKit WASM binary.

## License

MIT — see [LICENSE](LICENSE). Bundles
[RDKit](https://github.com/rdkit/rdkit) (BSD-3-Clause) via
[@rdkit/rdkit](https://www.npmjs.com/package/@rdkit/rdkit); notice in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
