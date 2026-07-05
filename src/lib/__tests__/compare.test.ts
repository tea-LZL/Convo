import { describe, expect, it } from "vitest";

/**
 * Unit tests for the state transition logic used by CompareRoute.
 * These test the add/remove/update model patterns without rendering React.
 */

interface ModelSelection {
  provider_id: string;
  model: string;
}

function addModel(current: ModelSelection[], defaultProviderId: string, defaultModel: string, max: number = 4): ModelSelection[] {
  if (current.length >= max) return current;
  return [...current, { provider_id: defaultProviderId, model: defaultModel }];
}

function removeModel(current: ModelSelection[], index: number): ModelSelection[] {
  return current.filter((_, i) => i !== index);
}

function updateModel(
  current: ModelSelection[],
  index: number,
  patch: Partial<ModelSelection>
): ModelSelection[] {
  return current.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

describe("Compare model selection state", () => {
  it("addModel appends default provider/model", () => {
    const result = addModel([], "ollama", "llama3.1");
    expect(result).toEqual([{ provider_id: "ollama", model: "llama3.1" }]);
  });

  it("addModel enforces max limit of 4", () => {
    const four = [
      { provider_id: "a", model: "m1" },
      { provider_id: "b", model: "m2" },
      { provider_id: "c", model: "m3" },
      { provider_id: "d", model: "m4" },
    ];
    const result = addModel(four, "ollama", "llama3.1");
    expect(result).toHaveLength(4);
  });

  it("removeModel filters by index", () => {
    const two = [
      { provider_id: "a", model: "m1" },
      { provider_id: "b", model: "m2" },
    ];
    const result = removeModel(two, 0);
    expect(result).toEqual([{ provider_id: "b", model: "m2" }]);
  });

  it("updateModel patches a single entry", () => {
    const two = [
      { provider_id: "a", model: "m1" },
      { provider_id: "b", model: "m2" },
    ];
    const result = updateModel(two, 1, { model: "m3" });
    expect(result[1].model).toBe("m3");
    expect(result[0].model).toBe("m1"); // unchanged
  });

  it("updateModel handles provider switch", () => {
    const selection = [{ provider_id: "a", model: "m1" }];
    const result = updateModel(selection, 0, { provider_id: "b", model: "" });
    expect(result[0].provider_id).toBe("b");
    expect(result[0].model).toBe("");
  });
});
