# silverbullet-canvas

A fast editor for [JSON Canvas](https://jsoncanvas.org) (`.canvas`) files, shipped as a [SilverBullet](https://silverbullet.md) plug. It is Obsidian-compatible and has no UI framework. The only dependency is CodeMirror, for editing Markdown inside cards. Read-only previews ship without it.

## Install

In SilverBullet, run `Library: Install` and enter:

```
https://github.com/Tear4Pixelation/silverbullet-canvas/blob/main/PLUG.md
```

Then open any `.canvas` file, or run `Canvas: New`. See [PLUG.md](PLUG.md) for usage and keyboard shortcuts.

There's also a standalone version, `canvas-editor.html`, attached to the [edge release](https://github.com/Tear4Pixelation/silverbullet-canvas/releases/tag/edge). It's a single file that opens and saves `.canvas` files in any modern browser.

## Features

* Text (Markdown), file, link and group nodes. Edges have sides, arrow ends, colors and labels.
* Cards are Markdown, edited in place with SilverBullet-style live preview (CodeMirror). Tokens use SilverBullet's own CSS classes and its editor styles are mirrored in, including your Space Style.
* Read-only previews on any page through a ```` ```canvas ```` block or `canvas.render()` in Lua. They have scroll lock, zoom to fit, an open-in-editor button and drag-to-resize.
* Drag, resize, grid snap, box select, group drag, copy/paste, duplicate and undo/redo.
* File nodes show page previews and images from your space. Wiki links navigate within SilverBullet.
* The theme follows SilverBullet: its live CSS variables and fonts are mirrored, light and dark.
* Lossless round trip:
  * An unedited file is saved back byte for byte.
  * Edits change only the touched lines, in Obsidian's own layout (one object per line).
  * Unknown properties and key order are kept.
* Performance:
  * One CSS-transformed layer handles pan and zoom.
  * Updates are dirty-tracked and batched per frame.
  * Off-screen cards are culled and their content is built only when it scrolls into view.
  * A low-detail mode applies when zoomed far out.
  * Undo history stores patches.

  With 3,000 cards and 3,000 edges, a canvas loads in about 0.4 s, and panning, zooming and dragging run within a 60 fps frame.

## Develop

```
npm install
npm run build        # editor bundle + dist/canvas-editor.html + canvas.plug.js
npm test             # round-trip, history and sanitizer tests
```

`dist/harness.html` loads the plug's editor and preview the way SilverBullet hosts them. Use it for testing without a server. Serve `dist/` with any static server.
* The editor uses the document-editor `srcdoc` iframe with its bridge shim, `file-open`/`request-save`/`file-saved`, syscalls and theme messages.
* The preview uses the code-widget sandbox, with `globalThis.syscall` and `setHeight`.

Layout:
* `editor/src/` holds the TypeScript sources. `main.ts` is the document editor, `widget.ts` the preview, and `cardeditor.ts` the CodeMirror card editor.
* `canvas.ts` and `canvas.plug.yaml` are the plug.
* `build.mjs` bundles both and inlines them into the plug.

## License

MIT
