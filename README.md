# Convo

A memory-first chat client for Ollama — local and cloud — wrapped in a self-hosted desktop workspace: model comparison, documents, notes, tasks, hardware-aware recommendations, and diagnostics. Chat is the product; the rest of the tabs support it. Inspired by the depth of [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) and the simplicity of native desktop tools. Built with Tauri v2 (Rust) + React + TypeScript + Tailwind. Local-first, privacy-first, no telemetry.

> **v0.7 — polish & responsive pass**, since realigned around a memory-first product statement. v0.4 introduced the foundation (SQLite, multi-provider, design system). v0.5 added chat power-user QoL, compare, and documents. v0.6 added hardware scan, model-fit recommendations, diagnostics, backup/restore, a global hotkey, and a guided first-run experience. v0.7 added error boundaries, responsive layout, animation polish, a decomposed chat component architecture, native dialog replacement, and an attachment picker fix. The realignment moved retrieval, scoring, context assembly, extraction, and revision into Rust over a unified knowledge index — `docs/GOALS.md` is the canonical product statement.

## Features

### Chat & providers
- **Multi-provider chat** — Ollama + any OpenAI-compatible endpoint (OpenRouter, vLLM, llama.cpp). Local server auto-discovery scans ports 8000-8020. API keys in OS keyring.
- **Per-session model persistence** — reopen a chat and it's the same setup.
- **Block-split streaming** — the stream is cut into blocks that can no longer change plus one live tail; each frozen block renders once through the same renderer settled messages use, so a finished message never restyles and a growing code fence is never re-highlighted.
- **Slash commands** with autocomplete — `/help /new /clear /regenerate /model /search /note /task /remember`
- **Web search** — SearXNG / DuckDuckGo / Brave; results prepended as cited context.
- **File attachments** — drag-drop, paste, paperclip. Vision-capable models receive images inline. Stored in `data_dir/blobs/`.
- **Message actions** — copy, copy as Markdown, regenerate, edit & resend, delete, toggle thinking, save to note.
- **Session search overlay** (Ctrl+Shift+F) — full-text across titles and message content via SQLite FTS5.
- **Session export** as Markdown.

### Compare
- **Side-by-side 2–4 models** with blind mode, per-column stop, per-model elapsed/token counts.
- **History view** — browse past comparisons, replay them.
- **Save winner as chat** — continues the winning response in a regular session.

### Documents
- Multi-tab internal editor with **Tauri fs open/save** (`.md` `.txt` code files).
- **AI edit assist** — `ai_edit_document` Rust command sends the doc + selection + instruction to the LLM, returns the proposed full text. **Line-based diff preview** (LCS) with +added/−removed stats and accept/reject modal.
- **Insert into chat** — pre-fills the chat composer with the selection wrapped in a fenced block.
- Markdown preview, syntax-highlighted code blocks, word + char count.

### Memory & skills
- **Categorized memory items** (user preferences, project facts, skills) with two independent switches: *enabled* means eligible for retrieval, *pinned* means injected on every send regardless of retrieval.
- **Hybrid recall** — BM25 and embedding routes over memory and notes, each contributing a fixed candidate depth, fused by reciprocal rank, trimmed to a token budget, all in Rust. Recall never fails a send: no embedder, no vectors, or a dimension mismatch degrades to keyword-only.
- **Recall scope** — which kinds of memory a send may pull in is a setting (`memory.recall_kinds`), consumed on the send path. Pinned items are injected whatever the scope says, and an empty or unreadable scope means every kind rather than none.
- **Why recalled** — every injected item reports the route that found it and the terms that matched, and each answer carries the list of what it used: `messages.memory_used` holds a provenance snapshot (id, label, title, reason) so the disclosure survives a reload — and still names a memory that has since been deleted — without duplicating memory bodies into the transcript.
- **Extraction and revision** — facts are pulled from settled turns on a watermark, judged against what is already stored, and merged, reinforced, or superseded. Confident revisions apply themselves; genuine ambiguities land in the review inbox.
- **FTS5 search** with snippet highlighting across memory and messages.
- Tags per item, and bidirectional links between a memory and the note that came from it.

### Notes & tasks
- Notes get tags and a link back to the source chat when saved from a message.
- Tasks with priority, due dates, and completion state.
- `/note <text>` and `/task <text>` slash commands.
- Full-text search across notes.

### Workspace polish
- **Hardware scan + model-fit recommendations** — sysinfo-based RAM/CPU/GPU detection (NVIDIA via nvidia-smi, AMD via rocm-smi, Apple via system_profiler); suggests which of a curated 15-model set fits / fits tightly / won't fit.
- **Diagnostics page** — DB stats, schema version, provider reachability, recent log lines, storage usage, table row counts. One-click backup export and import.
- **Backup/restore** — single `.zip` of `convo.db` + `blobs/` + `themes/` + `manifest.json`.
- **First-run experience** — guided welcome when no providers are configured.
- **Starter suggestions** in the chat empty state (with pre-fill).
- **Global hotkey** — Ctrl+Shift+Space toggles the main window from anywhere.
- **Command palette** (Ctrl+K) with action registry; arrow nav, fuzzy search.
- **Keyboard shortcuts** — rebindable per-shortcut with Mac/PC display.
- **Onboarding tour** — 6 steps with target anchoring; replayable from About.
- **Themes** — 6 built-in (Default Dark, Default Light, Solar, Forest, Mono, High Contrast) + user-defined. Light/dark/system. CSS-variable driven, no flash on reload.
- **Responsive layout** — auto-collapsing sidebar below 760px, responsive content padding, stacked compare columns on narrow screens.
- **Error boundaries** — route-level and streaming-level boundaries prevent single-component crashes from taking down the app.
- **Animation polish** — message entrance, sidebar transitions, skeleton loading states, thinking-section collapse/expand, all respecting `prefers-reduced-motion`.

## Tech Stack

| Layer    | Technology                                                |
| -------- | --------------------------------------------------------- |
| Shell    | Tauri v2 (Rust)                                           |
| Backend  | Rust (tokio, reqwest, rusqlite + r2d2, async-trait)       |
| DB       | SQLite + FTS5 (`~/.local/share/convo/convo.db`)            |
| Hardware | `sysinfo`, nvidia-smi, rocm-smi, system_profiler          |
| Secrets  | OS keyring (via `keyring` crate)                           |
| Frontend | React 18 + TypeScript, Zustand, react-router v6          |
| UI       | Tailwind CSS + CSS custom properties                      |
| Markdown | react-markdown + remark-gfm + react-syntax-highlighter    |

## Architecture

```
src/
  app/         # App shell, router, providers
  routes/      # Top-level views: Chat, Compare, Documents, Notes, Tasks,
               # Memory, Hardware, Diagnostics, Settings, About
  components/
    ui/        # Design system: Button, Modal, Panel, ConfirmDialog,
               # ErrorBoundary, AnimatedUnmount, Skeleton, Switch, Select,
               # Slider, Tabs, Tooltip, Badge, Dropdown, Toast, Spinner
    chat/      # ChatViewNew (orchestrator), ChatHeader, MessageList,
               # MessageRow, StreamingTail, ChatInput, ChatContextMenu,
               # MarkdownRenderer, AttachmentChip, SessionMemoryModal
    memory/    # RecallPanel, SupersedeHistory, IndexStatusBanner
    sidebar/   # Sidebar, StatusCard
    tour/      # TourOverlay
  hooks/       # useChat, useAttachments, useGlobalKeyHandler, useMediaQuery,
               # useSettings
  lib/         # api.ts, contracts, slashCommands, markdown, markdownBlocks,
               # diff, logger, notesDraft, lastUsedChatModel
  stores/      # Zustand stores: theme, toasts, settings, sessions, palette,
               # shortcuts, tour, memory, chatStream
  styles/      # globals.css (CSS variables + keyframes)

src-tauri/src/
  lib.rs                       # Tauri builder, plugins, global shortcut
  db/                          # SQLite pool + migrations + models + legacy import
    legacy.rs                  # conversations.json -> SQLite import
  migrations/                  # (sibling of src/: V001..V012 SQL migrations)
  memory/                      # Retrieval core: retrieve, context, extract,
                               # revise, index, embed, config
  providers/                   # Provider trait + Ollama + OpenAI-compat + discovery
  commands/                    # 108 registered Tauri commands: chat, sessions,
                               # providers, themes, notes, tasks, memory,
                               # documents, attachments, search, compare, slash,
                               # settings, hardware, backup, models
  streams.rs                   # Active chat streams + cancel tokens
  services.rs                  # Providers, themes, settings, app info
  state.rs                     # Tauri state container
  themes.rs                    # Built-in theme definitions
```

## Getting Started

```bash
git clone git@github.com:tea-LZL/Convo.git
cd Convo
npm install
cargo tauri dev      # development
cargo tauri build    # release build (.deb)
```

## Configuration

Data lives at `~/.local/share/convo/`:

- `convo.db` — SQLite database (sessions, messages, providers, models,
  memory, themes, etc.) + FTS5 virtual tables
- `blobs/` — attachment file storage
- `themes/` — exported user themes
- `logs/convo.log` — application log (last 200 lines shown in Diagnostics)

API keys are stored in the OS keyring (`com.tea.convo` service), not in the database.

## Keyboard Shortcuts

| Combo                  | Action                    |
| ---------------------- | ------------------------- |
| `Ctrl+K` / `⌘K`        | Command palette           |
| `Ctrl+N`               | New chat                  |
| `Ctrl+B`               | Toggle sidebar            |
| `Ctrl+,`               | Settings                  |
| `Ctrl+/`               | Focus input               |
| `Ctrl+Shift+F`         | Search sessions           |
| `Ctrl+Shift+Space`     | Toggle main window (global) |
| `Esc`                  | Cancel stream / close overlay |

All in-app shortcuts are rebindable in Settings → Shortcuts.

## Roadmap

**This section is stale. `docs/GOALS.md` is canonical, not this roadmap.**

v0.7 shipped a workspace-shaped app — six tabs, model comparison, document editing. The product was subsequently realigned to a **memory-first Ollama chat client**: the feature sprawl is being demoted in the nav rather than deleted, and the memory core (which had degraded to a browser-side substring scorer) is being rebuilt around a unified knowledge index with hybrid keyword + embedding retrieval. See `docs/GOALS.md` and `docs/superpowers/specs/`.

Superseded v0.7 wishlist, retained for reference:
- Hardware-aware auto-suggest when picking models in the chat header
- Tray icon with quick actions
- Auto-update via Tauri updater
- Document AI editing in the renderer (vs the chat composer)
- Code-splitting for the 1.1MB JS bundle (dynamic imports per route)
- Sync via Convo Sync (out of scope: desktop stays local-only)

Note that "auto-update" and any plugin-style extension surface are explicitly non-goals under the realignment.

## License

MIT
