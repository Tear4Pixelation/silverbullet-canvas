// In-card Markdown editor: CodeMirror 6 with SilverBullet-style live preview.
// Markup is hidden except where the cursor is, headings/emphasis/links render
// in place, and tokens carry SilverBullet's own CSS class names (sb-h1,
// sb-strong, sb-wiki-link, ...) so the host's editor styles apply as-is.

import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, drawSelection } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { EditorSelection, EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { defineLanguageFacet, HighlightStyle, Language, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { GFM, parser } from "@lezer/markdown";
import { styleTags, Tag, tags } from "@lezer/highlight";

export interface CardEditorCallbacks {
  finish(): void;
  navigate(page: string): void;
  openUrl(url: string): void;
}

export interface CardEditor {
  getText(): string;
  focus(): void;
  destroy(): void;
}

export type CardEditorFactory = (parent: HTMLElement, text: string, callbacks: CardEditorCallbacks) => CardEditor;

// ---------- SilverBullet syntax extensions ----------

const wikiLinkTag = Tag.define();
const hashtagTag = Tag.define();
const highlightTag = Tag.define();

function inlineSpan(name: string, markName: string, open: string, close: string, tag: Tag, before: string): MarkdownConfig {
  return {
    defineNodes: [{ name, style: tag }, { name: markName, style: tags.processingInstruction }],
    parseInline: [{
      name,
      before,
      parse(cx: InlineContext, _next: number, pos: number) {
        if (cx.slice(pos, pos + open.length) !== open) return -1;
        const rest = cx.slice(pos + open.length, cx.end);
        const closeAt = rest.indexOf(close);
        if (closeAt <= 0 || rest.slice(0, closeAt).includes("\n")) return -1;
        const end = pos + open.length + closeAt + close.length;
        return cx.addElement(cx.elt(name, pos, end, [
          cx.elt(markName, pos, pos + open.length),
          cx.elt(markName, end - close.length, end),
        ]));
      },
    }],
  };
}

const Hashtag: MarkdownConfig = {
  defineNodes: [{ name: "Hashtag", style: hashtagTag }],
  parseInline: [{
    name: "Hashtag",
    parse(cx, next, pos) {
      if (next !== 35 /* # */) return -1;
      if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) return -1;
      const match = /^#[\p{L}\p{N}_/-]+/u.exec(cx.slice(pos, cx.end));
      if (!match || match[0].length < 2) return -1;
      return cx.addElement(cx.elt("Hashtag", pos, pos + match[0].length));
    },
  }],
};

const markdownLanguage = new Language(
  defineLanguageFacet({ name: "markdown" }),
  parser.configure([
    GFM,
    inlineSpan("WikiLink", "WikiLinkMark", "[[", "]]", wikiLinkTag, "Link"),
    inlineSpan("Highlight", "HighlightMark", "==", "==", highlightTag, "Emphasis"),
    Hashtag,
    { props: [styleTags({ "Task/TaskMarker": tags.atom })] },
  ]),
  [],
  "markdown",
);

// Token classes mirror SilverBullet's editorHighlightStyle().
const highlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "sb-h1" },
  { tag: tags.heading2, class: "sb-h2" },
  { tag: tags.heading3, class: "sb-h3" },
  { tag: tags.heading4, class: "sb-h4" },
  { tag: tags.heading5, class: "sb-h5" },
  { tag: tags.heading6, class: "sb-h6" },
  { tag: tags.strong, class: "sb-strong" },
  { tag: tags.emphasis, class: "sb-emphasis" },
  { tag: tags.strikethrough, class: "sb-strikethrough" },
  { tag: tags.monospace, class: "sb-code" },
  { tag: tags.link, class: "sb-link" },
  { tag: tags.url, class: "sb-url" },
  { tag: tags.processingInstruction, class: "sb-meta" },
  { tag: tags.quote, class: "sb-quote" },
  { tag: tags.list, class: "sb-list" },
  { tag: tags.atom, class: "sb-task-mark" },
  { tag: wikiLinkTag, class: "sb-wiki-link" },
  { tag: hashtagTag, class: "sb-hashtag" },
  { tag: highlightTag, class: "sb-highlight" },
]);

// ---------- live preview ----------

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly at: number) { super(); }
  eq(other: CheckboxWidget) { return other.checked === this.checked && other.at === this.at; }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cv-task-box";
    box.dataset.at = String(this.at);
    return box;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "cv-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

class CalloutWidget extends WidgetType {
  constructor(readonly kind: string) { super(); }
  eq(other: CalloutWidget) { return other.kind === this.kind; }
  toDOM() {
    const label = document.createElement("span");
    label.className = "cv-callout-label";
    label.dataset.callout = this.kind.toLowerCase();
    label.textContent = this.kind.charAt(0).toUpperCase() + this.kind.slice(1).toLowerCase();
    return label;
  }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const rule = document.createElement("span"); rule.className = "cv-hr"; return rule; }
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const lineClass = (cls: string) => Decoration.line({ class: cls });

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  const selection = state.selection.ranges;
  const touches = (from: number, to: number) => selection.some((range) => range.from <= to && range.to >= from);
  const touchesLines = (from: number, to: number) =>
    touches(state.doc.lineAt(from).from, state.doc.lineAt(to).to);
  const eachLine = (from: number, to: number, cls: string) => {
    for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
      ranges.push(lineClass(cls).range(line.from));
      if (line.to >= to || line.number === state.doc.lines) break;
    }
  };
  const hideChildren = (node: { from: number; to: number; node: any }, names: string[]) => {
    const cursor = node.node.cursor();
    if (!cursor.firstChild()) return;
    do {
      if (names.includes(cursor.name) && cursor.to > cursor.from) ranges.push(hidden.range(cursor.from, cursor.to));
    } while (cursor.nextSibling());
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          ranges.push(lineClass(`sb-line-h${heading[1]}`).range(state.doc.lineAt(node.from).from));
          if (!touchesLines(node.from, node.to)) {
            const mark = node.node.getChild("HeaderMark");
            if (mark) ranges.push(hidden.range(mark.from, Math.min(mark.to + 1, node.to)));
          }
          return;
        }
        switch (name) {
          case "Emphasis": case "StrongEmphasis": case "InlineCode": case "Strikethrough": case "Highlight":
            if (!touches(node.from, node.to)) hideChildren(node, ["EmphasisMark", "CodeMark", "StrikethroughMark", "HighlightMark"]);
            break;
          case "Link": {
            // "> [!note] Title" callouts (Obsidian and SilverBullet admonitions).
            const callout = /^\[!(\w+)\]$/.exec(state.sliceDoc(node.from, node.to));
            if (callout) {
              if (!touchesLines(node.from, node.to)) ranges.push(Decoration.replace({ widget: new CalloutWidget(callout[1]) }).range(node.from, node.to));
              break;
            }
            if (!touches(node.from, node.to)) {
              const url = node.node.getChild("URL");
              if (url) ranges.push(Decoration.mark({ attributes: { "data-href": state.sliceDoc(url.from, url.to) } }).range(node.from, node.to));
              hideChildren(node, ["LinkMark", "URL", "LinkTitle"]);
            }
            break;
          }
          case "WikiLink": {
            const inner = state.sliceDoc(node.from + 2, node.to - 2);
            const [page, alias] = inner.split("|");
            ranges.push(Decoration.mark({ class: "sb-wiki-link-page", attributes: { "data-page": page.trim() } }).range(node.from, node.to));
            if (!touches(node.from, node.to)) {
              hideChildren(node, ["WikiLinkMark"]);
              if (alias !== undefined) ranges.push(hidden.range(node.from + 2, node.from + 2 + page.length + 1));
            }
            break;
          }
          case "TaskMarker":
            if (!touches(node.from, node.to)) {
              const checked = /x/i.test(state.sliceDoc(node.from, node.to));
              ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
            }
            break;
          case "ListItem":
            ranges.push(lineClass("sb-line-li").range(state.doc.lineAt(node.from).from));
            break;
          case "ListMark": {
            const text = state.sliceDoc(node.from, node.to);
            const isTask = /^\s*\[[ xX]\]/.test(state.sliceDoc(node.to, node.to + 5));
            if (/^[-*+]$/.test(text) && !touchesLines(node.from, node.to)) {
              ranges.push((isTask ? hidden : bullet).range(node.from, isTask ? node.to + 1 : node.to));
            }
            break;
          }
          case "Blockquote":
            eachLine(node.from, node.to, "sb-line-blockquote");
            break;
          case "QuoteMark":
            if (!touchesLines(node.from, node.to)) ranges.push(hidden.range(node.from, Math.min(node.to + 1, state.doc.lineAt(node.from).to)));
            break;
          case "FencedCode":
            eachLine(node.from, node.to, "sb-line-code cv-line-code");
            break;
          case "HorizontalRule":
            if (!touchesLines(node.from, node.to)) ranges.push(rule.range(node.from, node.to));
            break;
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildDecorations(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

// ---------- editing commands ----------

function wrapSelection(marker: string) {
  return (view: EditorView) => {
    view.dispatch(view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
        const inner = text.slice(marker.length, text.length - marker.length);
        return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
      }
      return {
        changes: { from: range.from, to: range.to, insert: marker + text + marker },
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      };
    }));
    return true;
  };
}

// Enter continues lists and tasks; Enter on an empty item ends the list.
function continueList(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const match = /^(\s*(?:>\s*)*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/.exec(line.text);
  if (!match || range.head < line.from + match[0].length) return false;
  if (line.text.slice(match[0].length).trim() === "") {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, selection: { anchor: line.from } });
    return true;
  }
  const marker = match[3] ? `${Number(match[3]) + 1}${match[4]}` : match[2];
  const insert = `\n${match[1]}${marker}${match[5]}${match[6] ? "[ ] " : ""}`;
  view.dispatch({ changes: { from: range.head, insert }, selection: { anchor: range.head + insert.length }, scrollIntoView: true });
  return true;
}

function toggleTask(view: EditorView, at: number) {
  const current = view.state.sliceDoc(at, at + 3);
  const insert = /x/i.test(current) ? "[ ]" : "[x]";
  view.dispatch({ changes: { from: at, to: at + 3, insert } });
}

// ---------- factory ----------

export const createCardEditor: CardEditorFactory = (parent, text, callbacks) => {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.length },
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdownLanguage,
        syntaxHighlighting(highlightStyle),
        livePreview,
        keymap.of([
          { key: "Escape", run: () => { callbacks.finish(); return true; } },
          { key: "Mod-Enter", run: () => { callbacks.finish(); return true; } },
          { key: "Enter", run: continueList },
          { key: "Tab", run: indentMore, shift: indentLess },
          { key: "Mod-b", run: wrapSelection("**") },
          { key: "Mod-i", run: wrapSelection("_") },
          { key: "Mod-Shift-x", run: wrapSelection("~~") },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.domEventHandlers({
          mousedown(event, editorView) {
            const target = event.target as HTMLElement;
            if (target.classList.contains("cv-task-box")) {
              event.preventDefault();
              toggleTask(editorView, Number(target.dataset.at));
              return true;
            }
            // Rendered links are followed on click, like in SilverBullet; with the
            // cursor inside, the markup shows and clicks edit instead.
            const page = target.closest<HTMLElement>("[data-page]");
            if (page && !page.querySelector(".sb-meta") && !page.classList.contains("sb-meta")) {
              event.preventDefault();
              callbacks.navigate(page.dataset.page!);
              return true;
            }
            const link = target.closest<HTMLElement>("[data-href]");
            if (link && !link.querySelector(".sb-url")) {
              event.preventDefault();
              const href = link.dataset.href!;
              if (/^[a-z][a-z0-9+.-]*:/i.test(href)) callbacks.openUrl(href); else callbacks.navigate(href);
              return true;
            }
            return false;
          },
          focusout(event, editorView) {
            if (!editorView.dom.contains(event.relatedTarget as Node | null)) callbacks.finish();
            return false;
          },
        }),
      ],
    }),
  });
  view.dom.classList.add("cv-cm");
  return {
    getText: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
};
