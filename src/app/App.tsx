/**
 * App shell — sidebar + routed content + toasts + command palette.
 */
import { useEffect, useState } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "../components/sidebar/Sidebar";
import { CommandPalette } from "../components/CommandPalette";
import { SessionSearch } from "../components/SessionSearch";
import { ToastViewport } from "../stores/toasts";
import { useGlobalKeyHandler } from "../hooks/useGlobalKeyHandler";
import { useThemeStore } from "../stores/theme";
import { useShortcutsStore } from "../stores/shortcuts";
import { usePaletteStore } from "../stores/palette";
import { useMemoryStore } from "../stores/memory";
import { ChatRoute } from "../routes/ChatRoute";
import { CompareRoute } from "../routes/CompareRoute";
import { DocumentsRoute } from "../routes/DocumentsRoute";
import { NotesRoute } from "../routes/NotesRoute";
import { TasksRoute } from "../routes/TasksRoute";
import { MemoryRoute } from "../routes/MemoryRoute";
import { SettingsRoute } from "../routes/SettingsRoute";
import { AboutRoute } from "../routes/AboutRoute";
import { TourOverlay } from "../components/tour/TourOverlay";
import { useTourStore } from "../stores/tour";
import { api } from "../lib/api";
import { listen } from "@tauri-apps/api/event";

export default function App() {
  const initTheme = useThemeStore((s) => s.init);
  const register = useShortcutsStore((s) => s.register);
  const registerMany = useShortcutsStore((s) => s.registerMany);
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const togglePalette = usePaletteStore((s) => s.toggle);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const tourInit = useTourStore((s) => s.init);

  useGlobalKeyHandler();

  useEffect(() => {
    initTheme();
    tourInit();
    useMemoryStore.getState().refresh();
  }, [initTheme, tourInit]);

  useEffect(() => {
    registerMany([
      { id: "palette", combo: "ctrl+k", action: () => togglePalette(), description: "Open command palette" },
      { id: "new-chat", combo: "ctrl+n", action: () => window.dispatchEvent(new CustomEvent("convo:new-chat")), description: "New chat" },
      { id: "toggle-sidebar", combo: "ctrl+b", action: () => setSidebarCollapsed((c) => !c), description: "Toggle sidebar" },
      { id: "search-sessions", combo: "ctrl+shift+f", action: () => window.dispatchEvent(new CustomEvent("convo:search-sessions")), description: "Search sessions" },
      { id: "settings", combo: "ctrl+,", action: () => window.location.assign("/settings"), description: "Settings" },
      { id: "focus-input", combo: "ctrl+/", action: () => window.dispatchEvent(new CustomEvent("convo:focus-input")), description: "Focus input" },
    ]);
  }, [register, registerMany, togglePalette]);

  // Listen for global events from settings panel (theme + density)
  useEffect(() => {
    const onTheme = () => initTheme();
    window.addEventListener("convo:theme-changed", onTheme);
    return () => window.removeEventListener("convo:theme-changed", onTheme);
  }, [initTheme]);

  // Wire up Tauri app focus events for notifications later
  useEffect(() => {
    const setup = async () => {
      await listen("chat-done", () => {
        // The new chat-done event shape: { conversation_id, prompt_tokens, output_tokens, completed_at }
        // The chat route handles its own; this is a no-op for now.
      });
    };
    setup().catch(console.error);
  }, []);

  return (
    <HashRouter>
      <div className="h-full flex bg-bg text-text relative overflow-hidden">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((c) => !c)} />
        <main className="flex-1 min-w-0 h-full flex flex-col relative">
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<ChatRoute />} />
            <Route path="/chat/:sessionId" element={<ChatRoute />} />
            <Route path="/compare" element={<CompareRoute />} />
            <Route path="/documents" element={<DocumentsRoute />} />
            <Route path="/notes" element={<NotesRoute />} />
            <Route path="/tasks" element={<TasksRoute />} />
            <Route path="/memory" element={<MemoryRoute />} />
            <Route path="/settings/*" element={<SettingsRoute />} />
            <Route path="/about" element={<AboutRoute />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </main>
        <CommandPalette />
        <SessionSearch />
        <ToastViewport />
        <TourOverlay />
      </div>
    </HashRouter>
  );
}
