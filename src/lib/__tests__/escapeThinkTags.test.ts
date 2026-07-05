import { describe, expect, it } from "vitest";
import { escapeThinkTags } from "../../components/chat/MessageRow";

describe("escapeThinkTags", () => {
  it("strips lowercase <think> tags", () => {
    expect(escapeThinkTags("text <think>inner</think> end")).toBe(
      "text inner end"
    );
  });

  it("strips uppercase <THINK> tags", () => {
    expect(escapeThinkTags("before <THINK>test</THINK> after")).toBe(
      "before test after"
    );
  });

  it("strips mixed case <Think> tags", () => {
    expect(escapeThinkTags("pre <Think>mid</Think> post")).toBe(
      "pre mid post"
    );
  });

  it("passes through text without think tags unchanged", () => {
    const input = "hello world <b>bold</b> <code>x</code>";
    expect(escapeThinkTags(input)).toBe(input);
  });

  it("handles multiple think tags", () => {
    expect(
      escapeThinkTags("<think>first</think> gap <think>second</think>")
    ).toBe(
      "first gap second"
    );
  });

  it("strips standalone <think> tag", () => {
    expect(escapeThinkTags("a <think> b")).toBe("a  b");
  });

  it("preserves inner markdown formatting", () => {
    const input = "<think>**Analyze:** check this</think> Hello!";
    expect(escapeThinkTags(input)).toBe("**Analyze:** check this Hello!");
  });
});
