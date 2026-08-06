import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../../lib/api";
import { ProvidersSection } from "../../SettingsRoute";

describe("ProvidersSection", () => {
  it("edits a provider and refreshes its model cache", async () => {
    vi.spyOn(api, "listProviders").mockResolvedValue([
      {
        id: "p1",
        name: "Local",
        kind: "ollama",
        base_url: "http://localhost:11434",
        has_api_key: false,
        is_default: true,
        created_at: "now",
      },
    ]);
    vi.spyOn(api, "updateProvider").mockResolvedValue(undefined);
    vi.spyOn(api, "refreshModels").mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/settings/providers"]}>
        <ProvidersSection />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("Local")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Local"), { target: { value: "Edited local" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      "p1",
      "Edited local",
      "http://localhost:11434",
      null,
      null,
    ));
    expect(api.refreshModels).toHaveBeenCalledWith("p1");
  });
});
