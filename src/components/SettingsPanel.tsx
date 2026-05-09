import { useState, useEffect, useCallback } from "react";
import { X, Volume2, VolumeX, Bell, BellOff, Cpu } from "lucide-react";

interface SettingsPanelProps {
  muteSounds: boolean;
  muteNotifications: boolean;
  onUpdate: (key: "muteSounds" | "muteNotifications", value: boolean) => void;
  onClose: () => void;
  originX: number;
  originY: number;
  onOpenSetup: () => void;
}

export default function SettingsPanel({
  muteSounds,
  muteNotifications,
  onUpdate,
  onClose,
  originX,
  originY,
  onOpenSetup,
}: SettingsPanelProps) {
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 400);
  }, [onClose]);

  const circle = closing
    ? `circle(0% at ${originX}px ${originY}px)`
    : `circle(150% at ${originX}px ${originY}px)`;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-surface-200/95 backdrop-blur-xl"
        style={{
          clipPath: circle,
          transition: "clip-path 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      />
      <div
        className="relative w-full max-w-md mx-auto transition-opacity duration-300"
        style={{ opacity: visible && !closing ? 1 : 0 }}
      >
        <div className="flex items-center justify-between mb-8 px-6">
          <h2 className="text-lg font-medium text-white">Settings</h2>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg hover:bg-surface-300 text-gray-400 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-1 px-6">
          <button
            onClick={onOpenSetup}
            className="w-full flex items-center gap-3 py-3 hover:bg-surface-300/30 -mx-2 px-2 rounded-lg transition-colors text-left"
          >
            <Cpu size={18} className="text-gray-400" />
            <div>
              <p className="text-sm text-white">Ollama Setup</p>
              <p className="text-xs text-gray-500">Install and manage models</p>
            </div>
          </button>

          <div className="flex items-center justify-between py-3 border-b border-surface-400/30">
            <div className="flex items-center gap-3">
              {muteSounds ? (
                <VolumeX size={18} className="text-gray-500" />
              ) : (
                <Volume2 size={18} className="text-gray-400" />
              )}
              <div>
                <p className="text-sm text-white">Sound effects</p>
                <p className="text-xs text-gray-500">Send and response sounds</p>
              </div>
            </div>
            <button
              onClick={() => onUpdate("muteSounds", !muteSounds)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                muteSounds ? "bg-surface-400" : "bg-blue-500/60"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  muteSounds ? "" : "translate-x-5"
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-3">
              {muteNotifications ? (
                <BellOff size={18} className="text-gray-500" />
              ) : (
                <Bell size={18} className="text-gray-400" />
              )}
              <div>
                <p className="text-sm text-white">Desktop notifications</p>
                <p className="text-xs text-gray-500">When window is not focused</p>
              </div>
            </div>
            <button
              onClick={() => onUpdate("muteNotifications", !muteNotifications)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                muteNotifications ? "bg-surface-400" : "bg-blue-500/60"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  muteNotifications ? "" : "translate-x-5"
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
