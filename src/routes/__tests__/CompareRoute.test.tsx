import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { CompareRoute } from "../CompareRoute";

const callbacks: Record<string, (event: { payload: Record<string, unknown> }) => void> = {};

describe("CompareRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "listProviders").mockResolvedValue([
      { id: "p1", name: "Local", kind: "ollama", base_url: "http://localhost", is_default: true, has_api_key: false, created_at: "now" },
    ]);
    vi.spyOn(api, "listModelsForProvider").mockResolvedValue([
      { id: "p1::model", name: "model", provider_id: "p1" },
    ] as never);
    vi.spyOn(api, "runCompare").mockResolvedValue("run-1");
    vi.spyOn(api, "cancelCompare").mockResolvedValue(undefined);
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      callbacks[event] = handler as (event: { payload: Record<string, unknown> }) => void;
      return vi.fn();
    });
  });

  it("stops a running comparison locally and ignores stale run events", async () => {
    render(
      <MemoryRouter>
        <CompareRoute />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listModelsForProvider).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.change(screen.getByPlaceholderText("Prompt to send to all models…"), { target: { value: "Compare this" } });
    fireEvent.click(screen.getByRole("button", { name: "Run compare" }));
    await waitFor(() => expect(api.runCompare).toHaveBeenCalled());

    callbacks["compare-chunk"]({ payload: { run_id: "stale-run", index: 0, content: "stale" } });
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(api.cancelCompare).toHaveBeenCalledWith("run-1"));
    expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
  });

  it("batches compare chunks until the next animation frame", async () => {
    let flush!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    });
    render(
      <MemoryRouter>
        <CompareRoute />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listModelsForProvider).toHaveBeenCalledWith("p1"));
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /Add model/ })[0]);
    fireEvent.change(screen.getByPlaceholderText("Prompt to send to all models…"), { target: { value: "Compare this" } });
    fireEvent.click(screen.getByRole("button", { name: "Run compare" }));
    await waitFor(() => expect(api.runCompare).toHaveBeenCalled());

    callbacks["compare-chunk"]({ payload: { run_id: "run-1", index: 0, content: "first" } });
    callbacks["compare-chunk"]({ payload: { run_id: "run-1", index: 0, content: "second" } });
    expect(screen.queryByText("second")).not.toBeInTheDocument();
    act(() => flush(0));
    expect(await screen.findByText("firstsecond")).toBeInTheDocument();
  });
});
