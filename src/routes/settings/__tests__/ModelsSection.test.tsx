import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

    render(
      <MemoryRouter>
        <ModelsSection />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("llama3")).toBeInTheDocument());
    expect(api.listModelsForProvider).toHaveBeenCalledWith("p1");
  });

  it("refreshes the selected provider and starts a chat with its composite model id", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue([
      { id: "p1", name: "Local", kind: "ollama", is_default: true, has_api_key: false, base_url: "http://localhost" },
    ] as never);
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([
      { id: "p1::llama3", name: "llama3", provider_id: "p1" },
    ] as never);
    vi.spyOn(api, "refreshModels").mockResolvedValue([
      { id: "p1::llama3", name: "llama3", provider_id: "p1" },
    ] as never);
    vi.spyOn(api, "createSession").mockResolvedValue({ id: "session-new" } as never);

    render(
      <MemoryRouter>
        <ModelsSection />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("llama3")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.refreshModels).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith({
      title: "llama3",
      modelId: "p1::llama3",
      providerId: "p1",
    }));
  });
});
