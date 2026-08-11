import { describe, expect, it, vi } from "vitest";
import { errorClass, recordLog, withLog } from "../logger";

describe("privacy-safe logger", () => {
  it("records only structured metadata and sanitizes errors", () => {
    const listener = vi.fn();
    window.addEventListener("convo:log", listener);
    recordLog({ operation: "chat", status: "failed", route: "/chat", errorClass: errorClass(new Error("secret prompt")) });
    const detail = listener.mock.calls[0][0].detail;
    expect(detail).toEqual({ operation: "chat", status: "failed", route: "/chat", errorClass: "Error" });
    expect(JSON.stringify(detail)).not.toContain("secret prompt");
    window.removeEventListener("convo:log", listener);
  });

  it("records success and failure around an operation", async () => {
    await expect(withLog("success", async () => "ok")).resolves.toBe("ok");
    await expect(withLog("failure", async () => { throw new Error("no content logged"); })).rejects.toThrow();
  });
});
