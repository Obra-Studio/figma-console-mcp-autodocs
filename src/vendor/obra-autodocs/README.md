# Vendored: Obra Autodocs

`code.js` is vendored verbatim from the **Obra Autodocs** Figma plugin
(`/Users/johanronsse/Sites/obra-autodocs-2`), so its labeled variant-grid
documentation can be generated from inside the Desktop Bridge sandbox via
`figma_generate_autodocs` / `figma_remove_autodocs` — without running the
plugin (which would swap the active plugin and tear down the Bridge connection).

## Files
- `code.js` — vendored plugin source (do not edit here; edit upstream).
- `autodocs-body.js` — generated: `code.js` with its three top-level UI-init
  statements stripped (font IIFE, the `if (_command === 'open')` block, and the
  `figma.ui.onmessage` handler). The latter two would hijack the Bridge's own
  UI/message channel, so they must go. For inspection only.
- `autodocs-body.generated.ts` — generated: the same body embedded as a string
  so it compiles into `dist/` (only `dist/` ships in the npm package).

## Re-syncing when the plugin updates
```bash
cp /Users/johanronsse/Sites/obra-autodocs-2/code.js src/vendor/obra-autodocs/code.js
npm run build:autodocs   # re-strips + re-embeds; fails loudly if anchors moved
npm run build:local
```
The plugin has been stable for months, so this is rare. If `build:autodocs`
throws "Anchor not found", the init statements in `code.js` changed shape —
update `ANCHORS` in `scripts/build-autodocs-runtime.mjs`.

Vendored from commit `309bcb2` (branch `experiment/autodocs-skill`).
