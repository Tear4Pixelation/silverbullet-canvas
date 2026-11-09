---
name: Library/Tear4Pixelation/Canvas
tags: meta/library
files:
- canvas.plug.js
---
# Canvas

A lightweight editor for [JSON Canvas](https://jsoncanvas.org) (`.canvas`) files, the format Obsidian uses for its canvases. Open any `.canvas` file in your space and it opens in the canvas editor. Files stay Obsidian-compatible: unknown properties and the original formatting are kept.

## Usage
* `Canvas: New` creates a canvas next to the current page and opens it.
* `/canvas` creates a canvas and inserts a link to it.
* Open existing `.canvas` files with the document picker or a link like `[[Board.canvas]]`.

## In the editor
* **Double-click** empty space to add a card. Double-click a card (or press `Enter`) to edit its Markdown. Press `Esc` or click outside to finish.
* **Drag** a card to move it. Drag the corner grip to resize. Hold `Alt` to turn off grid snapping.
* **Connect** cards by dragging one of the dots on a card's edge onto another card. Drop it on empty space to create a new connected card.
* **Pan** by dragging empty space, scrolling, or holding `Space` or the middle mouse button. **Zoom** with `Ctrl`+scroll or a pinch.
* **Select** several items by `Shift`-dragging a box or `Shift`-clicking. Dragging a group moves everything inside it.
* The toolbar adds cards, pages/documents from your space, web links and groups. The selection bar sets colors, arrow ends and labels.
* Keys: `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo, `Del` delete, `Ctrl+D` duplicate, `Ctrl+C`/`Ctrl+V` copy and paste, arrow keys nudge, `Shift+1` zoom to fit, `Shift+0` reset zoom.
* `[[Wiki links]]` in cards and file cards navigate to the page.
