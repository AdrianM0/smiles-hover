# Changelog

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
