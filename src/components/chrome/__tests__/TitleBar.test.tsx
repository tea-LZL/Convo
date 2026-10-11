import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TitleBar } from "../TitleBar";

describe("TitleBar", () => {
  beforeEach(() => {
    vi.mocked(getCurrentWindow().isMaximized).mockResolvedValue(false);
  });

  afterEach(() => cleanup());

  it("exposes the three window controls with accessible names", () => {
    render(<TitleBar />);
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });

  it("drives the native window", async () => {
    render(<TitleBar />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));

    const window = getCurrentWindow();
    await waitFor(() => expect(window.minimize).toHaveBeenCalled());
    expect(window.toggleMaximize).toHaveBeenCalled();
    expect(window.close).toHaveBeenCalled();
  });

  it("shows Restore, not Maximize, when the window is already maximized", async () => {
    vi.mocked(getCurrentWindow().isMaximized).mockResolvedValue(true);

    render(<TitleBar />);

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximize" })).not.toBeInTheDocument();
  });
});
