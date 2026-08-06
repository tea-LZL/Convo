import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelsSection } from "../ModelsSection";
import { api } from "../../../lib/api";

describe("ModelsSection", () => {
  it("loads models scoped to the selected provider", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue([
      { id: "p1", name: "Local", kind: "ollama", is_default: true, has_api_key: false, base_url: "http://localhost" },
    ] as never);
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([
      { id: "m1", name: "llama3", provider_id: "p1" },
    ] as never);

    render(<ModelsSection />);
    await waitFor(() => expect(screen.getByText("llama3")).toBeInTheDocument());
    expect(api.listModelsForProvider).toHaveBeenCalledWith("p1");
  });
});
