import { ChatMessage } from "../../lib/api";

export interface ChatContextMenuState {
  x: number;
  y: number;
  content: string;
  role: "user" | "assistant";
  msgIndex: number | null;
  isThinking: boolean;
}

export interface MessageRowProps {
  msg: ChatMessage;
  i: number;
  sessionId: string;
  editingMessageId: string | null;
  setEditingMessageId: (id: string | null) => void;
  collapsedThinking: Set<number>;
  setCollapsedThinking: (updater: (s: Set<number>) => Set<number>) => void;
  setContextMenu: (m: ChatContextMenuState | null) => void;
  onResend: (msgIndex: number, content: string) => Promise<void>;
}

export interface MessageListProps {
  sessionId: string;
  editingMessageId: string | null;
  setEditingMessageId: (id: string | null) => void;
  collapsedThinking: Set<number>;
  setCollapsedThinking: (updater: (s: Set<number>) => Set<number>) => void;
  setContextMenu: (m: ChatContextMenuState | null) => void;
  onBumpScroll: () => void;
  onResend: (msgIndex: number, content: string) => Promise<void>;
}

export interface StreamingSectionProps {
  sessionId: string;
  stickToBottomRef: React.MutableRefObject<boolean>;
  onBumpScroll: () => void;
}

export interface AttachmentData {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
}