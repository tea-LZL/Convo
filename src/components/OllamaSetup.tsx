import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  Download,
  Trash2,
  Search,
  Copy,
  Check,
  RefreshCw,
  Terminal,
  Package,
  AlertCircle,
  Plus,
  ChevronDown,
  Wand2,
  Apple,
} from "lucide-react";
import { useOllamaSetup } from "../hooks/useOllamaSetup";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function getInstallInstructions(os: string): { title: string; steps: { label: string; command?: string }[] }[] {
  if (os.includes("Mac")) {
    return [
      {
        title: "Homebrew",
        steps: [
          { label: "Install via Homebrew", command: "brew install ollama" },
        ],
      },
      {
        title: "Direct Download",
        steps: [
          { label: "Download from ollama.com", command: "curl -fsSL https://ollama.com/install.sh | sh" },
        ],
      },
    ];
  }
  if (os.includes("Win")) {
    return [
      {
        title: "Windows Installer",
        steps: [
          { label: "Download the installer from", command: "https://ollama.com/download/windows" },
          { label: "Run the installer and follow prompts" },
        ],
      },
    ];
  }
  return [
    {
      title: "Linux (curl)",
      steps: [
        { label: "Install via curl", command: "curl -fsSL https://ollama.com/install.sh | sh" },
      ],
    },
    {
      title: "Snap",
      steps: [
        { label: "Install via Snap", command: "sudo snap install ollama" },
      ],
    },
  ];
}

interface OllamaSetupProps {
  onClose: () => void;
  originX: number;
  originY: number;
}

export default function OllamaSetup({ onClose, originX, originY }: OllamaSetupProps) {
  const {
    status,
    installedModels,
    libraryModels,
    pullingModel,
    pullProgress,
    creatingModel,
    createStatus,
    error,
    refreshStatus,
    setSearch,
    handlePull,
    handleCreate,
    handleDelete,
  } = useOllamaSetup();

  const [searchInput, setSearchInput] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [os, setOs] = useState("Linux");
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBaseModel, setCreateBaseModel] = useState("");
  const [createNumCtx, setCreateNumCtx] = useState("8192");
  const [createBaseOpen, setCreateBaseOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error && scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [error]);

  useEffect(() => {
    const ua = navigator.userAgent;
    if (ua.includes("Mac")) setOs("Mac");
    else if (ua.includes("Win")) setOs("Win");
    else setOs("Linux");
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 400);
  }, [onClose]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchInput(value);
      setSearch(value);
    },
    [setSearch]
  );

  const handleCopy = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const handleDeleteClick = useCallback((name: string) => {
    setDeleteConfirm(name);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (deleteConfirm) {
      handleDelete(deleteConfirm);
      setDeleteConfirm(null);
    }
  }, [deleteConfirm, handleDelete]);

  const handleCreateSubmit = useCallback(() => {
    if (!createName.trim() || !createBaseModel || !createNumCtx) return;
    handleCreate(createName.trim(), createBaseModel, parseInt(createNumCtx, 10));
    setCreateName("");
    setCreateBaseModel("");
    setCreateNumCtx("8192");
    setShowCreateForm(false);
  }, [createName, createBaseModel, createNumCtx, handleCreate]);

  const contextPresets = [4096, 8192, 16384, 32768, 65536, 131072];

  const circle = closing
    ? `circle(0% at ${originX}px ${originY}px)`
    : `circle(150% at ${originX}px ${originY}px)`;

  const installSteps = getInstallInstructions(os);

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
        className="relative w-full h-full max-w-4xl mx-auto flex flex-col transition-opacity duration-300"
        style={{ opacity: visible && !closing ? 1 : 0 }}
      >
        <div className="flex items-center justify-between px-6 py-4 shrink-0">
          <h2 className="text-lg font-medium text-white">Ollama Setup</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={refreshStatus}
              className="p-1.5 rounded-lg hover:bg-surface-300 text-gray-400 hover:text-white transition-colors"
              title="Refresh"
            >
              <RefreshCw size={18} />
            </button>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-lg hover:bg-surface-300 text-gray-400 hover:text-white transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-6">
          {error && (
            <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
              <AlertCircle size={16} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              Connection Status
            </h3>
            {!status ? (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <RefreshCw size={16} className="animate-spin" />
                Checking...
              </div>
            ) : status.running ? (
              <div className="flex items-center gap-3 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-sm text-green-400">
                  Ollama {status.version} is running
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                <div className="w-2 h-2 rounded-full bg-red-400" />
                <span className="text-sm text-red-400">
                  Ollama is not running
                </span>
              </div>
            )}
          </div>

          {(!status || !status.running) && (
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
                Install Ollama
              </h3>
              <div className="space-y-4">
                {installSteps.map((section) => (
                  <div key={section.title}>
                    <p className="text-sm text-white mb-2">{section.title}</p>
                    <div className="space-y-2">
                      {section.steps.map((step, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Terminal size={14} className="text-gray-500 shrink-0" />
                          {step.command ? (
                            <div className="flex items-center gap-2 flex-1 bg-surface-300/50 rounded-lg px-3 py-2">
                              <code className="text-sm text-gray-300 flex-1 font-mono">
                                {step.command}
                              </code>
                              <button
                                onClick={() => handleCopy(step.command!, `${section.title}-${i}`)}
                                className="shrink-0 p-1 rounded hover:bg-surface-400 text-gray-500 hover:text-white transition-colors"
                              >
                                {copied === `${section.title}-${i}` ? (
                                  <Check size={14} className="text-green-400" />
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>
                            </div>
                          ) : (
                            <span className="text-sm text-gray-400">
                              {step.label}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {status?.running && (
            <>
              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
                  Installed Models
                </h3>
                {installedModels.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    No models installed yet
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3">
                    {installedModels.map((model) => (
                      <div
                        key={model.name}
                        className="flex items-center justify-between p-4 bg-surface-300/30 border border-surface-400/20 rounded-xl"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Package size={16} className="text-gray-500 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate">
                              {model.name}
                            </p>
                            <p className="text-xs text-gray-500">
                              {formatBytes(model.size)}
                            </p>
                          </div>
                        </div>
                        <div className="ml-4 shrink-0">
                          {deleteConfirm === model.name ? (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-400">Delete?</span>
                              <button
                                onClick={handleDeleteConfirm}
                                className="px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded text-xs transition-colors"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-2 py-1 bg-surface-400/30 hover:bg-surface-400/50 text-gray-400 rounded text-xs transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleDeleteClick(model.name)}
                              className="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
                              title="Delete model"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
                  Create Custom Model
                </h3>
                {!showCreateForm ? (
                  <button
                    onClick={() => setShowCreateForm(true)}
                    className="w-full flex items-center justify-center gap-2 p-4 bg-surface-300/30 border border-dashed border-surface-400/30 rounded-xl hover:bg-surface-300/50 hover:border-accent/30 text-gray-400 hover:text-white transition-colors"
                  >
                    <Plus size={16} />
                    <span className="text-sm">Create model with custom context size</span>
                  </button>
                ) : (
                  <div className="p-4 bg-surface-300/30 border border-surface-400/20 rounded-xl space-y-4">
                    <div className="flex items-start gap-2 mb-2">
                      <Wand2 size={16} className="text-accent mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm text-white font-medium">Custom Context Model</p>
                        <p className="text-xs text-gray-500">Creates a derived model from an installed base model with a custom token context window.</p>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Model name</label>
                      <input
                        type="text"
                        value={createName}
                        onChange={(e) => setCreateName(e.target.value)}
                        placeholder="e.g. mymodel-32k"
                        className="w-full bg-surface-400/30 border border-surface-400/30 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent/50 transition-colors"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Base model</label>
                      <div className="relative">
                        <button
                          onClick={() => setCreateBaseOpen(!createBaseOpen)}
                          className="w-full flex items-center justify-between bg-surface-400/30 border border-surface-400/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/50 transition-colors"
                        >
                          <span className={createBaseModel ? "text-white" : "text-gray-500"}>
                            {createBaseModel || "Select an installed model"}
                          </span>
                          <ChevronDown size={14} className="text-gray-500" />
                        </button>
                        {createBaseOpen && (
                          <div className="absolute z-10 mt-1 w-full bg-surface-100 border border-surface-400/30 rounded-lg shadow-xl max-h-48 overflow-y-auto">
                            {installedModels.map((m) => (
                              <button
                                key={m.name}
                                onClick={() => {
                                  setCreateBaseModel(m.name);
                                  setCreateBaseOpen(false);
                                }}
                                className="w-full text-left px-3 py-2 text-sm text-white hover:bg-surface-300/50 transition-colors"
                              >
                                {m.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Context size (tokens)</label>
                      <input
                        type="number"
                        value={createNumCtx}
                        onChange={(e) => setCreateNumCtx(e.target.value)}
                        min={1024}
                        step={1024}
                        className="w-full bg-surface-400/30 border border-surface-400/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent/50 transition-colors"
                      />
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {contextPresets.map((size) => (
                          <button
                            key={size}
                            onClick={() => setCreateNumCtx(String(size))}
                            className={`px-2 py-1 rounded text-xs font-mono transition-colors ${
                              createNumCtx === String(size)
                                ? "bg-accent/30 text-accent border border-accent/30"
                                : "bg-surface-400/20 text-gray-400 border border-surface-400/20 hover:text-white hover:border-surface-400/40"
                            }`}
                          >
                            {size >= 1024 ? `${size / 1024}K` : size}
                          </button>
                        ))}
                      </div>
                    </div>

                    {creatingModel && (
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <RefreshCw size={12} className="animate-spin" />
                        <span>{createStatus || "Creating model..."}</span>
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={handleCreateSubmit}
                        disabled={!createName.trim() || !createBaseModel || !!creatingModel}
                        className="flex items-center gap-1.5 px-4 py-2 bg-accent/20 hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed text-accent rounded-lg text-sm font-medium transition-colors"
                      >
                        <Wand2 size={14} />
                        Create
                      </button>
                      <button
                        onClick={() => {
                          setShowCreateForm(false);
                          setCreateName("");
                          setCreateBaseModel("");
                          setCreateNumCtx("8192");
                        }}
                        className="px-4 py-2 bg-surface-400/20 hover:bg-surface-400/30 text-gray-400 hover:text-white rounded-lg text-sm transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
                  Download Models
                </h3>
                <div className="relative mb-4">
                  <Search
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => handleSearch(e.target.value)}
                    placeholder="Search models (e.g. qwen3.6, gemma4, deepseek-r1)"
                    className="w-full bg-surface-300/50 border border-surface-400/30 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent/50 transition-colors"
                  />
                </div>

                {libraryModels.length > 0 && (
                  <div className="grid grid-cols-1 gap-3">
                    {libraryModels.map((model) => {
                      const isInstalled = installedModels.some(
                        (m) => m.name === model.name || m.name.startsWith(model.name + ":")
                      );
                      const isPulling = pullingModel === model.name;

                      return (
                        <div
                          key={model.name}
                          className="group relative flex items-center justify-between p-4 bg-surface-300/30 border border-surface-400/20 rounded-xl hover:bg-surface-300/50 transition-colors cursor-help"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-white truncate">
                                {model.name}
                              </p>
                              {model.macos_only && (
                                <span className="shrink-0 flex items-center gap-0.5 text-[10px] text-gray-400 bg-surface-400/20 px-1.5 py-0.5 rounded" title="Requires macOS with Apple Silicon">
                                  <Apple size={9} />
                                  macOS
                                </span>
                              )}
                              <span className="shrink-0 text-[10px] font-mono text-gray-500 bg-surface-400/30 px-1.5 py-0.5 rounded">
                                {model.size}
                              </span>
                            </div>
                          </div>
                          <div className="ml-4 shrink-0">
                            {isPulling ? (
                              pullProgress ? (
                                <div className="w-40">
                                  <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                                    <span>{pullProgress.status}</span>
                                    <span>{pullProgress.percent.toFixed(0)}%</span>
                                  </div>
                                  <div className="h-1.5 bg-surface-400 rounded-full overflow-hidden">
                                    <div
                                      className="h-full bg-accent rounded-full transition-all duration-300"
                                      style={{ width: `${Math.min(pullProgress.percent, 100)}%` }}
                                    />
                                  </div>
                                  {pullProgress.total > 0 && (
                                    <p className="text-[10px] text-gray-500 mt-1">
                                      {formatBytes(pullProgress.completed)} /{" "}
                                      {formatBytes(pullProgress.total)}
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <div className="w-24 flex items-center gap-2">
                                  <RefreshCw size={12} className="animate-spin text-accent" />
                                  <span className="text-xs text-accent">Starting...</span>
                                </div>
                              )
                            ) : isInstalled ? (
                              <span className="text-xs text-green-400 flex items-center gap-1">
                                <Check size={12} />
                                Installed
                              </span>
                            ) : (
                              <button
                                onClick={() => handlePull(model.name)}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/20 hover:bg-accent/30 text-accent rounded-lg text-xs font-medium transition-colors"
                              >
                                <Download size={12} />
                                Pull
                              </button>
                            )}
                          </div>
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 pointer-events-none">
                            <div className="bg-surface-100 border border-surface-400/30 rounded-lg px-3 py-2 shadow-xl max-w-xs">
                              <p className="text-xs text-gray-300 leading-relaxed">
                                {model.description}
                              </p>
                              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
                                <div className="w-2 h-2 bg-surface-100 border-r border-b border-surface-400/30 rotate-45 -translate-y-1/2"></div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {libraryModels.length === 0 && (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    No models found for "{searchInput}"
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
