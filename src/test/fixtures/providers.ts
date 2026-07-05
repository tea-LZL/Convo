import { Provider, ProviderStatus, Model, ProbeResult, DiscoveredServer } from "../../lib/api";

export const ollamaProvider: Provider = {
  id: "provider-ollama",
  kind: "ollama",
  name: "Local Ollama",
  base_url: "http://localhost:11434",
  has_api_key: false,
  api_key: null,
  is_default: true,
  created_at: "2024-01-01T00:00:00Z",
};

export const openaiProvider: Provider = {
  id: "provider-openai",
  kind: "openai_compat",
  name: "OpenRouter",
  base_url: "https://openrouter.ai/api/v1",
  has_api_key: true,
  api_key: "sk-test",
  is_default: false,
  created_at: "2024-01-02T00:00:00Z",
};

export const providerList = [ollamaProvider, openaiProvider];

export const providerStatusList: ProviderStatus[] = [
  {
    id: "provider-ollama",
    name: "Local Ollama",
    kind: "ollama",
    is_default: true,
    has_api_key: false,
    model_count: 3,
    last_seen: "2024-01-01T00:00:00Z",
    reachable: true,
    reachable_msg: null,
  },
  {
    id: "provider-openai",
    name: "OpenRouter",
    kind: "openai_compat",
    is_default: false,
    has_api_key: true,
    model_count: 0,
    last_seen: null,
    reachable: false,
    reachable_msg: "Unauthorized",
  },
];

export const modelFixtures: Model[] = [
  {
    id: "model-llama3",
    provider_id: "provider-ollama",
    name: "llama3:8b",
    family: "llama",
    parameter_size: "8B",
    quantization: "Q4_0",
    context_length: 8192,
    size_bytes: 4_900_000_000,
    supports_thinking: false,
    supports_vision: false,
    last_seen: "2024-01-01T00:00:00Z",
  },
  {
    id: "model-qwen-vl",
    provider_id: "provider-ollama",
    name: "qwen2-vl",
    family: "qwen2",
    parameter_size: "7B",
    quantization: "Q4_K_M",
    context_length: 32768,
    size_bytes: 4_500_000_000,
    supports_thinking: true,
    supports_vision: true,
    last_seen: "2024-01-01T00:00:00Z",
  },
];

export const probeSuccess: ProbeResult = {
  ok: true,
  message: "Found 2 models",
  models: [
    { id: "gpt-4o", name: "GPT-4o", context_length: 128000 },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", context_length: 128000 },
  ],
};

export const probeFailure: ProbeResult = {
  ok: false,
  message: "Connection refused",
  models: [],
};

export const discoveredServers: DiscoveredServer[] = [
  {
    base_url: "http://localhost:11434",
    kind: "ollama",
    models: [{ id: "llama3", name: "Llama 3", context_length: 8192 }],
  },
];
