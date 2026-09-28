/**
 * The shared primitives' prop signatures, pinned.
 *
 * The plan's one rule with teeth: **no primitive gains or loses a prop.**
 * The reasoning is that a new prop on a shared primitive is an API every
 * future caller has to understand, and this redesign is a visual change,
 * not an API change. If a primitive seems to need a new prop to express
 * the new look, the design is wrong — not the prop missing.
 *
 * ── What is actually enforced, stated exactly ─────────────────────────
 * This file pins the **name** of every prop and whether it is optional. It
 * fails when a prop is added, removed, renamed, made required, made
 * optional, or widened through an `extends` clause. `tsc` covers a
 * different slice: a prop whose type narrows, or whose name callers depend
 * on, breaks this repository's ~200 call sites.
 *
 * **Known gap, tracked rather than papered over: a prop's type can still
 * widen where the component only consumes it.** Both mutation runs, since
 * the distinction is the whole content of this paragraph:
 *
 *   `IconButton`'s `variant?: "ghost" | "subtle" | "solid"` → `string`
 *     is caught by `tsc`, because the body indexes `VARIANTS[variant]`
 *     and a string will not index that record.
 *   `Slider`'s `formatValue?: (v: number) => string` → `… | null`
 *     is caught by **nothing**: 55/55 tests green, `tsc` exit 0. Every
 *     call site is still passing a valid formatter.
 *
 * The fix is a full expected-type transcription per primitive plus an
 * exact-equality check (`ComponentProps<typeof Panel>` against a
 * hand-written `PanelProps`), which would close retype as well as the
 * rest with no regex. That was not taken on purpose: it is a second,
 * hand-maintained copy of every signature in type syntax, and its
 * *mistakes* are indistinguishable from real findings. A guard that cries
 * wolf gets deleted, and the whole file goes with it. 14 primitives is
 * also more transcription than the gap has yet justified.
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
 *
 * `extendsInterface` is the same asymmetry seen from the other side, and
 * only `Button` may set it. A primitive that gains
 * `extends ButtonHTMLAttributes<HTMLButtonElement>` keeps its own parsed
 * prop list byte-for-byte — the name list this file pins is unchanged —
 * while silently accepting ~250 extra props. That is the failure this
 * whole file exists to prevent, reached without touching the pinned list
 * at all, so it is asserted directly rather than inferred from the list.
 */
const PRIMITIVES: Array<{
  file: string;
  component: string;
  props: string[];
  /** A prop that must be in the parsed list, so an empty parse cannot pass. */
  sentinel: string;
  inherited?: string[];
  /** Set only by `Button`, the one primitive with a documented reason. */
  extendsInterface?: boolean;
}> = [
  {
    file: "src/components/ui/Button.tsx",
    component: "Button",
    props: ["variant?", "size?", "loading?", "icon?", "rightIcon?", "fullWidth?"],
    sentinel: "variant",
    inherited: ["className", "children", "disabled", "ref"],
    extendsInterface: true,
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
    file: "src/components/ui/EmptyState.tsx",
    component: "EmptyState",
    // Declared as an inline type literal rather than an interface, so this
    // entry exercises the fallback parse path. The one primitive this
    // commit restyled had no guard at all until now.
    //
    // **`headingLevel?` was added to this list deliberately**, by the
    // Task 4 fix round, and the list is the record of that decision
    // rather than a snapshot that happened. Every other prop here is
    // unchanged; the addition exists because the primitive's title is a
    // heading, a heading's level is semantic rather than visual, and
    // `RouteShell` already owns each page's `h1` — so the `h3` this
    // component always rendered was a skipped level on all five routes
    // that use it. The alternative was four pages each hand-rolling a
    // heading over the top of this one, and Task 5 and Task 6 would have
    // repeated it. The guard exists to catch *unintentional* drift, and
    // this was intentional, reviewed and ruled on. It is optional and
    // defaults to the level that was already rendered, so no call site
    // changes behaviour by not passing it.
    props: ["title", "description?", "icon?", "action?", "headingLevel?", "className?"],
    sentinel: "title",
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

/**
 * Its own `interface XProps`, where the name shares the component's stem:
 * `[1]` the interface's name, `[2]` whatever sits between the name and the
 * body — the `extends` clause, if any — `[3]` the declared body.
 */
function ownInterface(src: string, component: string): RegExpExecArray | undefined {
  return [...src.matchAll(/(?:export\s+)?interface\s+(\w*Props)([^{]*)\{([\s\S]*?)\n\}/g)]
    .find((m) => m[1].startsWith(component));
}

/** The interface a primitive declares, or the inline type literal in its signature. */
function propDeclaration(src: string, component: string): string {
  const own = ownInterface(src, component);
  if (own) return own[3];
  // Otherwise the inline type literal, as EmptyState and Spinner declare
  // theirs. `balancedFrom` starts after the destructuring block, so the
  // brace it finds is the type literal's own.
  const { end } = destructuredBlock(src, component);
  return balancedFrom(src, end, `${component}'s inline prop type`).block;
}

/** The props a primitive declares, from its own interface or inline type. */
function declaredProps(file: string, component: string): Declared[] {
  const src = read(file);
  const block = propDeclaration(src, component);

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

  it("gives no primitive a wider prop surface through extends", () => {
    // The signature list above cannot see this one. `interface
    // IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>`
    // leaves IconButtonProps' own body — and therefore every parsed name
    // — byte-for-byte identical, while the primitive goes on to accept
    // ~250 props it did not accept before. A pin on the name list alone
    // would call that clean.
    for (const p of PRIMITIVES) {
      const src = read(p.file);
      const own = ownInterface(src, p.component);
      if (own) {
        expect(
          /\bextends\b/.test(own[2]),
          `${p.component} must not extend another interface — that widens the prop surface past every name pinned in this file without changing any of them. Only Button has a documented reason, and it sets extendsInterface.`,
        ).toBe(p.extendsInterface === true);
        continue;
      }
      // A primitive with no interface of its own declares an inline type
      // literal, which widens the same way through `&` or through
      // borrowing someone else's interface with `Pick<>`. Both leave the
      // literal shape, so the literal is checked for being a bare object
      // type instead.
      const { end } = destructuredBlock(src, p.component);
      const raw = src.slice(end + 1, balancedFrom(src, end, `${p.component}'s inline prop type`).end + 1);
      expect(
        /^\s*:\s*\{[\s\S]*\}\s*$/.test(raw),
        `${p.component} declares an inline prop type, so it must be a bare object literal — not an intersection and not a Pick off another interface`,
      ).toBe(true);
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
