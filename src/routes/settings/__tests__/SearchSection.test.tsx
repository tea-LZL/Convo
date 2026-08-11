import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../../lib/api";
import { SearchSection } from "../../SettingsRoute";

describe("SearchSection", () => {
  it("loads keyring-safe config and tests a configured provider", async () => {
    vi.spyOn(api, "getSearchConfig").mockResolvedValue({
      provider: "brave",
      base_url: null,
      api_key: null,
      has_api_key: true,
      max_results: 5,
    });
    vi.spyOn(api, "webSearch").mockResolvedValue([
      { title: "Result", url: "https://example.test", snippet: "Preview" },
    ]);

    render(
      <MemoryRouter>
        <SearchSection />
      </MemoryRouter>,
    );
    expect(await screen.findByText("A key is saved in the OS keyring.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(api.webSearch).toHaveBeenCalledWith(
      "Convo local-first AI",
      expect.objectContaining({ provider: "brave", has_api_key: true }),
    ));
    expect(await screen.findByText("Result")).toBeInTheDocument();
  });

  it("shows provider configuration errors", async () => {
    vi.spyOn(api, "getSearchConfig").mockRejectedValue(new Error("config offline"));
    render(
      <MemoryRouter>
        <SearchSection />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("config offline");
  });
});
