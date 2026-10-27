# Convo — Agent Guide

## Verification trio
```bash
npm run typecheck   # tsc --noEmit
npm run test:run    # vitest run (869 tests, must be 0 failures — floor; never drops)
npm run build       # tsc + vite build
```
Rust: `cargo check --manifest-path src-tauri/Cargo.toml` (long first compile; warm cache afterwards).

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml   # 312 tests, must be 0 failures
```

One gate is deliberately not in that list, because its numbers only mean
something in an optimised build:

```bash
cargo test --release --manifest-path src-tauri/Cargo.toml -- \
    --ignored recall_latency --nocapture   # recall p95 at 5,000 items
```

It asserts the `<50ms` p95 budget over a 5,000-item corpus with 5,000 stored
vectors (keyword-only, both routes, vector-only). Last measured: 9.5ms /
27.1ms / 16.2ms. Run it after touching `memory/retrieve.rs`, `memory/embed.rs`,
or the fusion path.

Two gates guard invariant drift rather than behaviour: `npm run check:version`
(one version across `package.json`, `Cargo.toml`, `tauri.conf.json`) and
`npm run check:commands` (every frontend `invoke` has a registered Rust command).

## Theming
All colors come from CSS custom properties defined in `src/styles/globals.css` and exposed as Tailwind aliases in `tailwind.config.ts`. **Never hardcode hex colors.** Always use `bg-surface-2`, `text-muted`, `border-border`, `text-accent`, etc. The theme system depends on this — user themes override the CSS vars, and hardcoded colors would ignore them.

## Streaming architecture
Three responsibilities, none of which may absorb another's:
- `src/stores/chatStream.ts` — owns the Tauri `chat-*` event listeners (registered once, app-lifetime). Frame-batches deltas via `requestAnimationFrame`. Per-session state map survives session switching. Cancellation is a generation counter, so a late chunk from a stopped stream is dropped rather than painted.
- `src/components/chat/StreamingTail.tsx` — the live tail. Splits the accumulated source with `splitBlocks` (`src/lib/markdownBlocks.ts`) into blocks that can no longer change plus one tail, and renders every block through the same `MarkdownRenderer` settled messages use. `React.memo` comparing `content` is the freeze: a frozen block's source never changes, so it never re-parses.
- `src/components/chat/ChatViewNew.tsx` — the orchestrator. Owns state, effects, and the component tree (MessageList + StreamingTail + ChatInput); does NOT subscribe to streaming slices directly.

The removed DOM-direct renderer (`streamingRenderer.ts` / `streamingSegmenter.ts`) must not come back: it needed a second HTML pipeline, which restyled every message the instant its stream ended. The invariants are asserted in `src/components/chat/__tests__/streamPerformance.test.tsx` — one parse per frozen block, flat commit count for settled rows, nothing accepted after the terminal event.

## React.memo discipline
`MessageRow` uses a custom comparator (`messageRowAreEqual`) for `React.memo`. Any new prop added to `MessageRow` MUST be added to the comparator, or streaming will silently re-render all rows at 60fps and the lag bugs from v0.6.5 will return. If the comparator is stale, fix it before touching anything else.

## Tauri command registration
New Rust commands must be registered in `src-tauri/src/lib.rs` `invoke_handler![...]` or they're invisible to the frontend. The list is 108 commands, grouped by area under a `// Section` comment — add yours to its group, not at the end. `npm run check:commands` fails the build if a frontend `invoke` has no registered command, and `src/routes/__tests__/*` covers the reverse for the surfaces under test.

## File conventions
- Named exports, not default. 2-space JSX indentation.
- Import order: React → third-party → local (`../../lib/`, `../../stores/`).