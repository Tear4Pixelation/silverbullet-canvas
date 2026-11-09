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
* `/canvas` creates a canvas and embeds a preview of it on the current page.
* `/canvas-embed` (or `Canvas: Embed`) embeds a preview of an existing canvas.
* `/canvas-link` creates a canvas and inserts a `[[link]]` to it.
* Open existing `.canvas` files from the document picker or a link like `[[Board.canvas]]`.

## Previews
A preview is a code block:

    ```canvas
    url: Boards/Plan.canvas
    height: 400px
    ```

* Previews are read-only and locked by default: scrolling over one scrolls the page. Click 🔒 to pan and zoom inside it.
* ✎ opens the canvas in the editor.
* Drag the bottom edge to resize. The new height is saved into the block.

From Lua, use `${canvas.render("Boards/Plan.canvas", 400)}`. This renders the same preview without a resize handle, because there is no block to save the height into.

## In the editor
* **Cards are Markdown.** Double-click a card (or press `Enter`) to edit it in place, with SilverBullet-style live preview: markup is hidden except where the cursor is. Lists and tasks continue on `Enter`. Use `Ctrl+B`/`Ctrl+I` for bold and italic, and `Esc` to finish. Tasks can be ticked without opening the card. `[[Wiki links]]` navigate.
* **Drag** a card to move it. Drag the corner grip to resize. Hold `Alt` to turn off grid snapping.
* **Connect** cards by dragging one of the dots on a card's edge onto another card. Drop it on empty space to create a new connected card.
* **Pan** by dragging empty space, scrolling, or holding `Space` or the middle mouse button. **Zoom** with `Ctrl`+scroll or a pinch.
* **Select** several items by `Shift`-dragging a box or `Shift`-clicking. Dragging a group moves everything inside it.
* The toolbar adds cards, pages/documents from your space, web links and groups. The selection bar sets colors, arrow ends and labels.
* Keys: `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo, `Del` delete, `Ctrl+D` duplicate, `Ctrl+C`/`Ctrl+V` copy and paste, arrow keys nudge, `Shift+1` zoom to fit, `Shift+0` reset zoom.

## Lua helper

```space-lua
canvas = canvas or {}

-- Read-only preview of a .canvas file, e.g. ${canvas.render("Boards/Plan.canvas", 400)}
function canvas.render(path, height)
  local body = "url: " .. path .. "\nheight: " .. tostring(height or 400) .. "px"
  local rendered = codeWidget.render("canvas", body, "")
  if not rendered then
    return "Canvas plug is not loaded"
  end
  return widget.sandbox {
    html = rendered.html,
    script = rendered.script,
    markdown = "[[" .. path .. "]]",
  }
end
```
