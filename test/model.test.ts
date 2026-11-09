import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCanvas, serializeCanvas } from "../editor/src/model.ts";
import { History } from "../editor/src/history.ts";
import { renderMarkdown, toggleTask } from "../editor/src/markdown.ts";

const demo = readFileSync(new URL("../editor/demo.canvas", import.meta.url), "utf8");

test("Obsidian-formatted file re-serializes byte for byte", () => {
  const parsed = parseCanvas(demo);
  assert.equal(parsed.format.style, "obsidian");
  assert.equal(serializeCanvas(parsed.data, parsed.format), demo);
});

test("pretty-printed JSON keeps its indentation", () => {
  const source = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "x", x: 0, y: 0, width: 10, height: 10 }], edges: [] }, null, 2);
  const parsed = parseCanvas(source);
  assert.equal(parsed.format.style, "json");
  assert.equal(serializeCanvas(parsed.data, parsed.format), source);
});

test("minified JSON stays minified", () => {
  const source = '{"nodes":[{"id":"a","type":"group","x":1,"y":2,"width":3,"height":4}],"edges":[]}';
  const parsed = parseCanvas(source);
  assert.equal(serializeCanvas(parsed.data, parsed.format), source);
});

test("editing one field leaves everything else, including unknown keys, untouched", () => {
  const parsed = parseCanvas(demo);
  const node = parsed.data.nodes.find((candidate) => candidate.id === "5d6e7f809a1b2c3d")!;
  node.x += 40;
  const output = serializeCanvas(parsed.data, parsed.format);
  const before = demo.split("\n"), after = output.split("\n");
  assert.equal(after.length, before.length);
  const changed = after.filter((line, index) => line !== before[index]);
  assert.equal(changed.length, 1);
  assert.match(changed[0], /"x":660/);
  assert.match(changed[0], /"customPluginData":\{"keep":true,"nested":\[1,2,3\]\}/);
  const reparsed = JSON.parse(output);
  assert.deepEqual(reparsed.metadata, { version: "1.0-1.0", frontmatter: {} });
  assert.equal(reparsed.edges.find((edge: { id: string }) => edge.id === "e4d5e6f708192a3b").weight, 3);
});

test("files without edges key do not gain one", () => {
  const source = '{"nodes":[]}';
  const parsed = parseCanvas(source);
  assert.equal(serializeCanvas(parsed.data, parsed.format), source);
});

test("empty file becomes an empty Obsidian canvas", () => {
  const parsed = parseCanvas("");
  assert.deepEqual(parsed.data, { nodes: [], edges: [] });
  assert.equal(serializeCanvas(parsed.data, parsed.format), '{\n\t"nodes":[],\n\t"edges":[]\n}');
});

test("invalid JSON throws instead of producing an empty canvas", () => {
  assert.throws(() => parseCanvas("{nope"));
  assert.throws(() => parseCanvas("[1,2]"));
});

test("history undo/redo restores objects and order", () => {
  const parsed = parseCanvas(demo);
  const data = parsed.data;
  const history = new History(() => data);
  const original = JSON.stringify(data);

  history.begin([]);
  history.touchNode(data.nodes[1].id);
  data.nodes[1].x = 999;
  history.touchNode(data.nodes[3].id);
  const removed = data.nodes.splice(3, 1);
  history.touchNode("new");
  data.nodes.push({ id: "new", type: "text", text: "hi", x: 0, y: 0, width: 1, height: 1 });
  assert.equal(history.commit(), true);
  const edited = JSON.stringify(data);

  history.undo();
  assert.equal(JSON.stringify(data), original);
  history.redo();
  assert.equal(JSON.stringify(data), edited);
  assert.ok(!data.nodes.some((node) => node.id === removed[0].id));
});

test("no-op transactions are not recorded", () => {
  const parsed = parseCanvas(demo);
  const history = new History(() => parsed.data);
  history.begin([]);
  history.touchNode(parsed.data.nodes[0].id);
  assert.equal(history.commit(), false);
  assert.equal(history.canUndo, false);
});

test("markdown output is sanitized", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>bad()</script>');
  assert.ok(!/<img|<script|href="javascript/i.test(html), html);
  assert.match(renderMarkdown("[[Some Page|alias]]"), /data-page="Some Page">alias</);
  assert.match(renderMarkdown("- [x] done\n- [ ] todo"), /checked/);
  assert.match(renderMarkdown("**b** and *i* and `c`"), /<strong>b<\/strong> and <em>i<\/em> and <code>c<\/code>/);
});

test("toggling a rendered task flips the matching source line", () => {
  const source = "- [ ] one\n```\n- [ ] not a task\n```\n> - [x] quoted\n1. [ ] numbered";
  const rendered = renderMarkdown(source);
  assert.equal((rendered.match(/cv-task-box/g) ?? []).length, 3);
  assert.equal(toggleTask(source, 0), source.replace("- [ ] one", "- [x] one"));
  assert.equal(toggleTask(source, 1), source.replace("> - [x] quoted", "> - [ ] quoted"));
  assert.equal(toggleTask(source, 2), source.replace("1. [ ] numbered", "1. [x] numbered"));
  assert.equal(toggleTask(source, 3), null);
});
