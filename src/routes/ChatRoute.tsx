/**
 * Chat route — main view.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus, Sparkles, Cpu, Search, BookOpen, Settings, KeyRound, FileText, ListTodo, StickyNote, Brain } from "lucide-react";
import { ChatViewNew } from "../components/chat/ChatViewNew";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { ChatSkeleton } from "../components/ui/Skeleton";
import { useSessionsStore } from "../stores/sessions";
import { api } from "../lib/api";
import { errorClass, recordLog } from "../lib/logger";

export function ChatRoute() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const setActive = useSessionsStore((s) => s.setActive);
  const activeId = useSessionsStore((s) => s.activeId);
  const refresh = useSessionsStore((s) => s.refresh);
  const [loading, setLoading] = useState(true);
  const [hasProviders, setHasProviders] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      await refresh();
      if (sessionId && sessionId !== activeId) {
        setActive(sessionId);
      }
      try {
        const ps = await api.listProviders();
        setHasProviders(ps.length > 0);
      } catch (error) {
        recordLog({ operation: "list_providers", status: "failed", route: "/chat", errorClass: errorClass(error) });
        setHasProviders(true); // optimistic
      }
      setLoading(false);
    })();
  }, [sessionId, activeId, setActive, refresh]);

  // Sync URL to activeId
  useEffect(() => {
    if (activeId && !sessionId) {
      navigate(`/chat/${activeId}`, { replace: true });
    } else if (!activeId && sessionId) {
      navigate("/chat", { replace: true });
    }
  }, [activeId, sessionId, navigate]);

  // Listen for "Insert into chat" from other routes (e.g. Documents)
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text: string; title?: string };
      const input = document.querySelector<HTMLTextAreaElement>("[data-chat-input]");
      if (!input) return;
      const tag = detail.title ? `[From ${detail.title}]\n` : "";
      const text = `${tag}\n\`\`\`\n${detail.text}\n\`\`\`\n\n`;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    };
    window.addEventListener("convo:insert-into-chat", onInsert);
    return () => window.removeEventListener("convo:insert-into-chat", onInsert);
  }, []);

  // Poll for provider changes (e.g. after Settings → Providers add)
  useEffect(() => {
    const onFocus = () => {
      api.listProviders().then((ps) => setHasProviders(ps.length > 0)).catch((error) => {
        recordLog({ operation: "refresh_chat_providers", status: "failed", route: "/chat", errorClass: errorClass(error) });
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (loading) {
    return <ChatSkeleton />;
  }

  if (!activeId) {
    return <EmptyChat hasProviders={hasProviders} />;
  }

  return (
    <ErrorBoundary label="Chat">
      <ChatViewNew key={activeId} sessionId={activeId} />
    </ErrorBoundary>
  );
}

function EmptyChat({ hasProviders }: { hasProviders: boolean | null }) {
  const create = useSessionsStore((s) => s.create);
  const navigate = useNavigate();
  const handleNew = async () => {
    const s = await create();
    navigate(`/chat/${s.id}`);
  };

  if (hasProviders === false) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 max-w-2xl mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-accent flex items-center justify-center mb-6">
          <span className="text-3xl">✦</span>
        </div>
        <h1 className="text-2xl font-semibold text-text mb-2">Welcome to Convo</h1>
        <p className="text-text-muted text-sm mb-8 text-center max-w-md">
          Your local AI workspace. Connect a model backend to get started.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl mb-8">
          <button
            onClick={() => navigate("/settings/providers")}
            className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/50 rounded-lg p-4 text-left transition-colors"
          >
            <KeyRound size={18} className="text-accent mb-2" />
            <div className="text-sm font-medium text-text">Add Ollama</div>
            <div className="text-xs text-text-muted mt-0.5">Local-first. Run models on your machine.</div>
          </button>
          <button
            onClick={() => navigate("/settings/providers")}
            className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/50 rounded-lg p-4 text-left transition-colors"
          >
            <Settings size={18} className="text-accent mb-2" />
            <div className="text-sm font-medium text-text">Add OpenAI-compatible</div>
            <div className="text-xs text-text-muted mt-0.5">OpenRouter, vLLM, llama.cpp, etc.</div>
          </button>
          <button
            onClick={() => navigate("/hardware")}
            className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/50 rounded-lg p-4 text-left transition-colors"
          >
            <Cpu size={18} className="text-accent mb-2" />
            <div className="text-sm font-medium text-text">Hardware scan</div>
            <div className="text-xs text-text-muted mt-0.5">See which models fit your machine.</div>
          </button>
          <button
            onClick={() => navigate("/about")}
            className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/50 rounded-lg p-4 text-left transition-colors"
          >
            <BookOpen size={18} className="text-accent mb-2" />
            <div className="text-sm font-medium text-text">About Convo</div>
            <div className="text-xs text-text-muted mt-0.5">Local-first, private, no telemetry.</div>
          </button>
        </div>
      </div>
    );
  }

  const starters = [
    "Explain how Rust's borrow checker works, with examples.",
    "Write a Python function to merge two sorted lists without built-in sort.",
    "Brainstorm 5 unique names for a local-first AI workspace.",
    "Help me debug a Tauri command that's returning the wrong type.",
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8">
      <div className="w-16 h-16 rounded-2xl bg-accent flex items-center justify-center mb-6">
        <span className="text-3xl">✦</span>
      </div>
      <h1 className="text-2xl font-semibold text-text mb-2">Convo</h1>
      <p className="text-text-muted text-sm mb-8 text-center max-w-md">
        Your local AI workspace. Start a new conversation to begin.
      </p>
      <button
        onClick={handleNew}
        className="inline-flex items-center gap-2 bg-accent hover:bg-accent-hover text-white rounded-lg px-6 py-3 text-sm font-medium transition-colors mb-8"
      >
        <Plus size={16} />
        New conversation
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-2xl">
        {starters.map((s, i) => (
          <button
            key={i}
            onClick={async () => {
              const sess = await create();
              navigate(`/chat/${sess.id}`);
              // Pre-fill input with the starter
              setTimeout(() => {
                const input = document.querySelector<HTMLTextAreaElement>("[data-chat-input]");
                if (input) {
                  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
                  setter.call(input, s);
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  input.focus();
                }
              }, 200);
            }}
            className="bg-surface-1 hover:bg-surface-2 border border-border hover:border-accent/50 rounded-lg p-3 text-left text-xs text-text-muted hover:text-text transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
