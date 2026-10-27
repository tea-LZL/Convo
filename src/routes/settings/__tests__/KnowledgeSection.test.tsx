import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../../lib/api";
import {
  KnowledgeSection,
  effectiveAutoExtract,
  effectiveBudgetFraction,
  effectiveExtractEvery,
  effectiveRecallKinds,
  effectiveRecencyHalfLife,
  effectiveTopK,
  parseRoutingRow,
  readRoute,
} from "../KnowledgeSection";

const PROVIDERS = [
  { id: "p1", name: "Local Ollama", kind: "ollama", is_default: true, has_api_key: false, base_url: "http://localhost", created_at: "2026-01-01" },
  { id: "p2", name: "OpenRouter", kind: "openai_compat", is_default: false, has_api_key: true, base_url: "https://openrouter.test", created_at: "2026-01-01" },
] as never;

/** Read every knob the section owns; anything unlisted resolves as absent. */
function stubReads(stored: Record<string, string | null>) {
  vi.spyOn(api, "getSetting").mockImplementation(async (key: string) => {
    return key in stored ? stored[key] : null;
  });
}

function stubFailedReads() {
  vi.spyOn(api, "getSetting").mockRejectedValue(new Error("settings offline"));
}

const setSetting = () => vi.spyOn(api, "setSetting").mockResolvedValue(undefined);

/** The value last handed to `api.setSetting` for a key, parsed when JSON. */
function writtenFor(key: string): unknown {
  const call = vi.mocked(api.setSetting).mock.calls.find(([k]) => k === key);
  if (!call) throw new Error(`nothing was written to ${key}`);
  return call[1];
}

const writtenRaw = (key: string): string => writtenFor(key) as string;

describe("KnowledgeSection — the fallbacks are the backend's, not the UI's", () => {
  // Every assertion here mirrors a line in src-tauri/src/memory/config.rs. If
  // one of these drifts, the section renders a value the backend ignores.
  it("falls back for top_k exactly where the Rust reader does", () => {
    expect(effectiveTopK(null)).toBe(6);
    expect(effectiveTopK("")).toBe(6);
    expect(effectiveTopK("not a number")).toBe(6);
    expect(effectiveTopK("0")).toBe(6);
    expect(effectiveTopK("-3")).toBe(6);
    expect(effectiveTopK("2.5")).toBe(6);
    expect(effectiveTopK(" 12 ")).toBe(12);
    expect(effectiveTopK("8")).toBe(8);
  });

  it("falls back for the context budget fraction instead of clamping it", () => {
    expect(effectiveBudgetFraction(null)).toBe(0.15);
    expect(effectiveBudgetFraction("")).toBe(0.15);
    expect(effectiveBudgetFraction("0")).toBe(0.15);
    expect(effectiveBudgetFraction("1.5")).toBe(0.15);
    expect(effectiveBudgetFraction("-0.2")).toBe(0.15);
    expect(effectiveBudgetFraction("half")).toBe(0.15);
    expect(effectiveBudgetFraction("Infinity")).toBe(0.15);
    expect(effectiveBudgetFraction("0.4")).toBe(0.4);
    expect(effectiveBudgetFraction("1")).toBe(1);
  });

  it("falls back for the recency half-life exactly where the Rust reader does", () => {
    expect(effectiveRecencyHalfLife(null)).toBe(30);
    expect(effectiveRecencyHalfLife("")).toBe(30);
    expect(effectiveRecencyHalfLife("0")).toBe(30);
    expect(effectiveRecencyHalfLife("-7")).toBe(30);
    expect(effectiveRecencyHalfLife("Infinity")).toBe(30);
    expect(effectiveRecencyHalfLife("NaN")).toBe(30);
    expect(effectiveRecencyHalfLife("a while")).toBe(30);
    // A large half-life is a preference ("stop discounting old items"), not a
    // typo, so it is honoured rather than capped.
    expect(effectiveRecencyHalfLife("0.5")).toBe(0.5);
    expect(effectiveRecencyHalfLife("90")).toBe(90);
    expect(effectiveRecencyHalfLife("3650")).toBe(3650);
  });

  it("falls back for the extraction interval exactly where the Rust reader does", () => {
    expect(effectiveExtractEvery(null)).toBe(1);
    expect(effectiveExtractEvery("")).toBe(1);
    expect(effectiveExtractEvery("0")).toBe(1);
    expect(effectiveExtractEvery("-2")).toBe(1);
    expect(effectiveExtractEvery("1.5")).toBe(1);
    expect(effectiveExtractEvery("often")).toBe(1);
    expect(effectiveExtractEvery(" 3 ")).toBe(3);
    expect(effectiveExtractEvery("10")).toBe(10);
  });

  it("reads the recall scope exactly where the Rust reader does", () => {
    const all = ["user_pref", "project_fact", "decision", "constraint", "skill", "entity"];
    // Absent, empty, unparseable, and "nothing recognised" all mean every
    // kind: an empty scope honoured literally would disable recall.
    expect(effectiveRecallKinds(null)).toEqual(all);
    expect(effectiveRecallKinds("[]")).toEqual(all);
    expect(effectiveRecallKinds("not json")).toEqual(all);
    expect(effectiveRecallKinds('{"kind":"skill"}')).toEqual(all);
    expect(effectiveRecallKinds('["nonsense"]')).toEqual(all);
    expect(effectiveRecallKinds('["skill"]')).toEqual(["skill"]);
    // One unknown kind costs that kind, not the filter, and the order is the
    // list's, so two reads of the same row produce the same string.
    expect(effectiveRecallKinds('["skill","nonsense","user_pref"]')).toEqual([
      "user_pref",
      "skill",
    ]);
  });

  it("treats anything but the literal false as auto-extract on", () => {
    expect(effectiveAutoExtract(null)).toBe(true);
    expect(effectiveAutoExtract("")).toBe(true);
    expect(effectiveAutoExtract("true")).toBe(true);
    expect(effectiveAutoExtract("0")).toBe(true);
    expect(effectiveAutoExtract("no")).toBe(true);
    expect(effectiveAutoExtract("false")).toBe(false);
    expect(effectiveAutoExtract("FALSE")).toBe(false);
    expect(effectiveAutoExtract("  false  ")).toBe(false);
  });

  it("reads one capability at a time and treats a half-typed route as unset", () => {
    const row = parseRoutingRow(JSON.stringify({
      chat: { provider_id: "p1", model: " llama3 " },
      extraction: { provider_id: "p2" },
      embedding: { provider_id: "  ", model: "nomic" },
    }));
    expect(readRoute(row, "chat")).toEqual({ providerId: "p1", model: "llama3" });
    expect(readRoute(row, "extraction")).toBeNull();
    expect(readRoute(row, "embedding")).toBeNull();
    expect(readRoute(row, "unknown")).toBeNull();
  });

  it("degrades a routing row that is not a JSON object to nothing configured", () => {
    expect(parseRoutingRow(null)).toEqual({});
    expect(parseRoutingRow("")).toEqual({});
    expect(parseRoutingRow("{not json")).toEqual({});
    expect(parseRoutingRow("null")).toEqual({});
    expect(parseRoutingRow("[1, 2]")).toEqual({});
    expect(parseRoutingRow('"a string"')).toEqual({});
  });
});

describe("KnowledgeSection — rendering", () => {
  it("renders each knob's stored value", async () => {
    stubReads({
      "memory.top_k": "9",
      "memory.context_budget_fraction": "0.25",
      "memory.auto_extract": "false",
      "memory.routing": JSON.stringify({ chat: { provider_id: "p2", model: "gpt-4o-mini" } }),
    });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    expect(await screen.findByLabelText("Recall items")).toHaveValue(9);
    expect(screen.getByLabelText("Context budget fraction")).toHaveValue(0.25);
    expect(screen.getByRole("switch", { name: /extract memories automatically/i })).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(screen.getByLabelText("Chat model name")).toHaveValue("gpt-4o-mini"));
    expect(screen.getByLabelText("Chat model provider")).toHaveValue("p2");
  });

  it("shows a routed provider the app no longer knows about, rather than blanking it", async () => {
    stubReads({
      "memory.routing": JSON.stringify({ embedding: { provider_id: "p-removed", model: "nomic" } }),
    });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    await waitFor(() => expect(screen.getByLabelText("Embedding model name")).toHaveValue("nomic"));
    expect(screen.getByLabelText("Embedding model provider")).toHaveValue("p-removed");
  });

  it("reads no key the backend has no reader for", async () => {
    stubReads({});
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    await waitFor(() => expect(api.getSetting).toHaveBeenCalled());
    const keys = vi.mocked(api.getSetting).mock.calls.map(([key]) => key);
    expect([...keys].sort()).toEqual([
      "memory.auto_extract",
      "memory.context_budget_fraction",
      "memory.embed_all_notes",
      "memory.extract_every_n_exchanges",
      "memory.recall_kinds",
      "memory.recency_half_life_days",
      "memory.routing",
      "memory.top_k",
    ]);
    // Every key above has a reader in src-tauri/src/memory/config.rs and is
    // consulted on the live path: `memory.embed_all_notes` is passed to
    // `memory_index_fill` by the Build-index action, and both interval keys
    // are read by `extract_and_revise` and `boost`.
  });
});

describe("KnowledgeSection — writing", () => {
  it("writes a new top_k as the string the backend parses", async () => {
    stubReads({ "memory.top_k": "6" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    const input = await screen.findByLabelText("Recall items");
    fireEvent.change(input, { target: { value: "12" } });
    expect(api.setSetting).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("memory.top_k", "12"));
  });

  it("writes a context budget fraction the backend will accept", async () => {
    stubReads({ "memory.context_budget_fraction": "0.15" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    const input = await screen.findByLabelText("Context budget fraction");
    fireEvent.change(input, { target: { value: "0.4" } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("memory.context_budget_fraction", "0.4"));
  });

  it("refuses to store a value the backend would silently replace with its default", async () => {
    stubReads({ "memory.top_k": "6", "memory.context_budget_fraction": "0.15" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    const topK = await screen.findByLabelText("Recall items");
    fireEvent.change(topK, { target: { value: "0" } });
    fireEvent.blur(topK);
    const budget = screen.getByLabelText("Context budget fraction");
    fireEvent.change(budget, { target: { value: "2" } });
    fireEvent.blur(budget);

    expect(api.setSetting).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/at least 1/i)).toBeInTheDocument());
    expect(screen.getByText(/between 0 and 1/i)).toBeInTheDocument();
  });

  it("writes an extraction interval the backend will accept, and refuses one it would replace", async () => {
    stubReads({ "memory.extract_every_n_exchanges": "1" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    const input = await screen.findByLabelText("Extract every N exchanges");
    expect(input).toHaveValue(1);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(api.setSetting).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/every 1 exchange or more/i)).toBeInTheDocument());

    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(api.setSetting).toHaveBeenCalledWith("memory.extract_every_n_exchanges", "4"),
    );
  });

  it("writes a recency half-life the backend will accept, and refuses a zero one", async () => {
    stubReads({ "memory.recency_half_life_days": "30" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    const input = await screen.findByLabelText("Recency half-life (days)");
    expect(input).toHaveValue(30);
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.blur(input);
    expect(api.setSetting).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/more than 0 days/i)).toBeInTheDocument());

    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(api.setSetting).toHaveBeenCalledWith("memory.recency_half_life_days", "7"),
    );
  });

  it("writes the recall scope as a JSON array, and refuses to store an empty one", async () => {
    stubReads({ "memory.recall_kinds": '["user_pref","project_fact","skill"]' });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    const skills = await screen.findByRole("switch", { name: "Skills" });
    expect(skills).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Decisions" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(skills);
    await waitFor(() =>
      expect(api.setSetting).toHaveBeenCalledWith(
        "memory.recall_kinds",
        '["user_pref","project_fact"]',
      ),
    );

    // Clearing the last kind would store `[]`, which the reader treats as
    // "every kind" — the opposite of what the user just asked for.
    fireEvent.click(screen.getByRole("switch", { name: "Preferences" }));
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledTimes(2));
    vi.mocked(api.setSetting).mockClear();
    fireEvent.click(screen.getByRole("switch", { name: "Project facts" }));
    expect(api.setSetting).not.toHaveBeenCalled();
    expect(screen.getByText(/at least one kind/i)).toBeInTheDocument();
  });

  it("toggles auto-extract straight through, in both directions", async () => {
    stubReads({ "memory.auto_extract": "true" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    const toggle = await screen.findByRole("switch", { name: /extract memories automatically/i });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("memory.auto_extract", "false"));
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("memory.auto_extract", "true"));
  });
});

describe("KnowledgeSection — a failed read must not reset the user (Review Focus 5)", () => {
  it("renders the documented fallbacks for absent keys and writes nothing on mount", async () => {
    stubReads({});
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    expect(await screen.findByLabelText("Recall items")).toHaveValue(6);
    expect(screen.getByLabelText("Context budget fraction")).toHaveValue(0.15);
    expect(screen.getByRole("switch", { name: /extract memories automatically/i })).toHaveAttribute("aria-checked", "true");
    // An absent routing row is three unconfigured jobs, not three blanks to fill in.
    for (const job of ["Chat", "Extraction", "Embedding"]) {
      expect(screen.getByLabelText(`${job} model provider`)).toHaveValue("");
      expect(screen.getByLabelText(`${job} model name`)).toBeDisabled();
    }
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it("renders the same fallbacks when the read itself fails, and still writes nothing", async () => {
    stubFailedReads();
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    // Not 0 and not "": an empty number input that later saves on some
    // unrelated interaction is how a working configuration gets reset.
    expect(await screen.findByLabelText("Recall items")).toHaveValue(6);
    expect(screen.getByLabelText("Context budget fraction")).toHaveValue(0.15);
    expect(screen.getByRole("switch", { name: /extract memories automatically/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Extraction model provider")).toHaveValue("");
    expect(await screen.findByRole("alert")).toHaveTextContent("settings offline");
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it("keeps the keys that did read intact when one read fails", async () => {
    vi.spyOn(api, "getSetting").mockImplementation(async (key: string) => {
      if (key === "memory.top_k") throw new Error("row locked");
      if (key === "memory.context_budget_fraction") return "0.4";
      if (key === "memory.auto_extract") return "false";
      if (key === "memory.routing") return JSON.stringify({ chat: { provider_id: "p1", model: "llama3" } });
      return null;
    });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    expect(await screen.findByLabelText("Recall items")).toHaveValue(6);
    expect(screen.getByLabelText("Context budget fraction")).toHaveValue(0.4);
    expect(screen.getByRole("switch", { name: /extract memories automatically/i })).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(screen.getByLabelText("Chat model name")).toHaveValue("llama3"));
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it("surfaces a failed write instead of leaving the control claiming success", async () => {
    stubReads({ "memory.auto_extract": "true" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    vi.spyOn(api, "setSetting").mockRejectedValue(new Error("disk is full"));

    render(<KnowledgeSection />);

    const toggle = await screen.findByRole("switch", { name: /extract memories automatically/i });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk is full");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("clears its own error once the same write succeeds", async () => {
    stubReads({ "memory.auto_extract": "true" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    vi.spyOn(api, "setSetting")
      .mockRejectedValueOnce(new Error("disk is full"))
      .mockResolvedValue(undefined);

    render(<KnowledgeSection />);

    const toggle = await screen.findByRole("switch", { name: /extract memories automatically/i });
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk is full");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});

describe("KnowledgeSection — the routing row round-trips", () => {
  const STORED = JSON.stringify({
    extraction: { provider_id: "p2", model: "qwen2.5:3b", unknown_field: "keep me" },
    future_capability: { provider_id: "p9", model: "tomorrow" },
  });

  it("writes nothing when the user changes nothing", async () => {
    stubReads({ "memory.routing": STORED });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    await waitFor(() => expect(screen.getByLabelText("Extraction model name")).toHaveValue("qwen2.5:3b"));
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it("keeps the capabilities it did not change, byte-for-byte in content", async () => {
    stubReads({ "memory.routing": STORED });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    await waitFor(() => expect(screen.getByLabelText("Extraction model name")).toHaveValue("qwen2.5:3b"));
    fireEvent.change(screen.getByLabelText("Chat model provider"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Chat model name"), { target: { value: "llama3" } });

    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("memory.routing", expect.any(String)));
    expect(JSON.parse(writtenRaw("memory.routing"))).toEqual({
      extraction: { provider_id: "p2", model: "qwen2.5:3b", unknown_field: "keep me" },
      future_capability: { provider_id: "p9", model: "tomorrow" },
      chat: { provider_id: "p1", model: "llama3" },
    });
  });

  it("drops only the capability the user turned back to the session model", async () => {
    stubReads({ "memory.routing": STORED });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    await waitFor(() => expect(screen.getByLabelText("Extraction model provider")).toHaveValue("p2"));
    fireEvent.change(screen.getByLabelText("Extraction model provider"), { target: { value: "" } });

    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("memory.routing", expect.any(String)));
    expect(JSON.parse(writtenRaw("memory.routing"))).toEqual({
      future_capability: { provider_id: "p9", model: "tomorrow" },
    });
  });

  it("says the stored route is untouched while a provider has no model yet", async () => {
    stubReads({ "memory.routing": JSON.stringify({ chat: { provider_id: "p1", model: "llama3" } }) });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    expect(await screen.findByLabelText("Chat model name")).toHaveValue("llama3");
    expect(screen.queryByText(/keeps the stored route/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Embedding model provider"), { target: { value: "p2" } });
    expect(await screen.findByText(/keeps the stored route/i)).toBeInTheDocument();
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it("replaces a malformed row with a valid one instead of refusing to save", async () => {    stubReads({ "memory.routing": "{half-writ" });
    vi.spyOn(api, "listProviders").mockResolvedValue(PROVIDERS);
    setSetting();

    render(<KnowledgeSection />);

    expect(await screen.findByLabelText("Chat model name")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Chat model provider"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Chat model name"), { target: { value: "llama3" } });

    await waitFor(() => expect(JSON.parse(writtenRaw("memory.routing"))).toEqual({
      chat: { provider_id: "p1", model: "llama3" },
    }));
  });
});
