import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined as never);
});

describe("api", () => {
  describe("parameterized command wrappers", () => {
    type Case = {
      name: string;
      method: keyof typeof api;
      args: unknown[];
      expectedCommand: string;
      expectedPayload: Record<string, unknown>;
    };

    const cases: Case[] = [
      {
        name: "getSetting",
        method: "getSetting",
        args: ["theme"],
        expectedCommand: "get_setting",
        expectedPayload: { key: "theme" },
      },
      {
        name: "setSetting",
        method: "setSetting",
        args: ["theme", "dark"],
        expectedCommand: "set_setting",
        expectedPayload: { key: "theme", value: "dark" },
      },
      {
        name: "listSessions defaults",
        method: "listSessions",
        args: [],
        expectedCommand: "list_sessions",
        expectedPayload: { groupId: null, includeArchived: false },
      },
      {
        name: "listSessions with groupId",
        method: "listSessions",
        args: ["group-1", true],
        expectedCommand: "list_sessions",
        expectedPayload: { groupId: "group-1", includeArchived: true },
      },
      {
        name: "createSession with defaults",
        method: "createSession",
        args: [{}],
        expectedCommand: "create_session",
        expectedPayload: {
          title: "New Chat",
          modelId: null,
          providerId: null,
          groupId: null,
        },
      },
      {
        name: "createSession with options",
        method: "createSession",
        args: [{ title: "My Chat", modelId: "m1", providerId: "p1", groupId: "g1" }],
        expectedCommand: "create_session",
        expectedPayload: {
          title: "My Chat",
          modelId: "m1",
          providerId: "p1",
          groupId: "g1",
        },
      },
      {
        name: "appendMessage without optional fields",
        method: "appendMessage",
        args: ["sess-1", "user", "hello"],
        expectedCommand: "append_message",
        expectedPayload: {
          sessionId: "sess-1",
          role: "user",
          content: "hello",
          thinking: null,
          attachmentsJson: null,
        },
      },
      {
        name: "chatStream",
        method: "chatStream",
        args: [
          {
            sessionId: "sess-1",
            model: "llama3",
            messages: [{ role: "user", content: "hi" }],
            system: "sys",
            temperature: 0.7,
          },
        ],
        expectedCommand: "chat_stream_v2",
        expectedPayload: {
          args: {
            sessionId: "sess-1",
            model: "llama3",
            messages: [{ role: "user", content: "hi" }],
            system: "sys",
            temperature: 0.7,
            topP: undefined,
            topK: undefined,
            numCtx: undefined,
            repeatPenalty: undefined,
            stop: undefined,
          },
        },
      },
      {
        name: "upsertMemory coerces is_enabled false to 0",
        method: "upsertMemory",
        args: [{ kind: "user_pref", content: "c", is_enabled: false }],
        expectedCommand: "upsert_memory",
        expectedPayload: {
          item: {
            id: null,
            kind: "user_pref",
            title: null,
            content: "c",
            tags: null,
            isEnabled: 0,
          },
        },
      },
      {
        name: "probeProvider without apiKey",
        method: "probeProvider",
        args: ["openai_compat", "http://localhost"],
        expectedCommand: "probe_provider",
        expectedPayload: { kind: "openai_compat", baseUrl: "http://localhost", apiKey: null },
      },
      {
        name: "runCompare",
        method: "runCompare",
        args: [{ prompt: "p", models: [{ provider_id: "p1", model: "m1" }] }],
        expectedCommand: "run_compare",
        expectedPayload: {
          config: { prompt: "p", models: [{ provider_id: "p1", model: "m1" }] },
        },
      },
    ];

    it.each(cases)("$name invokes $expectedCommand", async (c) => {
      const fn = api[c.method] as (...args: unknown[]) => Promise<unknown>;
      await fn(...c.args);
      expect(mockedInvoke).toHaveBeenCalledTimes(1);
      expect(mockedInvoke).toHaveBeenCalledWith(c.expectedCommand, c.expectedPayload);
    });
  });

  describe("return value passthrough", () => {
    it("returns data from invoke", async () => {
      mockedInvoke.mockResolvedValueOnce([{ id: "s1" }] as never);
      const result = await api.listProviders();
      expect(result).toEqual([{ id: "s1" }]);
    });
  });

  describe("edge cases", () => {
    it("rejects when invoke rejects", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("backend error") as never);
      await expect(api.appInfo()).rejects.toThrow("backend error");
    });

    it("coerces undefined providerId to null for updateSessionModel", async () => {
      await api.updateSessionModel("sess-1", "m1");
      expect(mockedInvoke).toHaveBeenCalledWith("update_session_model", {
        id: "sess-1",
        modelId: "m1",
        providerId: null,
      });
    });

    it("preserves explicit nulls in chatStream optional params", async () => {
      await api.chatStream({
        sessionId: "s",
        model: "m",
        messages: [],
        system: null as unknown as undefined,
        temperature: null as unknown as undefined,
      });
      const payload = mockedInvoke.mock.calls[0][1] as { args: Record<string, unknown> };
      expect(payload.args.system).toBeNull();
      expect(payload.args.temperature).toBeNull();
    });
  });
});
