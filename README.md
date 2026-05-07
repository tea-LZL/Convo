# Convo

A sleek, native desktop chat application for Linux that connects to local Ollama models. Built with Tauri v2, React, and TypeScript — styled like modern AI assistants (Codex/Cursor).

![Preview](https://github.com/user-attachments/assets/preview.png)

## Features

- **Local AI Models** — Connects to your local Ollama instance (qwen3.5, gemma4, etc.)
- **Real-time Streaming** — SSE streaming with live token-by-token rendering
- **Thinking Display** — Shows model reasoning/thinking in collapsible cards
- **Accurate Token Tracking** — Real prompt + output token counts from Ollama, with model-specific context window awareness
- **Custom Context Menu** — Right-click messages to copy, regenerate, or toggle thinking cards
- **Sound Effects** — Subtle Web Audio API sounds for send and response completion
- **Desktop Notifications** — Notifies when a response completes while the window is unfocused
- **Settings Panel** — Ripple animation reveal, toggle sounds and notifications
- **Conversation Management** — Create, rename (double-click), delete conversations
- **Model Switching** — Inline dropdown with model size display
- **Markdown & Code** — Full markdown rendering with syntax-highlighted code blocks

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Tauri v2 |
| Frontend | React + TypeScript |
| Styling | Tailwind CSS |
| Backend | Rust (tokio, reqwest) |
| AI Runtime | Ollama (local) |

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [Ollama](https://ollama.com/) running locally
- `webkit2gtk-4.1` (Arch Linux: `pacman -S webkit2gtk-4.1`)

## Getting Started

```bash
# Clone the repository
git clone git@github.com:tea-LZL/Convo.git
cd Convo

# Install frontend dependencies
npm install

# Install Rust dependencies (automatic on first build)

# Run in development mode
cargo tauri dev

# Build for release
cargo tauri build
```

## Configuration

Ollama must be running at `http://localhost:11434`. Pull your preferred models:

```bash
ollama pull qwen3.5:27b
ollama pull gemma4:26b
```

Conversation data is stored at `~/.local/share/convo/conversations.json`.

## Screenshots

### Chat View
![Chat View](https://github.com/user-attachments/assets/chat-view.png)

### Settings Panel
![Settings](https://github.com/user-attachments/assets/settings.png)

### Thinking Display
![Thinking](https://github.com/user-attachments/assets/thinking.png)

## License

MIT
