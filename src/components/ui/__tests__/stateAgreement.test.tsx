/**
 * Name-and-state agreement, as a rule about every toggle in the app.
 *
 * Six tasks of this plan asserted aria attributes. Every one of them
 * asserted a **value**: `toHaveAttribute("aria-pressed", "true")`, or a
 * name that happens to be there. None of them asserted an **agreement** —
 * that the state a control announces is the state the control is in — and
 * that is precisely how Compare's blind toggle survived sixteen commits
 * announcing "Blind, not pressed" while blind mode was on. A test that
 * pins the value pins whatever the value currently is. A test that pins
 * the agreement goes red when the *pair* comes apart, which is the only
 * thing that was ever wrong.
 *
 * So the rule is not "the attribute has some value". It is:
 *
 *   > When a control's accessible name changes with its state, the name and
 *   > the state must be derived from the same expression, and the control
 *   > must declare a state channel at all.
 *
 * Both halves are load-bearing and each has a failure it catches:
 *
 *   - the **same expression** half catches `aria-pressed={!blind}` beside
 *     `{blind ? "Blind" : "Labeled"}` — the announced state, inverted;
 *   - the **a state channel** half catches a name that changes with the
 *     state while nothing announces the state. Memory's enable control was
 *     exactly that: `aria-label={item.is_enabled ? "Disable …" : "Enable
 *     …"}` with no `aria-pressed` and no `aria-checked`, on the same row
 *     as the pin button beside it, which has had `aria-pressed` the whole
 *     time. A screen reader read "Disable Pref m-1 — stop it being
 *     eligible for recall, button" and could not learn whether it was
 *     enabled, which is the one fact the control exists to change.
 *
 * ── Why a source scan and not nine render harnesses ───────────────────
 * The agreement shape is only worth anything applied *widely*, and it is
 * only cheap if one rule can be checked everywhere at once. Nine route
 * harnesses, each with its own mocks and providers, is the version that
 * does not get written — which is how the shape stayed on one route for
 * six tasks. This file walks the source instead, so the eleven toggles in
 * the app and the next eleven are covered by the same four assertions.
 * A rendered agreement for the two families a source scan cannot judge is
 * at the bottom of this file, and one for Memory's enable control is in
 * `MemoryRoute.test.tsx`.
 *
 * ── What this cannot see, stated rather than implied ──────────────────
 * A source scan reads declarations, not renderings, so it has three known
 * limits. They are biases toward false negatives, on purpose: a guard that
 * cries wolf gets deleted, and then the thing it was protecting goes back
 * (the rule the `EmptyState` ruling wrote down).
 *
 *   1. **A name built by a function or a variable is invisible here.** A
 *      control that computes its label through a helper is not checked.
 *      Nothing in the app does this today; the file lists what it did find
 *      so a reader can see the size of the blind spot.
 *   2. **Only a conditional on a bare identifier counts as state-bearing.**
 *      `{value === "all" ? "All" : "Open"}` is a control choosing its own
 *      label, not a control reporting its state — that is what a filter
 *      chip *is* — so the rule does not fire on it. The corollary is that
 *      a state-bearing name whose condition happens to be written as a
 *      comparison would slip through.
 *   3. **Children are read to the matching close tag of the same element
 *      name.** An unbalanced or unusual construct inside a control could
 *      truncate the read and hide a state-bearing text name.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Switch } from "../Form";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/* ── source walk ─────────────────────────────────────────────────────── */

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // Test files are excluded: a fixture or a negative control contains
      // deliberately broken markup and would be reported as a finding.
      if (entry === "__tests__" || entry === "test" || entry === "node_modules") continue;
      out.push(...tsxFiles(path));
    } else if (path.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Comments out, blanking the *content* but keeping every newline, so a
 * reported line number still points at the line a reader sees. The naive
 * version of this deleted the comment outright and put every finding
 * after the first block comment on the wrong line — which is the kind of
 * wrong that makes a real finding look like noise and get ignored.
 */
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

interface Attr { name: string; value: string; braced: boolean }
interface Element {
  file: string;
  line: number;
  tag: string;
  attrs: Attr[];
  children: string;
}

/** Advance past one JSX expression, respecting nested braces and strings. */
function skipExpr(src: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return src.length;
}

/** Every opening tag in `src`, with its attributes and its direct children. */
function elementsIn(src: string, file: string): Element[] {
  const out: Element[] = [];
  const open = /<([A-Za-z][\w.]*)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    const tag = m[1];
    let i = open.lastIndex;
    // Where the next element may be. Normally just past this tag's `>`,
    // but a `ReactNode` prop (`actions={<>…</>}`, the shape every
    // `RouteShell` cluster uses) contains whole elements, and setting
    // `lastIndex` past the prop would walk straight over them. That is not
    // hypothetical: it hid the one control this rule was written for, the
    // Compare blind toggle, because it lives inside `actions`. So the walk
    // resumes at the *earliest* braced attribute value it consumed, and
    // finds the nested elements on the way past.
    let resume = i;
    const attrs: Attr[] = [];
    let selfClosing = false;
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === "/" && src[i + 1] === ">") { selfClosing = true; i += 2; break; }
      if (src[i] === ">") { i++; break; }
      const name = /^[A-Za-z][\w:.-]*/.exec(src.slice(i));
      if (!name) { i++; continue; }
      i += name[0].length;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === "=") {
        i++;
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src[i] === "{") {
          const end = skipExpr(src, i + 1);
          attrs.push({ name: name[0], value: src.slice(i + 1, end).trim(), braced: true });
          if (i < resume) resume = i;
          i = end + 1;
        } else if (src[i] === '"' || src[i] === "'") {
          const end = src.indexOf(src[i], i + 1);
          attrs.push({ name: name[0], value: src.slice(i + 1, end), braced: false });
          i = end + 1;
        } else {
          const end = /[\s/>]/.exec(src.slice(i));
          const stop = end ? i + end.index : src.length;
          attrs.push({ name: name[0], value: src.slice(i, stop), braced: false });
          i = stop;
        }
      } else {
        attrs.push({ name: name[0], value: "", braced: false });
      }
    }
    // Direct children, by depth on this element's own tag name. A nested
    // child's ternary belongs to the nested child.
    let children = "";
    if (!selfClosing) {
      const re = new RegExp(`<(/)?${tag}(?=[\s/>])`, "g");
      re.lastIndex = i;
      let depth = 0;
      for (;;) {
        const hit = re.exec(src);
        if (!hit) break;
        if (hit[1]) {
          if (depth === 0) { children = src.slice(i, hit.index); break; }
          depth--;
        } else {
          depth++;
          const selfEnd = /\/>\s*>/.exec(src.slice(hit.index, hit.index + 400));
          if (selfEnd) { depth--; re.lastIndex = hit.index + selfEnd.index + 1; }
        }
      }
    }
    out.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      tag,
      attrs,
      children,
    });
    open.lastIndex = Math.min(i, resume);
  }
  return out;
}

const ALL: Element[] = tsxFiles(join(ROOT, "src"))
  .map((f) => elementsIn(stripComments(readFileSync(f, "utf8")), f.replace(`${ROOT}/`, "")))
  .flat();

/* ── the vocabulary ──────────────────────────────────────────────────── */

/** The five attributes that report a state to an assistive technology. */
const STATE_ATTRS = ["aria-pressed", "aria-checked", "aria-selected", "aria-expanded", "aria-current"];

/** `{cond ? a : b}` on a bare identifier or member path, both branches strings. */
const STATE_BEARING = /^\s*([A-Za-z_$][\w.$]*)\s*\?\s*(["'`])([\s\S]*?)\2\s*:\s*(["'`])([\s\S]*?)\4\s*$/;

interface StateBearing { condition: string; truthy: string; falsy: string; via: "aria-label" | "text" | "title" }

function stateBearingName(el: Element): StateBearing | null {
  for (const via of ["aria-label", "title"] as const) {
    const attr = el.attrs.find((a) => a.name === via);
    if (!attr) continue;
    const m = STATE_BEARING.exec(attr.value);
    // Both branches must be strings and must differ. `aria-label={title ? undefined : "Dialog"}`
    // is a fallback, not a state report, and one that did not differ would
    // be a name that says the same thing in both states.
    if (!m) continue;
    const [, condition, , truthy, , falsy] = m;
    if (truthy.trim() === "" || falsy.trim() === "" || truthy === falsy) continue;
    if (condition.includes("==") || condition.includes("!==") || condition.includes("&&") || condition.includes("||")) continue;
    return { condition, truthy, falsy, via };
  }
  // Text children: only a bare-identifier conditional counts, and only the
  // first one, because a name is one string and the first branch is what a
  // reader meets first. The braces come off first — a child's *content* is
  // `{expr}`, and the expression inside it is what branches.
  const inner = el.children.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  const m = STATE_BEARING.exec(inner);
  if (m) {
    const [, condition, , truthy, , falsy] = m;
    if (truthy.trim() !== "" && falsy.trim() !== "" && truthy !== falsy) {
      return { condition, truthy, falsy, via: "text" };
    }
  }
  return null;
}

const stateAttrsOf = (el: Element) => el.attrs.filter((a) => STATE_ATTRS.includes(a.name));

/* ── the four rules ──────────────────────────────────────────────────── */

/**
 * What counts as a control, and therefore what a state-bearing name on it
 * is a promise about.
 *
 * Restricted because a `<span>` whose text branches on `active.diskPath` is
 * not a control reporting a state — it is text — and a rule that fired on
 * one would be a finding nobody could act on. Three ways to be a control:
 * an interactive tag, an author-declared `role`, or one of the four
 * components in this repo that render one. A capitalized component outside
 * that list is not checked, which is limit 1 in the header, and it is the
 * reason the four findings this rule produced were all lowercase buttons.
 */
const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "a", "summary", "option"]);
const CONTROL_COMPONENTS = new Set(["Button", "IconButton", "Switch", "Select", "TextInput", "TextArea"]);
const WIDGET_ROLES = new Set([
  "button", "switch", "checkbox", "radio", "tab", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "combobox", "slider", "spinbutton", "toggle",
]);

function isControl(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tag)) return true;
  if (CONTROL_COMPONENTS.has(el.tag)) return true;
  const role = el.attrs.find((a) => a.name === "role")?.value.replace(/["']/g, "") ?? "";
  return WIDGET_ROLES.has(role);
}

/**
 * The one judgement call the rule cannot make for itself, written down
 * rather than guessed at.
 *
 * A control whose label changes with its state is *usually* a toggle
 * promising a state channel, and four of the five controls this rule found
 * were exactly that. The fifth is a submit button in the provider form
 * whose label is the action it will perform — "Add" when the form is adding
 * a provider, "Save" when it is editing one. `editingProvider` is the
 * form's *mode*, not a state the button toggles, the mode is already
 * carried by the form's own fields, and `aria-pressed` on it would be a
 * lie. The name "Add" is the right announcement for the control.
 *
 * No mechanical rule separates that from the four real findings: the
 * documents page's `Edit` / `Preview` pair has the same source shape and
 * *is* a toggle, because whether the document is editable is state the user
 * cannot otherwise learn. So this is a list with a reason rather than a
 * pattern, keyed on the condition rather than a line number so an edit
 * above it does not silently un-exempt it. A second entry is a ruling
 * about a control, not a bug in the rule.
 */
const JUDGEMENT_EXEMPT: { file: string; condition: string; why: string }[] = [
  {
    file: "src/routes/SettingsRoute.tsx",
    condition: "editingProvider",
    why: "an action button in a form, not a toggle: the label names the action and the mode is on the form",
  },
];

/**
 * Two spellings of one predicate are one predicate. `!!x` and
 * `Boolean(x)` are identities, so a name on `x` and a state on `!!x`
 * agree. A *single* `!` is not normalised away, and that is the whole
 * point: `!blind` beside a name branching on `blind` is the defect this
 * file exists to catch, and a rule that treated the two as the same thing
 * would pass it.
 */
const normalise = (expr: string) =>
  expr.trim().replace(/^Boolean\((.*)\)$/, "$1").replace(/^!!/, "").trim();

interface Finding { where: string; rule: string; detail: string }

function check(el: Element): Finding[] {
  const where = `${el.file}:${el.line} <${el.tag}>`;
  const found: Finding[] = [];
  const states = stateAttrsOf(el);
  const name = isControl(el) ? stateBearingName(el) : null;

  // S1 — a state channel that cannot change is not a state channel.
  for (const s of states) {
    const frozen = s.braced
      ? /^(true|false|"true"|"false"|'true'|'false')$/.test(s.value)
      : /^["']?(true|false)["']?$/.test(s.value);
    if (frozen) found.push({ where, rule: "S1", detail: `${s.name}={${s.value}} is constant` });
  }

  if (!name) return found;

  // S2 — the name and the state branch on the same expression.
  if (states.length > 0) {
    for (const s of states) {
      // `aria-current` is a token rather than a boolean, so it is exempt
      // from the polarity rule; `aria-expanded` on a combobox input is
      // exempt too, because the name there is a label for the whole
      // control rather than a report about it.
      if (s.name === "aria-current" || s.name === "aria-expanded") continue;
      if (normalise(s.value) !== normalise(name.condition)) {
        found.push({
          where,
          rule: "S2",
          detail: `${s.name}={${s.value}} but the ${name.via} branches on \`${name.condition}\``,
        });
      }
    }
  } else if (el.attrs.some((a) => a.name === "role" && /menuitem$/.test(a.value.replace(/["']/g, "")))) {
    // ── A recorded exemption, not a hole ──────────────────────────────
    // The sidebar's context menu has two items whose label flips with the
    // state ("Pin" / "Unpin") and nothing that says what the state is.
    // The fix is not an attribute: a `role="menuitem"` may not carry
    // `aria-checked`, so closing this properly means
    // `role="menuitemcheckbox"`, which is a decision about the widget
    // rather than about this attribute. The menu has no keyboard trigger
    // and no arrow-key navigation at all (it opens on `onContextMenu`
    // only), so it is unreachable by keyboard and is recorded in the
    // spec as the top a11y follow-up instead. Rewriting the role of a
    // widget this plan recommends be redesigned is not this task's call.
    //
    // Exempting `role="menuitem"` in the rule rather than special-casing
    // two line numbers keeps the exemption where a reader of the rule will
    // see it, and keeps the guard strict everywhere else.
  } else if (JUDGEMENT_EXEMPT.some((e) => el.file === e.file && e.condition === name.condition)) {
    // See `JUDGEMENT_EXEMPT` above. Recorded, not silently skipped.
  } else {
    // S3 — a name that changes with the state, and nothing that says what
    // the state is. This is the Memory enable control's defect.
    found.push({
      where,
      rule: "S3",
      detail: `the ${name.via} branches on \`${name.condition}\` and the element declares no state channel`,
    });
  }

  return found;
}

/** The whole app, as findings. Exported so the negative control can use it. */
export function audit(elements: Element[]): Finding[] {
  return elements.flatMap(check);
}

/* ── the sweep ───────────────────────────────────────────────────────── */

describe("every toggle in the app agrees with its own name", () => {
  it("parses a real set of state channels, so the sweep is not vacuous", () => {
    const withState = ALL.filter((el) => stateAttrsOf(el).length > 0);
    // Eleven at the time of writing. Asserting a floor rather than a list
    // means a new toggle is covered without this file being edited, and a
    // number low enough to mean the walk broke is a loud failure.
    expect(withState.length, "the walk must find the app's state channels").toBeGreaterThanOrEqual(10);
    const withBothStateAndName = withState.filter((el) => stateBearingName(el));
    // The families the rule exists for: the pin toggles on two routes, the
    // compare blind toggle, the memory enable toggle.
    expect(withBothStateAndName.length).toBeGreaterThanOrEqual(3);
  });

  it("finds no disagreement", () => {
    const findings = audit(ALL);
    expect(
      findings.map((f) => `${f.where} [${f.rule}] ${f.detail}`),
      "a control's name and its state must not describe opposite things",
    ).toEqual([]);
  });

  it("covers the four families the rule was written for", () => {
    // Not a snapshot of class names or attributes — a check that the
    // families are still *there*, so the sweep above cannot go green by
    // the app quietly losing the controls it is protecting.
    const byFile = (f: string) => ALL.filter((el) => el.file === f);
    expect(byFile("src/routes/CompareRoute.tsx").some((el) => stateBearingName(el))).toBe(true);
    expect(byFile("src/routes/MemoryRoute.tsx").filter((el) => stateBearingName(el)).length).toBeGreaterThanOrEqual(2);
    expect(byFile("src/routes/NotesRoute.tsx").filter((el) => stateBearingName(el)).length).toBeGreaterThanOrEqual(1);
  });
});

describe("the rules are not vacuous: each one rejects what it is for", () => {
  // A guard that has never been shown to fail cannot be told from a guard
  // that cannot fail, which is the rule this plan has been bitten by four
  // times. So each rule is run against the exact declaration it exists to
  // reject, in a fragment rather than in the app.
  const fragment = (jsx: string): Element[] =>
    elementsIn(stripComments(jsx), "fragment.tsx");

  it("S1 rejects a frozen state", () => {
    const findings = audit(fragment(`<button aria-pressed={"true"} aria-label="Pin">x</button>`));
    expect(findings.map((f) => f.rule)).toContain("S1");
  });

  it("S2 rejects an inverted state beside a correct name — the Compare bug", () => {
    // Byte-for-byte the shape that survived sixteen commits.
    const findings = audit(fragment(
      `<Button aria-pressed={!blind}>{blind ? "Blind" : "Labeled"}</Button>`,
    ));
    expect(findings.map((f) => f.rule)).toContain("S2");
    expect(findings[0].detail).toContain("!blind");
  });

  it("S2 accepts the corrected form", () => {
    expect(audit(fragment(
      `<Button aria-pressed={blind}>{blind ? "Blind" : "Labeled"}</Button>`,
    ))).toEqual([]);
  });

  it("S2 rejects a name borrowed from a different piece of state", () => {
    // Sneakier than an inversion and just as wrong: the name reports the
    // pin, the state reports the enabled flag, and the control is
    // announced as agreeing with itself.
    const findings = audit(fragment(
      `<button aria-pressed={item.is_enabled} aria-label={item.pinned ? "Unpin x" : "Pin x"}>i</button>`,
    ));
    expect(findings.map((f) => f.rule)).toContain("S2");
  });

  it("S3 rejects a state-bearing name with no state channel — the Memory bug", () => {
    const findings = audit(fragment(
      `<button aria-label={item.is_enabled ? \`Disable \${label}\` : \`Enable \${label}\`}>p</button>`,
    ));
    expect(findings.map((f) => f.rule)).toEqual(["S3"]);
  });

  it("S3 accepts a fallback name, which is not a state report", () => {
    // Modal's `aria-label={title ? undefined : "Dialog"}`: one branch is
    // not a string, so nothing is claimed about a state.
    expect(audit(fragment(`<div role="dialog" aria-label={title ? undefined : "Dialog"} />`))).toEqual([]);
  });

  it("S3 accepts a name that does not change with the state", () => {
    // A filter chip chooses its own label; it is not reporting itself.
    expect(audit(fragment(
      `<button aria-pressed={filter === value}>{value === "all" ? "All" : "Open"}</button>`,
    ))).toEqual([]);
  });

  it("does not read a nested child's conditional as its own name", () => {
    // If this failed, every row with an icon inside would be reported.
    expect(audit(fragment(
      `<button aria-pressed={row.pinned}><span><Icon on={row.pinned ? 1 : 0} /></span></button>`,
    ))).toEqual([]);
  });
});

/* ── rendered agreement ──────────────────────────────────────────────── */

/**
 * The Switch, with three independent channels for one piece of state.
 *
 * A source scan reads declarations; it cannot tell whether the three agree
 * *at runtime*. So this drives the primitive into both states and reads
 * the announcement and the two visual channels — the track's colour and
 * the thumb's position — and requires all three to move together. The
 * track and the thumb are not the assertion's subject; they are the
 * independent observables that make it an agreement test rather than a
 * value test. Drop `aria-checked` and the row keeps looking right; drop it
 * from this test's eyes and the suite goes green on a control that
 * announces the wrong state.
 */
function ControlledSwitch({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  return <Switch checked={on} onChange={setOn} label="Extract memories automatically" />;
}

describe("the Switch announces a state that is the state it is in", () => {
  it("on: checked, accent track, thumb travelled", () => {
    render(<ControlledSwitch initial />);
    const control = screen.getByRole("switch", { name: "Extract memories automatically" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveClass("bg-accent");
    expect(control.querySelector("span")).toHaveClass("translate-x-4");
  });

  it("off: unchecked, surface track, thumb home", () => {
    render(<ControlledSwitch initial={false} />);
    const control = screen.getByRole("switch", { name: "Extract memories automatically" });
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(control).toHaveClass("bg-surface-3");
    expect(control.querySelector("span")).toHaveClass("translate-x-0");
  });

  it("the click moves all three channels together, so they cannot drift", () => {
    render(<ControlledSwitch initial={false} />);
    const control = screen.getByRole("switch", { name: "Extract memories automatically" });
    const thumb = () => control.querySelector("span")!;
    const read = () => ({
      announced: control.getAttribute("aria-checked"),
      track: control.className.includes("bg-accent") ? "accent" : "surface-3",
      thumb: thumb().className.includes("translate-x-4") ? "travelled" : "home",
    });
    expect(read()).toEqual({ announced: "false", track: "surface-3", thumb: "home" });
    fireEvent.click(control);
    expect(read()).toEqual({ announced: "true", track: "accent", thumb: "travelled" });
  });

  it("the name says what the switch governs, not what state it is in", () => {
    // The state-neutral half of the rule, rendered. A name that carried
    // its own state — "On", "Enabled" — would be a fourth thing to keep
    // in step, and the pin toggle's inversion is what that costs.
    render(<ControlledSwitch initial />);
    expect(screen.getByRole("switch", { name: "Extract memories automatically" }))
      .toHaveAccessibleName("Extract memories automatically");
  });
});
