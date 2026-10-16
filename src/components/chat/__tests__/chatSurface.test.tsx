/**
 * Chat surface — the style guards for the one subtree that repaints 60
 * times a second.
 *
 * `streamPerformance.test.tsx` owns the streaming *invariants* and the
 * class-name paint guard. This file covers what that guard cannot see,
 * and the design rules a restyle could break while leaving it green.
 * Every check here that could pass vacuously carries its own non-vacuity
 * assertion, and says in the assertion which vacuity it is closing.
 *
 * ── 1. What the class-name guard cannot see ────────────────────────────
 * `paintViolations` reads `classList` and the inline `style` attribute.
 * That covers every utility and every inline declaration, and it covers
 * **nothing** that arrives from a stylesheet. Two things do:
 *
 *   - **Tailwind's own descendant rules.** `.prose :where(pre)` is
 *     emitted by the typography plugin against a class the guard can
 *     see, but the declaration is nowhere in the DOM. The guard
 *     compiles nothing, so it cannot notice one.
 *   - **`globals.css`.** Its `.prose pre` / `.prose code` rules, and its
 *     `.code-block-wrap` hover transitions, reach straight into the
 *     streaming and settled message paths. `.code-block-wrap` is the
 *     loudest: a `transition` no class-name check will ever report.
 *
 * The residual this file does **not** cover, stated rather than assumed:
 * that same file's `:focus-visible { outline: … }` and its
 * `prefers-reduced-motion` block match every element and are scoped by
 * no class. Both were read by hand — one is a focus affordance (an
 * outline is not one of the three paint-forcing properties, and it is
 * paid on focus only) and the other only *reduces* animation duration,
 * so running a paint sweep over it would invert its purpose. Nothing
 * else in that file reaches the chat surface.
 *
 * ── 2. The Tailwind compile is the only way to measure anything here ──
 * `vitest.config.ts` sets `css: false`, so `getComputedStyle` is blind.
 * A class-name assertion is the wrong instrument twice over: it pins a
 * spelling, and it passes for a page that merely *says* the class. So
 * the numbers below come from the project's own Tailwind compiling the
 * classes the component actually rendered — Task 4's V36, reused for the
 * same reason, and for the same limit: this is the *stylesheet*, not a
 * layout.
 *
 * ── 3. Every literal in this file is assembled at runtime ─────────────
 * `tailwind.config.ts` globs `./src/**\/*.{js,ts,jsx,tsx}`, so the
 * production scanner reads this file — comments included — and a utility
 * written here as a literal emits a rule into `dist/` whether the app
 * uses it or not. Task 4 recorded that residue and could not fix the
 * cause. `plant` is the workaround: it joins the parts at runtime, so
 * the scanner sees `shadow` and `panel` rather than a class, and this
 * file leaves the shipped stylesheet exactly as it found it. Literals
 * the app already emits stay readable; anything unique to a fixture goes
 * through `plant`.
 *
 * ── 4. Scope of the radius rule, and the one file it excludes ─────────
 * The radius sweep covers the files this task restyles. It does **not**
 * cover `MarkdownRenderer.tsx`, and the exclusion is a finding rather
 * than a convenience. That file's code-block `<pre>` sets
 * `borderRadius: 10` inline; moving it to a token-radius class would be
 * a *regression*, because `globals.css`'s `.prose pre
 * { border-radius: 8px }` is specificity `(0,1,1)` and beats a
 * `(0,1,0)` utility — the "conversion" would silently trade a 10px
 * hardcoded radius for an 8px one that follows no theme either. Its
 * inline `<code>` is worse: `.prose code` already overrides that
 * element's radius, padding and font-size, so three of its declared
 * utilities are dead today. Both facts belong to the owner of the
 * frozen file, and neither is a change this task may make.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { act, fireEvent, render, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatSkeleton } from "../../ui/Skeleton";
import { ChatHeader } from "../ChatHeader";
import { TextInput } from "../../ui/Form";
import { ChatInput } from "../ChatInput";
import { MessageRow } from "../MessageRow";
import { StreamingTail } from "../StreamingTail";
import type { MessageRowProps } from "../types";
import { useChatStreamStore } from "../../../stores/chatStream";
import type { ChatMessage } from "../../../lib/api";
import repoTailwind from "../../../../tailwind.config";

/* ── the surface under test ─────────────────────────────────────────── */

/**
 * Every file whose styling this task owns. `MarkdownRenderer.tsx` is
 * absent on purpose; the header says why, and the reason is a property
 * of that file rather than a decision this task made.
 */
const SURFACE_FILES = [
  "src/components/chat/AttachmentChip.tsx",
  "src/components/chat/ChatContextMenu.tsx",
  "src/components/chat/ChatHeader.tsx",
  "src/components/chat/ChatInput.tsx",
  "src/components/chat/ChatViewNew.tsx",
  "src/components/chat/MessageRow.tsx",
  "src/components/chat/SessionMemoryModal.tsx",
  "src/components/chat/StreamingTail.tsx",
  "src/components/ui/Skeleton.tsx",
  "src/routes/ChatRoute.tsx",
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const readRepoFile = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

/** A utility name the production scanner cannot read as a class. */
const plant = (parts: string[], sep = "-") => parts.join(sep);

/**
 * Every string and template literal in a source file, with interpolations
 * blanked out.
 *
 * The blanking matters: a class can only be written in a string, so
 * restricting the sweep to literals is what keeps a prop declaration from
 * being read as a class. And `${rounded}` inside a template is the *name*
 * of a class passed in from elsewhere, not one this file declares — the
 * half of `Skeleton` that forwards a caller's radius is exactly that.
 */
function literals(src: string): string[] {
  return [...src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((m) =>
    m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, " "),
  );
}

/* ── Tailwind compile ────────────────────────────────────────────────── */

const unescapeSelector = (s: string) => s.replace(/\\(.)/g, "$1");
const cache = new Map<string, Map<string, string>>();

/**
 * The part of a compiled stylesheet that applies at any width.
 *
 * Tailwind emits screen variants after the plain utilities, so
 * everything from the first `@media` on is conditional on a width this
 * surface is never asked about. Used for the *geometry* reads. The paint
 * sweep below deliberately does not use it: a `transition` inside
 * `@media print` is still a transition.
 */
const unconditional = (css: string) => {
  const at = css.indexOf("@media");
  return at < 0 ? css : css.slice(0, at);
};

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of body.split(";")) {
    const colon = d.indexOf(":");
    if (colon < 0) continue;
    const prop = d.slice(0, colon).trim();
    // Custom properties are machinery — a ring utility declares
    // `--tw-ring-shadow: 0 0 #0000` — not geometry and not a paint. A
    // ring's actual `box-shadow` comes from the utility's own rule,
    // which the sweep below reads.
    if (!prop || prop.startsWith("--")) continue;
    out.set(prop, d.slice(colon + 1).trim());
  }
  return out;
}

/** Every rule a compiled stylesheet holds, selector and declarations. */
function allRules(css: string): { selector: string; decls: Map<string, string> }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: unescapeSelector(m[1].trim()),
    decls: declarations(m[2]),
  }));
}

/**
 * Index a compiled stylesheet by the class each rule styles.
 *
 * Strict on purpose — it keys on the class being the whole first token —
 * because that is right for a plain utility. A rule that *mentions* a
 * class (`prose :where(pre)`, `hover:bg-x`) is a different question, and
 * `allRules` is where it gets asked.
 */
function indexRules(css: string): Map<string, Map<string, string>> {
  const byClass = new Map<string, Map<string, string>>();
  for (const { selector, decls } of allRules(unconditional(css))) {
    const head = selector.split(/\s+/)[0];
    if (!head.startsWith(".")) continue;
    const name = head.slice(1);
    if (!byClass.has(name)) byClass.set(name, decls);
  }
  return byClass;
}

async function compileOnce(classNames: string[]): Promise<string> {
  // `tailwindcss` bundles its own postcss, so the plugin type is not
  // nominally the one this repo depends on. The compiler is only ever
  // handed this array.
  const plugins = [
    tailwindcss({
      ...(repoTailwind as object),
      content: [{ raw: classNames.map((c) => `<i class="${c}"></i>`).join("\n"), extension: "html" }],
      corePlugins: { preflight: false },
    }),
  ] as never;
  return (await postcss(plugins).process("@tailwind utilities;", { from: undefined })).css;
}

/** The declarations each of `classNames` emits, memoised across the file. */
async function emitted(classNames: string[]): Promise<Map<string, Map<string, string>>> {
  const wanted = [...new Set(classNames)];
  const missing = wanted.filter((c) => !cache.has(c));
  if (missing.length) {
    const byClass = indexRules(await compileOnce(missing));
    for (const c of missing) cache.set(c, byClass.get(c) ?? new Map());
  }
  return new Map(wanted.map((c) => [c, cache.get(c)!]));
}

/**
 * The first absolute length in a declaration, in CSS pixels.
 *
 * Throws rather than returning a number for a `var()` or a percentage:
 * "it emitted no length" has to be a loud failure, not a reading of zero
 * that would sail through a comparison.
 */
function toPx(value: string | undefined, context: string): number {
  const m = String(value ?? "").match(/(-?[\d.]+)\s*(px|rem|em)\b/);
  if (!m) throw new Error(`${context} has no absolute length to measure: "${value}"`);
  return m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
}

function decl(decls: Map<string, string>, prop: string, context: string): string {
  const v = decls.get(prop);
  if (v === undefined) throw new Error(`${context} emits no ${prop}; the class does not exist`);
  return v;
}

/**
 * The pixels a class declares for a property.
 *
 * `props` is a list because Tailwind writes a shorthand where it can:
 * `p-2` emits `padding`, `py-2.5` emits `padding-top` and
 * `padding-bottom`. Reading only the longhand would make the compact
 * side of the density comparison throw, which is a measurement failure
 * dressed as a finding.
 */
async function pxOf(cls: string, ...props: string[]): Promise<number> {
  const decls = (await emitted([cls])).get(cls)!;
  for (const prop of props) {
    const v = decls.get(prop);
    if (v !== undefined) return toPx(v, `${cls} { ${prop} }`);
  }
  throw new Error(`${cls} emits none of ${props.join(", ")}; the class does not exist`);
}

const classOf = (el: Element, re: RegExp): string => {
  for (const c of el.classList) if (re.test(c)) return c;
  throw new Error(`no class matching ${re} on <${el.tagName.toLowerCase()}> class="${el.className}"`);
};

/* ── shared class predicates ─────────────────────────────────────────── */

/** Strip a variant prefix (`hover:`, `sm:`, `!`) the way the guard does. */
const bare = (cls: string) => cls.replace(/^!/, "").split(":").pop() ?? cls;

/**
 * The properties that put a paint-forcing cost on an element: the same
 * three `streamPerformance.test.tsx` bans in the streaming subtree, named
 * here once so the two files cannot drift into disagreeing about what
 * "cheap to repaint" means.
 */
const PAINT_PROPS = ["box-shadow", "filter", "transition", "transition-property"];

/** The four theme radii in `tailwind.config.ts`. */
const TOKEN_RADII: readonly string[] = ["rounded-sm", "rounded-md", "rounded-lg", "rounded-xl"];
/**
 * A circle, and an absence. Neither is a value on the scale, so neither
 * is a radius a theme should be able to move.
 *
 * The absence is assembled rather than written. Nothing in the app emits
 * it, so a literal here would be the one dead rule this file added to the
 * shipped stylesheet — measured, not assumed: the rule set of a real
 * build is identical before and after this file exists.
 */
const SHAPE_RADII: readonly string[] = ["rounded-full", plant(["rounded", "none"])];
const isRadius = (cls: string) => cls === "rounded" || cls.startsWith("rounded-");

/**
 * Whether a radius utility is one this design may declare.
 *
 * A bare `rounded` is Tailwind's default 0.25rem — the exact defect
 * Task 2 found on `Badge` — so it is rejected alongside a hardcoded
 * arbitrary value rather than being read as "some radius".
 */
function radiusOk(cls: string): boolean {
  const b = bare(cls);
  if (!isRadius(b)) return true;
  return (TOKEN_RADII).includes(b) || (SHAPE_RADII).includes(b);
}

/** Every radius utility a class list declares, in order. */
function radiiIn(classAttr: string): string[] {
  return classAttr.split(/\s+/).filter((c) => c && isRadius(c));
}

/**
 * Whether two class lists declare the same single radius.
 *
 * Split out so it can be handed a fixture: a predicate that has only
 * ever seen agreeing input is a predicate that has not been tested.
 * "Absent" is not "equal" — a half that lost its radius entirely is a
 * disagreement, not an agreement.
 */
function sameRadius(a: string, b: string): boolean {
  const ra = radiiIn(a);
  const rb = radiiIn(b);
  return ra.length === 1 && rb.length === 1 && ra[0] === rb[0];
}

/**
 * A radius token anywhere inside a class string.
 *
 * Deliberately not a JSX parse, and deliberately only applied to string
 * literals: a class can only be written in a string, whereas the
 * identifier `rounded` also appears as a prop name in code — and a sweep
 * that reads a prop declaration as a class reports a defect that is not
 * there.
 */
const RADIUS_TOKEN = /(?<![\w-])((?:[a-z-]+:)*!?rounded(?:-[^\s"'`]*)?)(?![\w-])/g;

/* ── rendering the surface ───────────────────────────────────────────── */

const NOW = "2026-09-27T00:00:00.000Z";

function chatMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    session_id: "s1",
    role: "assistant",
    content: "an answer",
    thinking: null,
    attachments_json: null,
    prompt_tokens: null,
    output_tokens: null,
    created_at: NOW,
    ...over,
  };
}

const ROW_PROPS: Omit<MessageRowProps, "msg"> = {
  i: 0,
  sessionId: "s1",
  editingMessageId: null,
  setEditingMessageId: () => {},
  collapsedThinking: new Set<number>(),
  setCollapsedThinking: () => {},
  setContextMenu: () => {},
  onResend: async () => {},
};

/** The user bubble, found by its fill so the locator cannot be the value. */
function userBubble(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>(".bg-userbubble");
  if (!el) throw new Error("no user bubble in the tree; the walk had nothing to inspect");
  return el;
}

/**
 * The chat placeholder's user bubble, found by its height.
 *
 * Deliberately *not* found by its radius: a locator keyed to the value
 * under test is a locator that reports agreement by construction. The
 * height is the bubble's geometry, which no assertion here changes.
 */
function placeholderBubble(root: HTMLElement): HTMLElement {
  const blocks = [...root.querySelectorAll<HTMLElement>(".skeleton")];
  const bubble = blocks.find((b) => b.style.height === "2.5rem");
  if (!bubble) {
    throw new Error(
      `no 2.5rem skeleton block in the tree; found ${blocks.length} blocks with heights ` +
        blocks.map((b) => b.style.height).join(", "),
    );
  }
  return bubble;
}

function renderComposer() {
  return render(
    <ChatInput
      disabled={false}
      streaming={false}
      attachments={{ attachments: [], addFiles: () => {} }}
      onSend={() => {}}
      onStop={() => {}}
      onInputChange={() => {}}
      slashCtx={{
        sessionId: "s1",
        setModelId: () => {},
        setProviderId: () => {},
        currentModel: "m",
        resendLast: async () => {},
        clearAll: async () => {},
        newSession: async () => {},
      }}
    />,
  );
}

/** A `StreamingTail` with a live stream, built only through the store. */
function renderTail(streamContent: string, streamThinking: string) {
  useChatStreamStore.setState({
    sessions: {
      s1: {
        messages: [],
        status: "streaming",
        streaming: true,
        streamContent,
        streamThinking,
        error: null,
        loadingMessages: false,
      },
    },
  });
  return render(
    <StreamingTail sessionId="s1" stickToBottomRef={{ current: true }} onBumpScroll={() => {}} />,
  );
}

function thinkingPanel(root: HTMLElement): HTMLElement {
  const el = root.querySelector<HTMLElement>("[data-thinking-panel]");
  if (!el) throw new Error("no thinking panel in the tree; the walk had nothing to inspect");
  return el;
}

/** The surface, border and radius one element declares, as sorted sets. */
function geometry(classAttr: string) {
  const classes = classAttr.split(/\s+/).filter(Boolean);
  return {
    surface: classes.filter((c) => c.startsWith("bg-")).sort(),
    border: classes.filter((c) => c === "border" || c.startsWith("border-")).sort(),
    radius: radiiIn(classAttr).sort(),
  };
}

beforeEach(() => {
  useChatStreamStore.setState({ sessions: {} });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_messages") return [] as never;
    if (command === "list_memory" || command === "get_enabled_memory") return [] as never;
    if (command === "get_session_memory_overrides") return [] as never;
    return undefined as never;
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The bubble and its placeholder
 *
 * `ChatSkeleton` and `MessageRow` are two halves of one matched pair: a
 * loading placeholder that has to look like the thing it stands in for.
 * The pin between them is *textual duplication* — the same string written
 * twice — so converting one half to a token radius and touching only one
 * file leaves every test green and the pair disagreeing, which is the
 * failure the pin's own comment says it prevents. So the two tests below
 * compare the two *renderings* rather than two literals.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("the user bubble and its loading placeholder stay one matched pair", () => {
  it("gives both halves the same radius, and the radius is a theme token", () => {
    const row = render(<MessageRow msg={chatMessage({ role: "user", content: "hello" })} {...ROW_PROPS} />);
    const placeholder = render(<ChatSkeleton />);

    const bubble = userBubble(row.container);
    const ghost = placeholderBubble(placeholder.container);

    // Non-vacuity: the locator found something in each tree, and it
    // found it by a property the assertions below do not touch.
    expect(bubble.textContent).toContain("hello");
    expect(ghost).toBeTruthy();

    expect(
      sameRadius(bubble.className, ghost.className),
      `bubble "${bubble.className}" and placeholder "${ghost.className}" must declare the same radius`,
    ).toBe(true);

    // And the agreed radius is one a theme can move. Both halves left on
    // Tailwind's 1rem default scale would satisfy the assertion above and
    // fail this one, which is half of what the pin is for.
    expect(radiiIn(bubble.className)[0]).toMatch(/^rounded-(sm|md|lg|xl)$/);
  });

  it("rejects a half-move and a non-token radius, so the pin is not satisfied by agreement alone", () => {
    const token = "rounded-lg";
    const defaultScale = plant(["rounded", "2xl"]);
    // The failure this pair of tests exists for: one half moved, the
    // other not. Both are real class strings a future commit could write.
    expect(sameRadius(token, defaultScale)).toBe(false);
    // The other half of the pin, which a pair-agreement test cannot see.
    expect(radiusOk(token)).toBe(true);
    expect(radiusOk(defaultScale)).toBe(false);
    expect(radiusOk("rounded")).toBe(false);
    expect(radiusOk(plant(["rounded", "[8px]"]))).toBe(false);
    // A class with no radius in it at all is not a disagreement, and
    // `sameRadius` has to say so rather than treat "absent" as "equal".
    expect(sameRadius(token, "bg-userbubble")).toBe(false);
    // The shapes, which are not values on the scale. The circle is a
    // literal because the app already emits it; the absence is planted,
    // because nothing does and a literal here would be the one dead rule
    // this file added to the shipped stylesheet.
    expect(radiusOk("rounded-full")).toBe(true);
    expect(radiusOk(plant(["rounded", "none"]))).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Flatness
 *
 * The design is a surface plus a 1px border. A card that keeps a shadow
 * is a regression against that rather than a finishing touch, and the
 * composer in `ChatInput` was the last card shadow anywhere in the app —
 * Task 2 found it, left it, and named this task as the one that owns it.
 *
 * Rings get their own check because Tailwind builds them out of
 * `box-shadow`, so a bare ring utility on every row would put a shadow on
 * the resting surface and sail past any class-based shadow sweep. Task 4
 * found that hole; this is the same closure on the other surface.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("the chat surface is flat", () => {
  it("makes the composer a surface and a border, with no shadow", () => {
    const { container } = renderComposer();
    const composer = container.firstElementChild as HTMLElement;
    // Non-vacuity: the composer exists and drew something.
    expect(composer.tagName).toBe("DIV");
    expect(composer.querySelector("[data-chat-input]")).toBeTruthy();

    const cls = Array.from(composer.classList);
    expect(cls, "the composer draws a surface").toEqual(
      expect.arrayContaining([expect.stringMatching(/^bg-surface-\d$/)]),
    );
    expect(cls, "the composer draws a 1px border").toEqual(
      expect.arrayContaining(["border", "border-border"]),
    );
    expect(
      cls.some((c) => /^(shadow|drop-shadow)(-|$)/.test(bare(c))),
      `the composer must carry no shadow, found: ${composer.className}`,
    ).toBe(false);
    expect(
      cls.some((c) => TOKEN_RADII.includes(c)),
      `the composer's radius must be a token, found: ${composer.className}`,
    ).toBe(true);

    // The composer is an input, so it wears the input's surface — and it
    // is asserted against the primitive rather than against a string, so
    // a change to `TextInput` moves the composer with it instead of
    // leaving two definitions of "a field". This is also what makes
    // dropping the shadow free: the composer and the bar behind it were
    // both `bg-surface-1`, and the shadow was the only thing between
    // them. One step apart is the flat way to say the same thing.
    const field = render(<TextInput value="" onChange={() => {}} aria-label="A field" />);
    const input = field.container.querySelector("input")!;
    const surfaceOf = (el: Element) => Array.from(el.classList).find((c) => /^bg-surface-\d$/.test(c));
    expect(surfaceOf(composer)).toBe(surfaceOf(input));
    // And the step is real, in every built-in theme, rather than assumed:
    // a theme that flattened `surface.2` onto `surface.1` would put the
    // composer back inside the bar with nothing to separate them.
    const themes = readRepoFile("src-tauri/src/themes.rs");
    const surface = (n: string) =>
      [...themes.matchAll(new RegExp(`"color\\.surface\\.${n}":\\s*"([^"]+)"`, "g"))].map((m) => m[1]);
    const one = surface("1");
    const two = surface("2");
    // The control on the scan: six themes read, not two.
    expect(one, "every built-in theme defines surface.1").toHaveLength(6);
    expect(two, "every built-in theme defines surface.2").toHaveLength(6);
    for (const [i, value] of one.entries()) {
      expect(two[i], `theme ${i}: surface.2 (${two[i]}) must differ from surface.1 (${value})`).not.toBe(value);
    }
  });

  it("leaves no card shadow anywhere in the chat surface", () => {
    const card = plant(["shadow", "panel"]);
    const offender = (src: string, rel: string) =>
      new RegExp("(^|[\\s\"'`])" + card + "($|[\\s\"'`])").test(src) ? rel : null;

    const found = SURFACE_FILES.map((rel) => offender(readRepoFile(rel), rel)).filter(Boolean);
    expect(
      found,
      `a card shadow is a regression against the flat design, not a finishing touch. Still on: ${found.join(", ")}`,
    ).toEqual([]);

    // Two controls, because "no file matched" and "the matcher stopped
    // matching" look identical from the assertion above. The matcher
    // finds a planted one, ignores the overlay shadow that legitimately
    // stays, and every file in the list was really read.
    expect(offender(`<div class="${card}" />`, "fixture"), "the matcher must find a planted card shadow").toBe("fixture");
    expect(offender(`<div class="${plant(["shadow", "modal"])}" />`, "fixture")).toBeNull();
    for (const rel of SURFACE_FILES) {
      expect(readRepoFile(rel).length, `${rel} was read`).toBeGreaterThan(200);
    }
  });

  it("puts every ring in the rendered chat surface behind a state", () => {
    const { container } = renderComposer();
    // The primitives the composer is built from do use rings, so this
    // walk has something to find — which is the point: the check is
    // about *where* they are scoped, not whether any exist.
    const rings: { el: Element; cls: string }[] = [];
    for (const el of [container, ...Array.from(container.querySelectorAll("*"))]) {
      for (const c of el.classList) if (/^ring(-|$)/.test(bare(c))) rings.push({ el, cls: c });
    }
    expect(rings.length, "the walk found no ring to check").toBeGreaterThan(0);
    for (const { el, cls } of rings) {
      expect(
        cls.includes(":"),
        `<${el.tagName.toLowerCase()}> class="${cls}" — Tailwind builds a ring out of box-shadow, so one with no state puts a shadow on the resting surface`,
      ).toBe(true);
    }

    // The control: the same predicate, on a scoped ring and on a bare
    // one, so "everything was scoped" is a result and not a no-op.
    const scoped = ["focus-visible", plant(["ring", "2"])].join(":");
    expect(/^ring(-|$)/.test(bare(scoped)), "the control's scoped ring is a ring").toBe(true);
    expect(scoped.includes(":"), "a scoped ring carries a variant").toBe(true);
    expect(plant(["ring", "2"]).includes(":"), "a bare ring carries none").toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The streaming subtree, past the class-name guard's reach
 * ═══════════════════════════════════════════════════════════════════════ */
describe("the streaming tail declares nothing that repaints per frame", () => {
  it("finds no paint-forcing declaration behind the tail's own classes", async () => {
    // Both halves of the tail, not one. The thinking panel is a
    // conditional subtree — it exists only while the model is thinking —
    // and a walk that never rendered it would report a clean tree while
    // inspecting nothing, which is the failure this test was found to
    // have on its first run.
    const { container } = renderTail("A paragraph with **bold** text.", "weighing the options");
    const status = container.querySelector<HTMLElement>('[role="status"]');
    // Non-vacuity: a real prose subtree, the panel that renders beside
    // it, and the element the classes are read off is the one compiled.
    expect(status).toBeTruthy();
    expect(container.querySelector("strong")).toBeTruthy();
    expect(status!.textContent).toContain("A paragraph");
    const panel = thinkingPanel(container);
    expect(panel.textContent).toContain("weighing the options");

    // Both class lists in the subtree, not the prose one alone: the tail
    // is the panel *and* the markdown, and the guard this sits behind
    // walks the whole container.
    const classes = [...new Set([...panel.classList, ...status!.classList])];
    expect(classes.length, "the tail declares a class list to compile").toBeGreaterThan(0);
    expect(classes).toEqual(expect.arrayContaining(["prose"]));

    // The whole stylesheet, not the class-indexed half: the typography
    // plugin's descendant rules for `prose` are the case this test
    // exists for, and a strict index cannot reach them.
    const css = await compileOnce(classes);
    const found: string[] = [];
    for (const { selector, decls } of allRules(css)) {
      if (!classes.some((c) => selector.includes(c))) continue;
      for (const prop of PAINT_PROPS) {
        if (decls.has(prop)) found.push(`${selector} { ${prop}: ${decls.get(prop)} }`);
      }
    }
    expect(found, `the tail must not declare a paint-forcing property. Found: ${found.join(" | ")}`).toEqual([]);

    // The control: the sweep reads declarations, it does not guess. A
    // class that genuinely carries one is found, through the same path.
    const planted = plant(["shadow", "panel"]);
    const lit = allRules(await compileOnce([...classes, planted]));
    expect(
      lit.some(({ selector, decls }) => selector.includes(planted) && decls.has("box-shadow")),
      "the sweep must find a planted box-shadow",
    ).toBe(true);
  });

  it("finds no paint-forcing rule in globals.css that the tail can reach", () => {
    // Which rules reach the tail is an *enumeration*, not a match: the
    // tail renders `prose` and the markdown elements under it, and
    // nothing else in that file is in its subtree. So the question is
    // whether any rule mentioning one of those classes declares a
    // paint-forcing property.
    const { container } = renderTail("A paragraph with **bold** text.", "");
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    const globalClasses = ["prose"];

    const rules = allRules(readRepoFile("src/styles/globals.css"));
    // Non-vacuity on the *file* dimension: it parsed, and it holds the
    // rules the tail depends on.
    expect(rules.length).toBeGreaterThan(10);
    const reached = rules.filter(({ selector }) => globalClasses.some((c) => selector.includes(`.${c}`)));
    expect(reached.length, "globals.css's prose rules were found").toBeGreaterThan(0);
    expect(reached.map((r) => r.selector)).toEqual(
      expect.arrayContaining([".prose", ".prose pre", ".prose code", ".prose pre code"]),
    );

    const found: string[] = [];
    for (const { selector, decls } of reached) {
      for (const prop of PAINT_PROPS) {
        if (decls.has(prop)) found.push(`${selector} { ${prop}: ${decls.get(prop)} }`);
      }
    }
    expect(found, `globals.css reaches the streaming tail. Found: ${found.join(" | ")}`).toEqual([]);

    // The control, and it is a finding rather than a fixture. The
    // settled-row code block *does* carry a transition — its language
    // label and copy button each fade on hover — declared in the frozen
    // file and invisible to any class-name sweep. It is outside the tail
    // only because the streaming path renders a plain `pre` instead, so
    // this is the line that catches the day that changes.
    const wrap = rules.filter(({ selector }) => selector.includes(".code-block-wrap"));
    const wrapPaint = wrap.flatMap(({ selector, decls }) =>
      PAINT_PROPS.filter((p) => decls.has(p)).map((p) => `${selector} { ${p} }`),
    );
    expect(wrapPaint.length, "the scanner reads globals.css: it finds the code block's transitions").toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Radii
 *
 * A hardcoded radius is the one thing in the theming system a theme
 * cannot move, and it is the defect this plan found on `Panel`, `Modal`
 * and `Badge`. The four theme radii are 6, 10, 16 and 24px, so a
 * conversion is only free when the default-scale value it replaces
 * happens to equal a token — which is why the report names the number for
 * each one rather than saying "made it theme-following".
 * ═══════════════════════════════════════════════════════════════════════ */
describe("every radius the chat surface declares is a theme radius", () => {
  it("finds no default-scale or hardcoded radius in the surface's markup", () => {
    const offenders: string[] = [];
    for (const rel of SURFACE_FILES) {
      for (const lit of literals(readRepoFile(rel))) {
        for (const m of lit.matchAll(RADIUS_TOKEN)) {
          if (!radiusOk(m[1])) offenders.push(`${rel}: ${m[1]}`);
        }
      }
    }
    expect(offenders, `a radius a theme cannot move. Offenders: ${offenders.join(", ")}`).toEqual([]);

    // The control, on the token scan itself: it finds a hardcoded radius
    // and a bare default in a string this test does not own, so the clean
    // result above is a clean tree and not a stopped matcher.
    const planted = plant(["rounded", "[8px]"]);
    const fixture = `${planted} ${plant(["rounded", "2xl"])} rounded rounded-lg rounded-full`;
    expect([...fixture.matchAll(RADIUS_TOKEN)].map((m) => m[1])).toEqual([
      planted,
      plant(["rounded", "2xl"]),
      "rounded",
      "rounded-lg",
      "rounded-full",
    ]);
  });

  it("reads every token radius as a theme variable, and nothing else as one", async () => {
    for (const cls of TOKEN_RADII) {
      const decls = (await emitted([cls])).get(cls)!;
      expect(decl(decls, "border-radius", cls), `${cls} must read the theme's own radius`).toBe(
        `var(--radius-${cls.replace("rounded-", "")})`,
      );
    }
    // The control on the resolver: a default-scale radius resolves to a
    // length, so `pxOf` can measure one. And `toPx` *refuses* a token
    // rather than guessing — the same refusal that makes the assertion
    // above a measurement rather than a string comparison.
    expect(await pxOf(plant(["rounded", "2xl"]), "border-radius")).toBe(16);
    expect(await pxOf("rounded", "border-radius")).toBe(4);
    await expect(pxOf("rounded-lg", "border-radius")).rejects.toThrow(/no absolute length/);
  });

  it("moves no pixel on the default themes, and changes two on purpose", async () => {
    // A conversion is only free if the token it landed on already equals
    // the value it replaced, so that has to be measured rather than
    // assumed. `globals.css` is where the browser's starting value comes
    // from; `themes.rs` is where the other five are.
    const rootRadius = (key: string) =>
      toPx(readRepoFile("src/styles/globals.css").match(new RegExp(`--radius-${key}:\\s*([^;]+);`))![1], `--radius-${key}`);
    // The 1rem conversions are free: `--radius-lg` is already 16px.
    expect(await rootRadius("lg")).toBe(await pxOf(plant(["rounded", "2xl"]), "border-radius"));
    // The bare-`rounded` one is not, and the difference is asserted as a
    // delta rather than waved at: 4px becomes 6px, the same trade Task 2
    // made on `Badge`. Pinning the delta puts the number on the record
    // and a theme that widened the gap would fail rather than pass.
    const bareDefault = await pxOf("rounded", "border-radius");
    expect((await rootRadius("sm")) - bareDefault).toBe(2);

    // The scope of that claim, which is the half that is easy to forget:
    // the radius scale is not the same in all six built-in themes. Mono
    // and High Contrast declare 6px where the other four declare 16px,
    // so on those two the converted bubble goes from 16px to 6px — a
    // real change, and the one a theme-varying radius exists to make.
    const themes = readRepoFile("src-tauri/src/themes.rs");
    const lg = [...themes.matchAll(/"radius\.lg":\s*"([^"]+)"/g)].map((m) => m[1]);
    // Six themes, two distinct values: the control on the scan is that
    // it read all six and still found more than one scale.
    expect(lg, "every built-in theme was read").toHaveLength(6);
    expect(new Set(lg), "the radius scale is not the same in all six themes").toHaveProperty("size", 2);
    expect([...new Set(lg)]).toEqual(["16px", "6px"]);
    // And it is read from the *other* file than the one above, so a
    // claim scoped to `globals.css` cannot quietly become a claim about
    // the themes.
    expect(themes).toContain("const MONO");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Density
 *
 * The plan splits the app's rhythm in two: Memory, Documents and Tasks
 * are compact, everything else — chat included — is standard. That is a
 * real rule, a restyle can break it silently, and the way it was measured
 * on the Memory page is reused here unchanged: both sides through one
 * compile, compared as pixels, with the compact value named rather than
 * pinned, so a retune of Tailwind's spacing scale moves both sides.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("chat keeps the standard rhythm, not the compact one", () => {
  it("gives a message row more air than a compact row gets", async () => {
    const { container } = render(<MessageRow msg={chatMessage()} {...ROW_PROPS} />);
    const row = container.querySelector<HTMLElement>("[data-ctx]");
    // Non-vacuity: the walk found the row it is about to measure.
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("an answer");

    const padClass = classOf(row!, /^py-/);
    const rowPad = await pxOf(padClass, "padding-top", "padding");
    // `p-2` is the compact row's own padding, from `MemoryRoute`, read
    // through this same compile and the same helper.
    const compact = await pxOf("p-2", "padding-top", "padding");
    expect(
      rowPad,
      `a message row declares ${padClass} = ${rowPad}px, which is not more than the compact rhythm's ${compact}px`,
    ).toBeGreaterThan(compact);

    // The control: the comparison rejects both halves of the compact
    // rhythm, so "greater than p-2" is a measurement rather than a
    // tautology about a number nobody chose.
    expect(await pxOf("py-1", "padding-top", "padding")).toBeLessThanOrEqual(compact);
    expect(await pxOf("py-2.5", "padding-top", "padding")).toBeGreaterThan(compact);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The thinking panel
 *
 * A coupling this task found rather than one it was told about. The
 * streaming tail and the settled row each hand-write their thinking
 * panel, and they are two renderings of one thing: the panel a user
 * watches grow is replaced by the panel they read afterwards. If the two
 * disagree on surface, border or radius it jumps at the instant the
 * stream ends — the one moment a user is definitely looking at it, and
 * the one moment the "no restyle when the stream ends" property the
 * renderer documents in order to exist is broken.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("the thinking panel does not restyle itself when the stream ends", () => {
  it("gives the streaming panel and the settled panel the same geometry", () => {
    const tail = renderTail("an answer", "weighing the options");
    const row = render(<MessageRow msg={chatMessage({ thinking: "weighing the options" })} {...ROW_PROPS} />);

    const streaming = thinkingPanel(tail.container);
    const settled = thinkingPanel(row.container);
    // Non-vacuity on both halves, and on the text that identifies them.
    expect(streaming.textContent).toContain("weighing the options");
    expect(settled.textContent).toContain("weighing the options");

    expect(geometry(settled.className)).toEqual(geometry(streaming.className));
  });

  it("rejects a panel that drifted, so the comparison is not trivially true", () => {
    const panel = "mb-3 bg-surface-2/50 border border-border rounded-xl";
    // The same panel, four drifts, each a plausible edit.
    const drifted = [
      panel.replace("rounded-xl", "rounded-lg"),
      panel.replace("bg-surface-2/50", plant(["bg-surface-3", "50"])),
      panel.replace("border-border", "border-border-strong"),
      panel.replace(" border ", " "),
    ];
    for (const d of drifted) {
      expect(geometry(panel), `the comparison must reject a panel that drifted: ${d}`).not.toEqual(geometry(d));
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * What repaints per frame
 *
 * A restyle of the page chrome is only free if the chrome is not on the
 * frame path. `useChat` subscribes to five slices; a chunk bump replaces
 * the session object and moves only `streamContent` and
 * `streamThinking`. So the question is whether any of those five move —
 * asked of the store, because that is the fact, with the subscription
 * list itself pinned so the answer cannot go stale.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("a chunk does not re-render the page chrome", () => {
  it("leaves every slice the chat chrome subscribes to untouched", () => {
    const useChat = readRepoFile("src/hooks/useChat.ts");
    // The five subscriptions the component below stands in for. Pinned
    // because a sixth would be a new re-render trigger this assertion
    // knows nothing about — the count is the guard, and the field set is
    // what makes the count mean something.
    const fields = [...useChat.matchAll(/s\.sessions\[sessionId\]\?\.(\w+)/g)].map((m) => m[1]);
    expect(fields).toEqual(["streaming", "status", "messages", "error", "loadingMessages"]);
    expect(useChat.match(/useChatStreamStore\(/g)!.length).toBe(fields.length);

    // Five subscriptions, not one over the session object. That is not
    // pedantry: a single `s.sessions.s1` selector returns a *new*
    // identity on every bump, so it would re-render 100 times and this
    // test would measure nothing. This mirrors `useChat` line for line.
    const EMPTY_MESSAGES: ChatMessage[] = [];
    let renders = 0;
    function Chrome() {
      const streaming = useChatStreamStore((s) => s.sessions.s1?.streaming ?? false);
      const status = useChatStreamStore((s) => s.sessions.s1?.status ?? "idle");
      const messages = useChatStreamStore((s) => s.sessions.s1?.messages ?? EMPTY_MESSAGES);
      const error = useChatStreamStore((s) => s.sessions.s1?.error ?? null);
      const loadingMessages = useChatStreamStore((s) => s.sessions.s1?.loadingMessages ?? false);
      renders++;
      return <span>{`${streaming}|${status}|${messages.length}|${error}|${loadingMessages}`}</span>;
    }

    useChatStreamStore.setState({
      sessions: {
        s1: {
          messages: [],
          status: "streaming",
          streaming: true,
          streamContent: "",
          streamThinking: "",
          error: null,
          loadingMessages: false,
        },
      },
    });
    const { container } = render(<Chrome />);
    const before = renders;
    expect(before, "the subscriber rendered once").toBe(1);
    const rendered = container.textContent;

    // What `publish` does on the rAF drain, in shape: a new session
    // object, the same messages array, only the string accumulators
    // moved. Nothing else about the store changes.
    for (let i = 0; i < 100; i++) {
      act(() => {
        useChatStreamStore.setState((prev) => ({
          sessions: {
            ...prev.sessions,
            s1: { ...prev.sessions.s1, streamContent: `${prev.sessions.s1.streamContent}chunk ` },
          },
        }));
      });
    }

    expect(renders, "100 chunk bumps re-rendered the chat chrome").toBe(before);
    expect(container.textContent).toBe(rendered);
    // The bumps really happened, so the null above is a no-commit and
    // not a no-op.
    expect(useChatStreamStore.getState().sessions.s1.streamContent).toHaveLength(600);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * A control that was replaced with a primitive
 *
 * The header's overflow trigger was a hand-written `<button>` and is now
 * `IconButton`. `Dropdown` clones its trigger, so substituting a component
 * for an element is the kind of change that can pass every visual check
 * and leave a dead control — so the menu is opened here rather than
 * assumed. Nothing covered this header before; that gap is why the swap
 * was not free.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("the session actions control still opens its menu", () => {
  it("opens on click, and is reachable by its accessible name", async () => {
    const { getByLabelText, findByRole, queryByRole } = render(
      <ChatHeader
        providers={[{ id: "p1", name: "Local", kind: "ollama", is_default: true } as never]}
        models={[{ id: "m1", name: "llama3", size_bytes: 4_000_000_000 } as never]}
        providerId="p1"
        modelId="llama3"
        setProviderId={() => {}}
        setModelId={() => {}}
        setModels={() => {}}
        setContextLength={() => {}}
        sessionId="s1"
        contextLength={8192}
        totalTokens={1234}
        onClear={async () => {}}
      />,
    );

    const trigger = getByLabelText("Session actions");
    expect(trigger.tagName).toBe("BUTTON");
    expect(queryByRole("menu"), "the menu is closed to begin with").toBeNull();

    fireEvent.click(trigger);
    const menu = await findByRole("menu");
    // Trimmed because the first item's label is preceded by its icon,
    // and length as well as content: a menu that opened with one item
    // missing would still satisfy a membership check.
    const items = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(items).toEqual(["Memory for this session", "Export as Markdown", "Clear session"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Colour
 *
 * Zero literal hex values in the diff, greppable. This is a guard rather
 * than a discovery: the surface had no literals before this task and has
 * none after, and a sweep that has never found anything is exactly the
 * kind that needs proving it still can.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("no colour literal reaches the chat surface", () => {
  const LITERALS: { label: string; re: RegExp; sample: string }[] = [
    { label: "hex", re: /#[0-9a-fA-F]{3,8}\b/, sample: `#${"ff0000"}` },
    { label: "rgb", re: /\brgba?\(/, sample: `rg${"b(1, 2, 3)"}` },
    { label: "hsl", re: /\bhsla?\(/, sample: `hs${"l(210 50% 40%)"}` },
    { label: "oklch", re: /\boklch\(/, sample: `okl${"ch(0.5 0.1 200)"}` },
  ];

  it("finds none in the surface's source", () => {
    const found: string[] = [];
    for (const rel of SURFACE_FILES) {
      const src = readRepoFile(rel);
      for (const { label, re } of LITERALS) if (re.test(src)) found.push(`${label} in ${rel}`);
    }
    expect(found, `colour literals in the chat surface: ${found.join(", ")}`).toEqual([]);
  });

  it("finds none in what the surface renders, in any state", () => {
    const composer = renderComposer();
    const row = render(<MessageRow msg={chatMessage({ role: "user", content: "hi" })} {...ROW_PROPS} />);
    const tail = renderTail("A paragraph with `code`.", "thinking");

    const found: string[] = [];
    for (const { container } of [composer, row, tail]) {
      for (const el of [container, ...Array.from(container.querySelectorAll("*"))]) {
        const surfaces = [...el.classList, el.getAttribute("style") ?? ""].join(" ");
        for (const { label, re } of LITERALS) {
          if (re.test(surfaces)) found.push(`${label} on <${el.tagName.toLowerCase()}> ${surfaces}`);
        }
      }
    }
    expect(found, `colour literals in the rendered chat surface: ${found.join(", ")}`).toEqual([]);

    // The control, planted per pattern at runtime for the scanner reason
    // in the header.
    for (const { label, re, sample } of LITERALS) {
      expect(re.test(sample), `the ${label} pattern must match a planted literal`).toBe(true);
    }
  });
});
