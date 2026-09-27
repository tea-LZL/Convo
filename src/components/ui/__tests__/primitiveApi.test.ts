/**
 * The shared primitives' prop signatures, pinned.
 *
 * The plan's one rule with teeth: **no primitive gains or loses a prop.**
 * The reasoning is that a new prop on a shared primitive is an API every
 * future caller has to understand, and this redesign is a visual change,
 * not an API change. If a primitive seems to need a new prop to express
 * the new look, the design is wrong — not the prop missing.
 *
 * A rule nothing enforces is a rule in a comment. `tsc` covers half of
 * it: if a prop disappears or changes type, this repository's ~200
 * callers stop compiling, and `npm run typecheck` is a gate. But a prop
 * that is merely *added* is backwards-compatible, compiles everywhere,
 * and is exactly the drift the rule exists to stop — so that half needs
 * a tripwire, and here it is. Adding a prop fails this file before it
 * reaches a reviewer.
 *
 * The cost is deliberate and worth naming: the list below is a second
 * copy of each signature. Editing a primitive's props means editing this
 * file too, and doing that on purpose — with the justification written
 * down — is the review this rule is asking for.
 *
 * Two shape notes, so a broken parse cannot turn this into a silent pass:
 * the prop list is read out of the source by regex, and an empty list
 * would satisfy every assertion below. Each entry therefore names a
 * `sentinel` prop that must be present, and each asserts the list is
 * non-empty before it is trusted.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

interface Declared {
  /** `name` when required, `name?` when optional. */
  signature: string;
  optional: boolean;
  name: string;
}

/**
 * Every primitive this redesign restyles, with the signature it must keep.
 *
 * `inherited` lists props the component destructures that it does not
 * declare itself — the HTML attribute interface it extends. Those belong
 * to `React.ButtonHTMLAttributes` and to the DOM, not to this
 * primitive's signature.
 */
const PRIMITIVES: Array<{
  file: string;
  component: string;
  props: string[];
  /** A prop that must be in the parsed list, so an empty parse cannot pass. */
  sentinel: string;
  inherited?: string[];
}> = [
  {
    file: "src/components/ui/Button.tsx",
    component: "Button",
    props: ["variant?", "size?", "loading?", "icon?", "rightIcon?", "fullWidth?"],
    sentinel: "variant",
    inherited: ["className", "children", "disabled", "ref"],
  },
  {
    file: "src/components/ui/IconButton.tsx",
    component: "IconButton",
    props: ["icon", "label", "onClick?", "variant?", "size?", "active?", "className?", "disabled?"],
    sentinel: "icon",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "Switch",
    props: ["checked", "onChange", "label?", "description?", "disabled?"],
    sentinel: "checked",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "TextInput",
    props: [
      "value", "onChange", "placeholder?", "type?", "autoFocus?", "onKeyDown?", "onBlur?",
      "className?", "disabled?", "maxLength?", "id?", "aria-label?", "aria-labelledby?",
      "aria-describedby?",
    ],
    sentinel: "value",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "TextArea",
    props: [
      "value", "onChange", "placeholder?", "rows?", "autoFocus?", "onKeyDown?", "className?",
      "disabled?", "id?", "aria-label?", "aria-labelledby?", "aria-describedby?",
    ],
    sentinel: "value",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "Select",
    props: [
      "value", "onChange", "options", "className?", "disabled?", "id?", "aria-label?",
      "aria-labelledby?", "aria-describedby?",
    ],
    sentinel: "options",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "Slider",
    props: ["value", "onChange", "min", "max", "step?", "formatValue?"],
    sentinel: "min",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "Tabs",
    props: ["tabs", "active", "onChange", "className?"],
    sentinel: "tabs",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "Badge",
    props: ["children", "variant?", "className?"],
    sentinel: "children",
  },
  {
    file: "src/components/ui/Form.tsx",
    component: "Tooltip",
    props: ["content", "children", "side?"],
    sentinel: "content",
  },
  {
    file: "src/components/ui/Modal.tsx",
    component: "Modal",
    props: [
      "open", "onClose", "title?", "description?", "children", "footer?", "size?",
      "closeOnEscape?", "closeOnBackdrop?",
    ],
    sentinel: "open",
  },
  {
    file: "src/components/ui/Panel.tsx",
    component: "Panel",
    props: ["children", "className?", "bordered?", "padded?"],
    sentinel: "bordered",
  },
  {
    file: "src/components/ui/Skeleton.tsx",
    component: "Skeleton",
    props: ["width?", "height?", "rounded?", "className?"],
    sentinel: "width",
  },
  {
    file: "src/components/ui/Dropdown.tsx",
    component: "Dropdown",
    props: ["trigger", "children", "align?", "className?", "menuClassName?", "portal?"],
    sentinel: "trigger",
  },
];

/* ── parsing ─────────────────────────────────────────────────────────── */

/**
 * The `{ … }` a function signature destructures, and where it ends.
 * Brace-balanced, because a default value or a type annotation can
 * legally contain braces between the signature's own.
 */
function destructuredBlock(src: string, component: string): { block: string; end: number } {
  const decl = src.match(
    new RegExp(
      `(?:function\\s+${component}\\s*\\(|${component}\\s*=\\s*(?:forwardRef<[^>]*>)?function\\s+${component}\\s*\\()\\s*\\{`,
    ),
  );
  const matched = decl?.[0] ?? "";
  expect(matched, `${component} must destructure its props in its signature`).not.toBe("");
  const open = src.indexOf("{", (decl?.index ?? 0) + matched.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { block: src.slice(open + 1, i), end: i };
  }
  throw new Error(`${component}: unbalanced destructuring block`);
}

/** The names a component destructures, defaults and renames stripped. */
function destructuredNames(src: string, component: string): string[] {
  return destructuredBlock(src, component)
    .block.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    // `...rest` is the escape hatch that would let any new prop through
    // unnoticed, so it is not a name and is asserted on separately.
    .filter((entry) => !entry.startsWith("..."))
    // `"aria-label": ariaLabel` is a rename, not a different prop.
    .map((entry) => entry.split(/[:=]/)[0].trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** `{ … }` starting at `from`, braces balanced. */
function balancedFrom(src: string, from: number, what: string): { block: string; end: number } {
  const open = src.indexOf("{", from);
  expect(open, `${what} must open with a brace`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { block: src.slice(open + 1, i), end: i };
  }
  throw new Error(`${what}: unbalanced block`);
}

/** The props a primitive declares, from its own interface or inline type. */
function declaredProps(file: string, component: string): Declared[] {
  const src = read(file);
  const { end } = destructuredBlock(src, component);

  // Its own `interface XProps`, where the name shares the component's
  // stem — `SelectProps` for `Select`, and so on. `extends` clauses are
  // skipped over: ButtonProps extends ButtonHTMLAttributes, so the brace
  // is not the one right after the name.
  const own = [...src.matchAll(/(?:export\s+)?interface\s+(\w*Props)[^{]*\{([\s\S]*?)\n\}/g)]
    .find((m) => m[1].startsWith(component));
  // Otherwise the inline type literal in the signature, as EmptyState and
  // Spinner declare theirs.
  const block = own ? own[2] : balancedFrom(src, end, `${component}'s inline prop type`).block;

  return [...block.matchAll(/^\s*(?:(["'])(.*?)\1|([A-Za-z_$][\w$]*))(\?)?:/gm)]
    .map((m) => {
      const name = m[2] ?? m[3];
      return { name, optional: m[4] === "?", signature: `${name}${m[4] ?? ""}` };
    })
    .filter((d) => !d.name.startsWith("..."));
}

/* ── the guard ───────────────────────────────────────────────────────── */

describe("no primitive gains or loses a prop", () => {
  it("keeps every primitive's signature exactly as it was", () => {
    for (const p of PRIMITIVES) {
      const declared = declaredProps(p.file, p.component);
      // Self-check: an empty or mangled parse would satisfy `toEqual`
      // for the wrong reason.
      expect(declared.length, `${p.component} must declare a readable prop list`).toBeGreaterThan(0);
      expect(
        declared.map((d) => d.name),
        `${p.component} must still declare ${p.sentinel}`,
      ).toContain(p.sentinel);

      expect(
        declared.map((d) => d.signature).sort(),
        `${p.component} in ${p.file} must keep its prop signature — no prop added, removed, renamed, or made optional. If a prop is genuinely needed, the design is wrong, not the prop missing.`,
      ).toEqual([...p.props].sort());
    }
  });

  it("reads every prop it declares", () => {
    for (const p of PRIMITIVES) {
      const declared = declaredProps(p.file, p.component).map((d) => d.name);
      expect(declared.length, `${p.component} must declare a readable prop list`).toBeGreaterThan(0);
      const destructured = destructuredNames(read(p.file), p.component);
      const inherited = p.inherited ?? [];
      for (const name of declared) {
        expect(
          [...destructured, ...inherited],
          `${p.component} declares ${name} but never destructures it`,
        ).toContain(name);
      }
    }
  });

  it("does not open a ...rest catch-all that would swallow the next prop", () => {
    for (const p of PRIMITIVES) {
      const { block } = destructuredBlock(read(p.file), p.component);
      // Only Button extends an HTML attribute interface, so only Button
      // has a legitimate reason to forward the rest of them.
      const restful = p.component === "Button";
      expect(
        /\.\.\./.test(block),
        `${p.component} must not destructure \`...rest\` — a catch-all defeats this whole file`,
      ).toBe(restful);
    }
  });

  it("renders the primitives this file pins, so none of them has gone missing", () => {
    // A component renamed or deleted would make several of the assertions
    // above fail on a parse error rather than on the thing they exist to
    // check. This says so plainly instead.
    for (const p of PRIMITIVES) {
      const src = read(p.file);
      expect(
        new RegExp(`export\\s+(?:const|function)\\s+${p.component}\\b`).test(src),
        `${p.component} must still be exported from ${p.file}`,
      ).toBe(true);
    }
  });
});
