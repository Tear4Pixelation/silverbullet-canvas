// Small Markdown renderer for card content. Input is HTML-escaped first, so the
// only markup in the output is what this file emits. Link targets are limited
// to safe schemes; wiki links become data-page anchors handled by the editor.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // javascript:, data:, ...
  return trimmed;
}

// Operates on already-escaped text.
function inline(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;

  let out = text
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`))
    .replace(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_, page, alias) =>
      keep(`<a class="cv-wikilink" data-page="${page}">${alias || page}</a>`))
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_, page, alias) =>
      keep(`<a class="cv-wikilink" data-page="${page}">${alias || page}</a>`))
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, url) => {
      const safe = safeUrl(url.replace(/&amp;/g, "&"));
      return safe && /^https?:/i.test(safe) ? keep(`<img alt="${alt}" src="${escapeHtml(safe)}" loading="lazy">`) : match;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const safe = safeUrl(url.replace(/&amp;/g, "&"));
      if (!safe) return match;
      if (/^[a-z][a-z0-9+.-]*:/i.test(safe)) {
        return keep(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      }
      return keep(`<a class="cv-wikilink" data-page="${escapeHtml(safe)}">${label}</a>`);
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_, lead, url) =>
      lead + keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`))
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/==(?=\S)([\s\S]*?\S)==/g, "<mark>$1</mark>")
    .replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, '$1<span class="cv-tag">#$2</span>');

  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)]);
  return out;
}

const cache = new Map<string, string>();

export function renderMarkdown(source: string): string {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const html = render(source);
  if (cache.size > 2000) cache.clear();
  cache.set(source, html);
  return html;
}

function render(source: string): string {
  const lines = escapeHtml(source.replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  const listStack: { type: "ul" | "ol"; indent: number }[] = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeLists = (toIndent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
      out.push(`</li></${listStack.pop()!.type}>`);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Frontmatter at the very top is hidden, like in SilverBullet.
    if (i === 0 && line === "---") {
      const end = lines.indexOf("---", 1);
      if (end > 0) { i = end; continue; }
    }

    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flushParagraph(); closeLists();
      const body: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i]);
      out.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }

    if (!line.trim()) { flushParagraph(); closeLists(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); closeLists();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushParagraph(); closeLists(); out.push("<hr>"); continue; }

    if (/^&gt;/.test(line)) {
      flushParagraph(); closeLists();
      const quote: string[] = [];
      for (; i < lines.length && /^&gt;/.test(lines[i]); i++) quote.push(lines[i].replace(/^&gt;\s?/, ""));
      i--;
      const callout = /^\[!(\w+)\][-+]?\s*(.*)$/.exec(quote[0] ?? "");
      if (callout) {
        quote.shift();
        out.push(`<blockquote class="cv-callout" data-callout="${callout[1].toLowerCase()}"><div class="cv-callout-title">${inline(callout[2] || callout[1])}</div>${render(unescape(quote.join("\n")))}</blockquote>`);
      } else {
        out.push(`<blockquote>${render(unescape(quote.join("\n")))}</blockquote>`);
      }
      continue;
    }

    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushParagraph(); closeLists();
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inline(cell.trim()));
      const head = cells(line);
      i += 2;
      const rows: string[] = [];
      for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) {
        rows.push(`<tr>${cells(lines[i]).map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
      }
      i--;
      out.push(`<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1].replace(/\t/g, "  ").length;
      const type = /\d/.test(item[2]) ? "ol" : "ul";
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        listStack.push({ type, indent });
        out.push(`<${type}><li>`);
      } else {
        closeLists(indent);
        out.push("</li><li>");
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      out.push(task
        ? `<input type="checkbox" class="cv-task-box"${task[1] === " " ? "" : " checked"}> ${inline(task[2])}`
        : inline(item[3]));
      continue;
    }

    if (listStack.length && /^\s+/.test(line)) { out.push(" " + inline(line.trim())); continue; }
    closeLists();
    paragraph.push(line);
  }
  flushParagraph(); closeLists();
  return out.join("");
}

// Reverse escapeHtml for nested blocks that are re-rendered (they get escaped again).
function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity as "amp"]);
}

// Flips the index-th task checkbox (in rendering order) in the source text.
// Fenced code is skipped, matching what renderMarkdown turns into checkboxes.
export function toggleTask(source: string, index: number): string | null {
  const lines = source.split("\n");
  let fence: string | null = null;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = /^\s*(```|~~~)/.exec(lines[i]);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]; else if (fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const task = /^(\s*(?:>\s?)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s)/.exec(lines[i]);
    if (!task) continue;
    if (seen++ === index) {
      lines[i] = task[1] + (task[2] === " " ? "x" : " ") + lines[i].slice(task[1].length + 1);
      return lines.join("\n");
    }
  }
  return null;
}
