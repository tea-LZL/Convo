/**
 * Structural DOM comparison for streaming parity tests.
 *
 * Why this exists: comparing `el.innerHTML` against a rendered HTML
 * *string* is the wrong oracle. It reports false failures for purely
 * cosmetic serialization differences — a text node built with
 * `document.createTextNode("'")` serializes back as `'`, while the
 * same character emitted by an HTML-escaping renderer serializes as
 * `&#39;`. The two render identically to a user; the strings differ.
 *
 * So compare the parsed structures instead: tag name, then children in
 * order, with text content compared as its resolved character data.
 * Entity encoding cannot survive that, which is the point.
 */

/**
 * Elements whose text content is rendered inline, where a whitespace-only
 * text node is meaningful. Everywhere else, whitespace between block
 * elements is collapsed away by the browser and cannot affect what a user
 * sees, so it is excluded from the comparison.
 */
const INLINE_CONTEXT = new Set([
  "a", "abbr", "b", "bdo", "big", "br", "button", "cite", "code", "del", "dfn", "em",
  "i", "img", "input", "kbd", "label", "mark", "q", "s", "samp", "small", "span",
  "strong", "sub", "sup", "time", "tt", "u", "var", "wbr",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "th", "dt", "dd", "pre", "summary",
]);

/**
 * Canonical form of an element subtree: tag names in document order, then
 * text. Whitespace-only text nodes are dropped outside inline contexts,
 * because react-markdown emits a bare "\n" between block elements when it
 * renders a whole message, and omits it when the blocks are rendered
 * separately — visually identical, structurally different.
 */
export function canonicalDom(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue ?? "";
    if (value.trim() === "" && !isInlineContext(node.parentNode)) return "";
    return `#text(${value})`;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    // Comments (including the renderer's <!--tail--> marker) carry no
    // rendered content, so they are deliberately excluded.
    return "";
  }
  const el = node as Element;
  const children = [...el.childNodes].map(canonicalDom).filter(Boolean);
  return `<${el.tagName.toLowerCase()}>${children.join("")}</${el.tagName.toLowerCase()}>`;
}

function isInlineContext(parent: Node | null): boolean {
  if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return false;
  return INLINE_CONTEXT.has((parent as Element).tagName.toLowerCase());
}

/**
 * Canonical form of an HTML string's CONTENTS, parsed in a detached
 * element. The scratch wrapper is excluded so this is directly
 * comparable to `canonicalElement`.
 */
export function canonicalHtml(html: string): string {
  const scratch = document.createElement("div");
  scratch.innerHTML = html;
  return canonicalElement(scratch);
}

/** Canonical form of a live element's contents. */
export function canonicalElement(el: Element): string {
  return [...el.childNodes].map(canonicalDom).filter(Boolean).join("");
}

/** Canonical text content — entity encoding cannot affect this. */
export function textOf(node: Node): string {
  return node.textContent ?? "";
}
