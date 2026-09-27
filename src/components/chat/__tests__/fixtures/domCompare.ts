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

/** Canonical form of an element subtree: tag names in document order, then text. */
export function canonicalDom(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return `#text(${node.nodeValue ?? ""})`;
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
