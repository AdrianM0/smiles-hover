# Contributing

## Building

```bash
npm install
npm run compile   # vendors RDKit's WASM into vendor/, then runs tsc
```

Press `F5` in VS Code to launch an Extension Development Host.

Build a `.vsix` locally with `npm run package`.

## Generated assets

The README demo GIF and the Marketplace icon are generated, not hand-drawn:

- `npm run demo` — [scripts/make-demo.js](scripts/make-demo.js) composites real
  renderer output into a mock editor window and encodes the GIF, so it can't
  drift from what the extension actually draws.
- `npm run icon` — [scripts/make-icon.js](scripts/make-icon.js) draws caffeine's
  purine core with the same RDKit build the extension ships.

## Releasing

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

That runs [.github/workflows/release.yml](.github/workflows/release.yml), which
builds the `.vsix`, attaches it to a GitHub Release, and publishes to the
marketplaces whose tokens are configured. Missing tokens are skipped rather
than failing the run, so the GitHub Release always happens.

Bump `version` in [package.json](package.json) and add a
[CHANGELOG.md](CHANGELOG.md) entry before tagging.

### VS Code Marketplace

Already configured. The one-time setup, for forks or when the token expires:

1. Create a free [Azure DevOps](https://dev.azure.com) organization — the
   Marketplace authenticates against it.
2. Create a Personal Access Token there: **Organization** = *All accessible
   organizations*, **Scopes** = *Custom defined* → **Marketplace** → **Manage**.
   Both matter; a token scoped to a single organization won't work, and the
   Marketplace scope is hidden until you click **Show all scopes**.
3. Create the publisher at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage/createpublisher),
   with an ID matching `publisher` in [package.json](package.json).
4. Add the PAT as a repository secret named `VSCE_PAT`
   (**Settings → Secrets and variables → Actions**).

To publish by hand instead: `npx vsce publish -p <PAT>`.

Tokens expire after at most a year, and publishes start failing with a 401 when
yours does — regenerate and update the secret.

### Open VSX

Not set up. Open VSX is the registry Cursor, VSCodium, and Windsurf pull from,
so publishing there would let those users install normally instead of
downloading a `.vsix` by hand. Sign in at [open-vsx.org](https://open-vsx.org)
with GitHub, sign the publisher agreement, create an access token, and add it as
the `OVSX_PAT` secret. The release workflow already has the step, guarded on
that secret existing.
