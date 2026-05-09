import { useState, useEffect, useCallback, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { listModels, getModelContextLength } from "./lib/commands";
import type { OllamaModel } from "./types";
import { useConversations } from "./hooks/useConversations";
import { useChat } from "./hooks/useChat";
import { useSettings } from "./hooks/useSettings";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import WelcomeScreen from "./components/WelcomeScreen";
import SettingsPanel from "./components/SettingsPanel";
import OllamaSetup from "./components/OllamaSetup";

export default function App() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [contextLength, setContextLength] = useState(8192);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [windowFocused, setWindowFocused] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsOrigin, setSettingsOrigin] = useState({ x: 0, y: 0 });
  const [ollamaSetupOpen, setOllamaSetupOpen] = useState(false);
  const [ollamaSetupOrigin, setOllamaSetupOrigin] = useState({ x: 0, y: 0 });
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const { settings, update: updateSettings } = useSettings();

  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    listModels()
      .then((m) => {
        setModels(m);
        if (m.length > 0 && !selectedModel) {
          setSelectedModel(m[0].name);
          getModelContextLength(m[0].name).then(setContextLength).catch(() => {});
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const unsubPull = listen("pull-done", async () => {
      const m = await listModels().catch(() => []);
      setModels(m);
      if (m.length > 0 && !selectedModel) {
        setSelectedModel(m[0].name);
        getModelContextLength(m[0].name).then(setContextLength).catch(() => {});
      }
    });
    const unsubCreate = listen("create-done", async () => {
      const m = await listModels().catch(() => []);
      setModels(m);
      if (m.length > 0 && !selectedModel) {
        setSelectedModel(m[0].name);
        getModelContextLength(m[0].name).then(setContextLength).catch(() => {});
      }
    });
    const unsubDelete = listen("delete-done", async () => {
      const m = await listModels().catch(() => []);
      setModels(m);
      if (m.length === 0) {
        setSelectedModel("");
      } else if (!selectedModel || !m.some((model) => model.name === selectedModel)) {
        setSelectedModel(m[0].name);
        getModelContextLength(m[0].name).then(setContextLength).catch(() => {});
      }
    });
    return () => {
      unsubPull.then((u) => u());
      unsubCreate.then((u) => u());
      unsubDelete.then((u) => u());
    };
  }, [selectedModel]);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    getModelContextLength(model).then(setContextLength).catch(() => {});
  }, []);

  const {
    conversations,
    refresh: refreshConvs,
    create: createConv,
    remove: removeConv,
    rename: renameConv,
  } = useConversations(selectedModel);

  const {
    messages,
    streaming,
    streamContent,
    streamThinking,
    totalTokens,
    error,
    loadingMessages,
    send,
    stopStreaming,
  } = useChat(activeConversationId, selectedModel, windowFocused, settings.muteSounds, settings.muteNotifications);

  const handleNewConversation = useCallback(async () => {
    const conv = await createConv();
    if (conv) {
      setActiveConversationId(conv.id);
    }
  }, [createConv]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      if (id === activeConversationId) {
        setActiveConversationId(null);
      }
      await removeConv(id);
      await refreshConvs();
    },
    [activeConversationId, removeConv, refreshConvs]
  );

  return (
    <div className="h-full flex bg-surface-100 text-white relative overflow-hidden">
      <div
        className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${
          sidebarOpen ? "w-64" : "w-0"
        }`}
      >
        <div className="w-64 h-full">
          <Sidebar
            conversations={conversations}
            activeId={activeConversationId}
            onSelectConversation={handleSelectConversation}
            onNewConversation={handleNewConversation}
            onRenameConversation={renameConv}
            onDeleteConversation={handleDeleteConversation}
          />
        </div>
      </div>

      {activeConversationId ? (
        <ChatView
          messages={messages}
          streaming={streaming}
          streamContent={streamContent}
          streamThinking={streamThinking}
          totalTokens={totalTokens}
          contextLength={contextLength}
          error={error}
          loadingMessages={loadingMessages}
          models={models}
          selectedModel={selectedModel}
          onSend={send}
          onStop={stopStreaming}
          onModelChange={handleModelChange}
        />
      ) : (
        <WelcomeScreen
          onNewChat={handleNewConversation}
          onSetupOllama={() => {
            setOllamaSetupOrigin({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
            setOllamaSetupOpen(true);
          }}
        />
      )}

      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className={`absolute bottom-4 flex items-center justify-center w-8 h-8 bg-surface-200 border border-surface-400 hover:bg-surface-300 text-gray-400 hover:text-white rounded-lg transition-all duration-300 ease-in-out z-50 ${
          sidebarOpen ? "left-[228px]" : "left-4"
        }`}
      >
        {sidebarOpen ? (
          <PanelLeftClose size={16} />
        ) : (
          <PanelLeftOpen size={16} />
        )}
      </button>

      <button
        ref={settingsBtnRef}
        onClick={() => {
          if (settingsBtnRef.current) {
            const rect = settingsBtnRef.current.getBoundingClientRect();
            setSettingsOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }
          setSettingsOpen(true);
        }}
        className="absolute top-4 right-4 flex items-center justify-center w-8 h-8 bg-surface-200 border border-surface-400 hover:bg-surface-300 text-gray-400 hover:text-white rounded-lg transition-colors z-50"
      >
        <Settings size={16} />
      </button>

      {settingsOpen && (
        <SettingsPanel
          muteSounds={settings.muteSounds}
          muteNotifications={settings.muteNotifications}
          onUpdate={updateSettings}
          onClose={() => setSettingsOpen(false)}
          originX={settingsOrigin.x}
          originY={settingsOrigin.y}
          onOpenSetup={() => {
            setSettingsOpen(false);
            if (settingsBtnRef.current) {
              const rect = settingsBtnRef.current.getBoundingClientRect();
              setOllamaSetupOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }
            setOllamaSetupOpen(true);
          }}
        />
      )}

      {ollamaSetupOpen && (
        <OllamaSetup
          onClose={() => setOllamaSetupOpen(false)}
          originX={ollamaSetupOrigin.x}
          originY={ollamaSetupOrigin.y}
        />
      )}
    </div>
  );
}
