# SMILES Hover

Select a SMILES string anywhere — Python, JS, JSON, CSV, Markdown, plain text —
press `Ctrl+K M`, and see the 2D structure rendered with **RDKit** in
**ChemDraw style**.

No Python, no `pip install`, no configuration. RDKit ships inside the
extension as WebAssembly.

![SMILES Hover in action](https://raw.githubusercontent.com/AdrianM0/smiles-hover/main/images/demo.gif)

## Install

Download the latest `.vsix` from the
[Releases page](https://github.com/AdrianM0/smiles-hover/releases), then:

```bash
code --install-extension smiles-hover-<version>.vsix
```

Or, from inside VS Code: Command Palette → **Extensions: Install from VSIX…**

This also works in Cursor, VSCodium, and Windsurf — substitute their CLI
(`cursor`, `codium`, …) for `code`.

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

| Setting                   | Default    | Description                                        |
| ------------------------- | ---------- | -------------------------------------------------- |
| `smilesHover.autoSize`    | `true`     | Size the canvas to the molecule (see below).        |
| `smilesHover.imageWidth`  | `500`      | Base render width in px.                            |
| `smilesHover.imageHeight` | `350`      | Base render height in px.                           |
| `smilesHover.colorPreset` | `chemdraw` | `chemdraw`, `bright`, or `mono` atom palette.       |

With `autoSize` on (the default), the whole structure is always visible at a
legible scale: the canvas area grows with the atom count, and its aspect ratio
is taken from the generated 2D layout, so a long molecule gets a wide popup
rather than a thin band floating in an empty box. `imageWidth`/`imageHeight`
set the base size this scales from. Turn `autoSize` off to pin every render to
exactly those dimensions.

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

Pushing a `v*` tag builds the `.vsix` and attaches it to a GitHub Release — see
[.github/workflows/release.yml](.github/workflows/release.yml). The same
workflow publishes to the extension marketplaces if the relevant tokens are
configured, and silently skips that if they aren't.

### Publishing to the VS Code Marketplace

One-time setup, all of it interactive:

1. Create a free [Azure DevOps](https://dev.azure.com) organization — the
   Marketplace authenticates against it.
2. Create a Personal Access Token there: **Organization** = *All accessible
   organizations*, **Scopes** = *Custom defined* → **Marketplace** → **Manage**.
   Both of those matter; the token won't work scoped to a single org.
3. Create the publisher at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage/createpublisher).
   The publisher ID must be exactly `adrianm0`, matching `publisher` in
   [package.json](package.json).
4. Add the PAT as a repository secret named `VSCE_PAT`
   (**Settings → Secrets and variables → Actions**).

Then `git tag vX.Y.Z && git push origin vX.Y.Z` publishes. To publish by hand
instead: `npx vsce publish -p <PAT>`.

Marketplace tokens expire (max one year), and a publish will fail with a 401
once yours does — regenerate and update the secret.

### Publishing to Open VSX

Open VSX is the registry Cursor, VSCodium, and Windsurf use; they can't install
from the Microsoft Marketplace. Sign in at [open-vsx.org](https://open-vsx.org)
with GitHub, sign the publisher agreement, create an access token, and add it as
the `OVSX_PAT` secret.

## Limitations

- No InChI, no reaction SMARTS.
- Invalid SMILES surface RDKit's parse error in a notification.
- The `.vsix` is ~7 MB, nearly all of it the RDKit WASM binary.

## License

MIT — see [LICENSE](LICENSE). Bundles
[RDKit](https://github.com/rdkit/rdkit) (BSD-3-Clause) via
[@rdkit/rdkit](https://www.npmjs.com/package/@rdkit/rdkit).
