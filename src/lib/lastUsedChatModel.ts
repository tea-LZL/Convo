const STORAGE_KEY = "convo:last-used-chat-model";

export interface LastUsedChatModel {
  providerId: string;
  modelId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getLastUsedChatModel(): LastUsedChatModel | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const providerId = parsed.providerId;
    const modelId = parsed.modelId;
    if (typeof providerId !== "string" || !providerId.trim()) return null;
    if (typeof modelId !== "string" || !modelId.trim()) return null;
    return { providerId, modelId };
  } catch {
    return null;
  }
}

export function setLastUsedChatModel(providerId: string, modelId: string): void {
  const trimmedProviderId = providerId.trim();
  const trimmedModelId = modelId.trim();
  if (!trimmedProviderId || !trimmedModelId) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ providerId: trimmedProviderId, modelId: trimmedModelId })
    );
  } catch {
    // localStorage can fail in private modes or test environments.
  }
}

export function getLastUsedModelForProvider(providerId: string): string | null {
  const last = getLastUsedChatModel();
  if (!last || last.providerId !== providerId) return null;
  return last.modelId;
}
