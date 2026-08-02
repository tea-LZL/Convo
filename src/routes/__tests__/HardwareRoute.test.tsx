import { render, screen } from "@testing-library/react";
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
});
