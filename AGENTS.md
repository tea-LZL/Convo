# Convo — Agent Guide

## Verification trio
```bash
npm run typecheck   # tsc --noEmit
npm run test:run    # vitest run (107 tests, must be 0 failures)
npm run build       # tsc + vite build
```
Rust: `cargo check --manifest-path src-tauri/Cargo.toml` (long first compile; warm cache afterwards).

## Theming
All colors come from CSS custom properties defined in `src/styles/globals.css` and exposed as Tailwind aliases in `tailwind.config.js`. **Never hardcode hex colors.** Always use `bg-surface-2`, `text-muted`, `border-border`, `text-accent`, etc. The theme system depends on this — user themes override the CSS vars, and hardcoded colors would ignore them.

## Streaming architecture
Three modules, each with a single responsibility. Do not re-couple them:
- `src/stores/chatStream.ts` — owns the Tauri `chat-*` event listeners (registered once, app-lifetime). Frame-batches chunks via `requestAnimationFrame`. Per-session state map survives session switching.
- `src/components/chat/ChatViewNew.tsx` — owns the component tree (MessageList + StreamingSection + ChatInput). Does NOT subscribe to streaming slices directly (that would re-render 60fps).
- `src/lib/streamingRenderer.ts` — owns the DOM-direct tail render. Plain DOM, no React. The segmenter (`streamingSegmenter.ts`) decides freeze boundaries; the renderer applies them.

## React.memo discipline
`MessageRow` uses a custom comparator (`messageRowAreEqual`) for `React.memo`. Any new prop added to `MessageRow` MUST be added to the comparator, or streaming will silently re-render all rows at 60fps and the lag bugs from v0.6.5 will return. If the comparator is stale, fix it before touching anything else.

## Tauri command registration
New Rust commands must be registered in `src-tauri/src/lib.rs` `invoke_handler![...]` or they're invisible to the frontend. The list is ~60 commands; keep it alphabetical within each section.

## File conventions
- `write_file` for new files, `patch` for edits to existing files.
- Named exports, not default. 2-space JSX indentation.
- Import order: React → third-party → local (`../../lib/`, `../../stores/`).