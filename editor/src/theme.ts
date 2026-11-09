// SilverBullet hosts both the document editor (srcdoc) and code widgets
// (about:blank) in same-origin iframes, so the host's live CSS variables,
// @font-face rules and editor styles can be mirrored for a native look.

function hostDocument(): Document | null {
  try {
    if (window.parent === window) return null;
    return window.parent.document ?? null;
  } catch {
    return null;
  }
}

function eachRule(rules: CSSRuleList, visit: (rule: CSSRule) => string | null): string {
  let out = "";
  for (const rule of Array.from(rules)) {
    const kind = rule.constructor.name;
    if (kind === "CSSMediaRule" || kind === "CSSSupportsRule" || kind === "CSSLayerBlockRule") {
      const grouping = rule as CSSGroupingRule;
      const inner = eachRule(grouping.cssRules, visit);
      if (inner) out += rule.cssText.slice(0, rule.cssText.indexOf("{") + 1) + inner + "}\n";
      continue;
    }
    const text = visit(rule);
    if (text) out += text + "\n";
  }
  return out;
}

function resolveUrls(cssText: string, base: string): string {
  return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, _quote, url) => {
    try { return `url("${new URL(url, base).href}")`; } catch { return match; }
  });
}

/**
 * Copies the host's CSS variables and fonts and keeps the theme in sync.
 * With `editorStyles`, also copies SilverBullet's editor rules, rescoped from
 * `#sb-main`/`#sb-editor` to `.cv-sb`, so card editors look like the page editor
 * (including the user's Space Style).
 */
export function mirrorHostTheme(editorStyles: boolean) {
  const host = hostDocument();
  if (!host) return;
  const sync = () => {
    const hostRoot = host.documentElement;
    const computed = window.parent.getComputedStyle(hostRoot);
    const style = document.documentElement.style;
    for (let i = 0; i < computed.length; i++) {
      const name = computed[i];
      if (name.startsWith("--")) style.setProperty(name, computed.getPropertyValue(name));
    }
    const theme = hostRoot.getAttribute("data-theme");
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  };
  sync();
  // Timer rather than rAF: rAF doesn't run in background tabs.
  const observer = new MutationObserver(() => setTimeout(sync, 0));
  observer.observe(host.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });

  let css = "";
  for (const sheet of Array.from(host.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    const base = sheet.href ?? host.baseURI;
    css += eachRule(rules, (rule) => {
      const kind = rule.constructor.name;
      if (kind === "CSSFontFaceRule") return resolveUrls(rule.cssText, base);
      if (!editorStyles || kind !== "CSSStyleRule") return null;
      const selector = (rule as CSSStyleRule).selectorText;
      if (!/\.(sb|cm)-/.test(selector)) return null;
      // Only the editor's own rules; panels, top bar etc. never match anything here.
      const scoped = selector.replace(/#sb-main|#sb-editor/g, ".cv-sb");
      if (!scoped.includes(".cv-sb") && !/^\s*\.(sb|cm)-/.test(scoped)) return null;
      return resolveUrls(rule.cssText.replace(selector, scoped), base);
    });
  }
  if (css) {
    const style = document.createElement("style");
    style.id = "cv-host-styles";
    style.textContent = css;
    // Appended last; the canvas's own overrides use higher specificity to win.
    document.head.appendChild(style);
  }
}
