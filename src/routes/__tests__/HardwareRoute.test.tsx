import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HardwareRoute } from "../HardwareRoute";

describe("HardwareRoute", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_hardware") {
        return {
          os: "linux",
          arch: "x86_64",
          cpuBrand: "Test CPU",
          cpuCores: 8,
          totalMemoryBytes: 32 * 1024 ** 3,
          availableMemoryBytes: 16 * 1024 ** 3,
          gpus: [],
        };
      }
      if (command === "recommend_models") {
        return { ramBytes: 32 * 1024 ** 3, vramBytes: 0, fits: [], partial: [], tooBig: [] };
      }
      return null;
    });
  });

  it("renders camelCase hardware and fit responses", async () => {
    render(
      <MemoryRouter>
        <HardwareRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Test CPU")).toBeInTheDocument();
    expect(screen.getByText("32.0 GB")).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it("shows a failure state and retry control for malformed hardware", async () => {
    vi.mocked(invoke).mockResolvedValue({ os: "linux" });

    render(
      <MemoryRouter>
        <HardwareRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Hardware scan failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-scan" })).toBeInTheDocument();
    expect(screen.queryByText("Scanning hardware…")).not.toBeInTheDocument();
  });

  it("retries a failed hardware scan", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("scan failed"));

    render(
      <MemoryRouter>
        <HardwareRoute />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Re-scan" }));

    expect(await screen.findByText("Test CPU")).toBeInTheDocument();
    expect(screen.queryByText("Hardware scan failed")).not.toBeInTheDocument();
  });

  it("does not crash when fit arrays are missing", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_hardware") {
        return {
          os: "linux",
          arch: "x86_64",
          cpuBrand: "Test CPU",
          cpuCores: 8,
          totalMemoryBytes: 32 * 1024 ** 3,
          availableMemoryBytes: 16 * 1024 ** 3,
          gpus: [],
        };
      }
      if (command === "recommend_models") return { ramBytes: 1, vramBytes: 0 };
      return null;
    });

    render(
      <MemoryRouter>
        <HardwareRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Test CPU")).toBeInTheDocument();
    expect(screen.queryByText("Scanning hardware…")).not.toBeInTheDocument();
  });
});
