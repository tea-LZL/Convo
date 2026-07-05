import { describe, expect, it } from "vitest";
import { getLastUsedChatModel, getLastUsedModelForProvider, setLastUsedChatModel } from "../lastUsedChatModel";

describe("lastUsedChatModel", () => {
  it("persists and returns the last used provider/model pair", () => {
    setLastUsedChatModel("ollama", "llama3.1:8b");

    expect(getLastUsedChatModel()).toEqual({
      providerId: "ollama",
      modelId: "llama3.1:8b",
    });
    expect(getLastUsedModelForProvider("ollama")).toBe("llama3.1:8b");
  });

  it("returns null for a different provider", () => {
    setLastUsedChatModel("ollama", "llama3.1:8b");

    expect(getLastUsedModelForProvider("openrouter")).toBeNull();
  });

  it("ignores malformed stored values", () => {
    localStorage.setItem("convo:last-used-chat-model", JSON.stringify({ providerId: "ollama" }));

    expect(getLastUsedChatModel()).toBeNull();
  });

  it("does not persist empty ids", () => {
    setLastUsedChatModel("", "llama3.1:8b");

    expect(getLastUsedChatModel()).toBeNull();
  });
});
