import { beforeEach, describe, expect, it } from "vitest";
import { acceptTerminalEvent } from "../chatStream";

describe("chat stream terminal events", () => {
  beforeEach(() => {
    // Each test uses a unique stream id; the module owns the process-lifetime dedupe set.
  });

  it("accepts only the first terminal event for a stream", () => {
    expect(acceptTerminalEvent("session-terminal-test", "stream-1")).toBe(true);
    expect(acceptTerminalEvent("session-terminal-test", "stream-1")).toBe(false);
    expect(acceptTerminalEvent("session-terminal-test", "stream-2")).toBe(true);
  });
});

/* ponytail: terminal dedupe is process-local because stream IDs are unique per send. */
