import { Sparkles } from "lucide-react";

interface WelcomeScreenProps {
  onNewChat: () => void;
}

export default function WelcomeScreen({ onNewChat }: WelcomeScreenProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-purple-400 flex items-center justify-center mb-6 shadow-lg shadow-accent/20">
        <Sparkles size={32} className="text-white" />
      </div>
      <h1 className="text-2xl font-semibold text-white mb-2">Convo</h1>
      <p className="text-gray-500 text-sm mb-8 text-center max-w-md">
        Your local AI assistant powered by Ollama.
        <br />
        Chat privately with your own models on your machine.
      </p>
      <button
        onClick={onNewChat}
        className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white rounded-xl px-6 py-3 text-sm font-medium transition-all hover:scale-105 active:scale-95"
      >
        <Sparkles size={18} />
        Start a conversation
      </button>
    </div>
  );
}
