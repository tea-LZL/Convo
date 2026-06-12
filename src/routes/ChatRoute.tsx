/**
 * Chat route — main view.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChatViewNew } from "../components/chat/ChatViewNew";
import { useSessionsStore } from "../stores/sessions";

export function ChatRoute() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const setActive = useSessionsStore((s) => s.setActive);
  const activeId = useSessionsStore((s) => s.activeId);
  const refresh = useSessionsStore((s) => s.refresh);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      await refresh();
      if (sessionId && sessionId !== activeId) {
        setActive(sessionId);
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

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-subtle">
        <div className="flex gap-1.5">
          <span className="w-2 h-2 bg-text-subtle rounded-full animate-pulse-dot" />
          <span className="w-2 h-2 bg-text-subtle rounded-full animate-pulse-dot" style={{ animationDelay: "0.2s" }} />
          <span className="w-2 h-2 bg-text-subtle rounded-full animate-pulse-dot" style={{ animationDelay: "0.4s" }} />
        </div>
      </div>
    );
  }

  if (!activeId) {
    return <EmptyChat />;
  }

  return <ChatViewNew key={activeId} sessionId={activeId} />;
}

function EmptyChat() {
  const create = useSessionsStore((s) => s.create);
  const navigate = useNavigate();
  const handleNew = async () => {
    const s = await create();
    navigate(`/chat/${s.id}`);
  };
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-accent-muted flex items-center justify-center mb-6 shadow-modal">
        <span className="text-3xl">✦</span>
      </div>
      <h1 className="text-2xl font-semibold text-text mb-2">Convo</h1>
      <p className="text-text-muted text-sm mb-8 text-center max-w-md">
        Your local AI workspace. Start a new conversation to begin.
      </p>
      <button
        onClick={handleNew}
        className="inline-flex items-center gap-2 bg-accent hover:bg-accent-hover text-white rounded-xl px-6 py-3 text-sm font-medium transition-all hover:scale-105 active:scale-95"
      >
        <span>＋</span>
        New conversation
      </button>
    </div>
  );
}
