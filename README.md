# Convo

A self-hosted AI workspace for Linux — multi-provider chat, model comparison, documents, notes, tasks, and memory, all in a native desktop app. Inspired by the depth of [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) and the simplicity of native desktop tools.

Built with Tauri v2 (Rust) + React + TypeScript + Tailwind. Local-first, privacy-first, no telemetry.

> **v0.4 — Major rewrite.** This release re-architects Convo from a single-purpose Ollama chat client into a full self-hosted AI workspace, modeled on Odysseus's breadth. SQLite replaces the JSON store, a provider abstraction enables any OpenAI-compatible backend, and a modular route shell hosts chat, compare, documents, notes, tasks, and memory.

## Features

- **Multi-provider chat** — Ollama + any OpenAI-compatible endpoint (OpenRouter, vLLM, llama.cpp, etc.). Local server auto-discovery scans ports 8000-8020.
- **Presets** — Saved system prompts + temperature, top_p, top_k, num_ctx, repeat_penalty, stop. Built-ins: Default, Concise, Code, Socratic, Pirate.
- **Model comparison** — Side-by-side or 3-/4-way blind A/B test the same prompt across different models.
- **Documents** — Multi-tab markdown editor with auto-save and per-doc tabs.
- **Notes & Tasks** — Quick notes and to-do list. Tasks have priority, due dates, and completion state.
- **Memory** — Categorized long-term context (user preferences, project facts, skills). Included with every chat.
- **Themes** — 6 built-in themes (Default Dark, Default Light, Solar, Forest, Mono, High Contrast) + user-defined custom themes. Light/dark/system modes.
- **Command palette** — `Ctrl/Cmd+K` for everything: switch models, open settings, run slash commands, navigate routes.
- **Keyboard shortcuts** — Rebindable, with Mac/Windows display. Defaults: ⌘K palette, ⌘B sidebar, ⌘N new chat, ⌘, settings, ⌘/ focus input, ⌘⇧F search.
- **Streaming** — Real-time token rendering with thinking cards. Cancel mid-stream. Background session caching.
- **Search** — Cross-session full-text search.
- **Sessions** — Pin, archive, group, rename, delete. Auto-saved.
- **Tauri-native** — System notifications, file system access, OS keyring for API keys, tray-ready.
- **Migrated data** — Existing `conversations.json` is auto-imported into SQLite on first launch of v0.4+.

## Tech Stack

| Layer    | Technology                                                |
| -------- | --------------------------------------------------------- |
| Shell    | Tauri v2 (Rust)                                           |
| Backend  | Rust (tokio, reqwest, rusqlite + r2d2, async-trait)       |
| DB       | SQLite (`~/.local/share/convo/convo.db`) with migrations  |
| Frontend | React 18 + TypeScript                                     |
| State    | Zustand (with persist middleware)                         |
| Routing  | react-router-dom v6                                       |
| Styling  | Tailwind CSS + CSS custom properties                      |
| Markdown | react-markdown + remark-gfm + react-syntax-highlighter    |
| Secrets  | OS keyring (via `keyring` crate)                           |

## Architecture

```
src/
  app/         # App shell, providers, router
  routes/      # Top-level views: Chat, Compare, Documents, Notes, Tasks, Memory, Settings, About
  components/
    ui/        # Design system: Button, Modal, Panel, Switch, Select, Slider, Tabs, Tooltip, ...
    chat/      # ChatViewNew
    sidebar/   # Sidebar
    tour/      # TourOverlay
  hooks/       # useChat, useGlobalKeyHandler
  lib/         # api.ts (Tauri command wrappers)
  stores/      # Zustand stores: theme, toasts, settings, sessions, palette, shortcuts, tour
  styles/      # globals.css (CSS vars, scrollbar, focus)
  types/       # Shared types

src-tauri/src/
  lib.rs                       # Tauri builder, plugin/state wiring
  db/                          # SQLite pool + migrations + models
    legacy.rs                  # conversations.json -> SQLite import
  providers/                   # Provider trait + Ollama + OpenAI-compat + discovery
  commands/                    # Tauri command handlers (chat, sessions, presets, ...)
  streams.rs                   # Active chat streams + cancel tokens
  services.rs                  # Providers, themes, settings, app info
  state.rs                     # Tauri state container
  themes.rs                    # Built-in theme definitions
```

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [Ollama](https://ollama.com/) running locally (or any OpenAI-compatible endpoint)
- `webkit2gtk-4.1` (Arch: `pacman -S webkit2gtk-4.1`)

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

- `convo.db` — SQLite database (sessions, messages, presets, providers, etc.)
- `blobs/` — attachment file storage
- `themes/` — exported user themes
- `logs/convo.log` — application log

API keys are stored in the OS keyring (`com.tea.convo` service), not in the database.

## Keyboard Shortcuts

| Combo       | Action                    |
| ----------- | ------------------------- |
| `Ctrl+K`    | Command palette           |
| `Ctrl+N`    | New chat                  |
| `Ctrl+B`    | Toggle sidebar            |
| `Ctrl+,`    | Settings                  |
| `Ctrl+/`    | Focus input               |
| `Ctrl+Shift+F` | Search sessions        |
| `Esc`       | Cancel stream / close overlay |

All shortcuts are rebindable in Settings → Shortcuts.

## Roadmap

See [ROADMAP](#) for the full picture. Active phases (post-v0.4):

- **Phase 2** — Streaming renderer improvements (Odysseus-style segmenter), slash commands, web search integration, file attachments.
- **Phase 3** — Memory auto-extraction, vector search, document AI editing.
- **Phase 4** — Hardware-aware model recommendations, diagnostics, imports from ChatGPT/Claude.

## License

MIT
