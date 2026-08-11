import { act, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import App from "../App";
import { useSessionsStore } from "../../stores/sessions";
import { useTourStore } from "../../stores/tour";

describe("responsive app shell", () => {
  let mediaChange: ((event: MediaQueryListEvent) => void) | undefined;

  beforeEach(() => {
    mediaChange = undefined;
    window.history.replaceState(null, "", "#/hardware");
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false });
    useTourStore.setState({ active: false, step: 0, dismissed: true });
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: query === "(max-width: 760px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
        mediaChange = listener as (event: MediaQueryListEvent) => void;
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "app_info") return { version: "0.7.0", data_dir: "/tmp", db_path: "/tmp/convo.db", os: "linux", arch: "x86_64" };
      if (command === "get_hardware") return { os: "linux", arch: "x86_64", cpuBrand: "Test CPU", cpuCores: 8, totalMemoryBytes: 1, availableMemoryBytes: 1, gpus: [] };
      if (command === "recommend_models") return { ramBytes: 1, vramBytes: 0, fits: [], partial: [], tooBig: [] };
      return [];
    });
  });

  it("collapses the primary sidebar below the supported width band", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole("main").parentElement).toHaveAttribute("data-sidebar-collapsed", "true"));
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 760px)");
    const shell = screen.getByRole("main").parentElement;
    expect(shell).not.toBeNull();
    expect((await axe(shell!)).violations).toHaveLength(0);

    act(() => mediaChange?.({ matches: false } as MediaQueryListEvent));
    await waitFor(() => expect(screen.getByRole("main").parentElement).toHaveAttribute("data-sidebar-collapsed", "false"));
  });
});
