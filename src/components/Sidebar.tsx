import { Plus, MessageSquare } from "lucide-react";
import type { Conversation } from "../types";
import ConversationItem from "./ConversationItem";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
}

export default function Sidebar({
  conversations,
  activeId,
  onSelectConversation,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
}: SidebarProps) {
  return (
    <div className="w-64 h-full bg-surface-200 border-r border-surface-400 flex flex-col shrink-0 relative">
      <div className="p-3 border-b border-surface-400">
        <button
          onClick={onNewConversation}
          className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover text-white rounded-lg py-2 px-3 text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1 space-y-0.5">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 px-3 text-center">
            <MessageSquare size={32} className="text-surface-600 mb-3" />
            <p className="text-gray-500 text-xs">
              No conversations yet.
              <br />
              Start a new chat to begin.
            </p>
          </div>
        ) : (
          conversations.map((conv) => (
            <ConversationItem
              key={conv.id}
              conversation={conv}
              active={conv.id === activeId}
              onSelect={() => onSelectConversation(conv.id)}
              onRename={(title) => onRenameConversation(conv.id, title)}
              onDelete={() => onDeleteConversation(conv.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
