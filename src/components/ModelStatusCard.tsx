import { useEffect, useState } from "react";
import type { RunningModel } from "../types";
import { getRunningModels } from "../lib/commands";

interface ModelStatusCardProps {
}

export default function ModelStatusCard({}: ModelStatusCardProps) {
  const [runningModels, setRunningModels] = useState<RunningModel[]>([]);

  useEffect(() => {
    const fetch = () => {
      getRunningModels().then(setRunningModels).catch(() => {});
    };
    fetch();
    const interval = setInterval(fetch, 5000);
    return () => clearInterval(interval);
  }, []);

  if (runningModels.length === 0) {
    return (
      <div className="p-3 border-b border-surface-400">
        <div className="px-3 py-2 bg-surface-300/50 rounded-lg text-xs space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-gray-600 shrink-0" />
            <span className="text-gray-500">No model loaded</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 border-b border-surface-400">
      <div className="space-y-2">
        {runningModels.map((model) => {
          const gpuPct = Math.round((model.size_vram / model.size) * 100);
          const cpuPct = 100 - gpuPct;
          const sizeGB = Math.round(model.size / 1024 / 1024 / 1024);

          const expires = new Date(model.expires_at);
          const now = new Date();
          const diffMs = expires.getTime() - now.getTime();
          let expiresText: string;
          if (diffMs <= 0) {
            expiresText = "unloading";
          } else {
            const secs = Math.floor(diffMs / 1000);
            if (secs < 60) expiresText = `${secs} seconds from now`;
            else if (secs < 3600) expiresText = `${Math.floor(secs / 60)} minute${Math.floor(secs / 60) > 1 ? "s" : ""} from now`;
            else expiresText = `${Math.floor(secs / 3600)} hour${Math.floor(secs / 3600) > 1 ? "s" : ""} from now`;
          }

          return (
            <div key={model.digest} className="px-3 py-2 bg-surface-300/50 rounded-lg text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="font-medium text-white truncate">{model.name}</span>
              </div>
              <div className="text-gray-500">{sizeGB} GB</div>
              <div className="text-gray-500">{cpuPct}%/{gpuPct}% CPU/GPU</div>
              <div className="text-gray-500">{model.context_length.toLocaleString()} ctx</div>
              <div className="text-gray-500">{expiresText}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
