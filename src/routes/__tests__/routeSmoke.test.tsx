import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../app/App";
import { ErrorBoundary } from "../../components/ui/ErrorBoundary";
import { useSessionsStore } from "../../stores/sessions";
import { useTourStore } from "../../stores/tour";

const session = {
  id: "session-1",
  title: "New Chat",
  model_id: null,
  provider_id: null,
  group_id: null,
  is_pinned: false,
  is_archived: false,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

const diagnostics = {
  app: { version: "0.7.0", data_dir: "/tmp", db_path: "/tmp/convo.db", os: "linux", arch: "x86_64", uptime_secs: 1 },
  db: { ok: true, size_bytes: 0, wal_size_bytes: 0, schema_version: 1, tables: [], page_count: 0, page_size: 4096 },
  providers: [],
  counts: { sessions: 0, messages: 0, notes: 0, tasks: 0, documents: 0, memory_items: 0, enabled_memory: 0, compare_runs: 0, attachments: 0 },
  storage: { blobs_bytes: 0, logs_bytes: 0, themes_bytes: 0 },
  recent_logs: [],
};

function invokeResult(command: string): unknown {
  if (command === "create_session") return session;
  if (command === "app_info") return { version: "0.7.0", data_dir: "/tmp", db_path: "/tmp/convo.db", os: "linux", arch: "x86_64" };
  if (command === "get_diagnostics") return diagnostics;
  if (command === "get_hardware") {
    return { os: "linux", arch: "x86_64", cpuBrand: "Test CPU", cpuCores: 8, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 16 * 1024 ** 3, gpus: [] };
  }
  if (command === "recommend_models") return { ramBytes: 32 * 1024 ** 3, vramBytes: 0, fits: [], partial: [], tooBig: [] };
  if (command === "get_search_config") return { provider: "none", base_url: null, api_key: null, max_results: 5 };
  return [];
}

const routes = [
  "/",
  "/chat",
  "/chat/session-1",
  "/compare",
  "/documents",
  "/notes",
  "/tasks",
  "/memory",
  "/diagnostics",
  "/hardware",
  "/settings/general",
  "/settings/providers",
  "/settings/models",
  "/settings/search",
  "/settings/theme",
  "/settings/shortcuts",
  "/about",
  "/not-a-route",
];

afterEach(() => vi.restoreAllMocks());

describe("route smoke tests", () => {
  beforeEach(() => {
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    useTourStore.setState({ active: false, step: 0, dismissed: true });
    useSessionsStore.setState({ sessions: [], activeId: null, loading: false });
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockImplementation(async (command) => invokeResult(command));
  });

  it.each(routes)("renders %s without the route fallback", async (route) => {
    window.history.replaceState(null, "", `#${route}`);
    render(<App />);

    const expectedRoute = route === "/" || route === "/not-a-route" ? "/chat" : route;
    expect(await screen.findByRole("main")).toHaveAttribute("data-route", expectedRoute);
    await waitFor(() => {
      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    });
  });

  it("survives repeated route navigation without a latched boundary", async () => {
    window.history.replaceState(null, "", "#/hardware");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute("data-route", "/memory"));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute("data-route", "/chat"));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute("data-route", "/settings"));
    fireEvent.click(screen.getByRole("button", { name: "Hardware scan" }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute("data-route", "/hardware"));
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});

function Bomb({ active }: { active: boolean }) {
  if (active) throw new Error("boom");
  return <div>Recovered route</div>;
}

function BoundaryHarness() {
  const [route, setRoute] = useState("/broken");
  return (
    <>
      <button onClick={() => setRoute("/healthy")}>Navigate</button>
      <ErrorBoundary label="Routes" resetKey={route}>
        <Bomb active={route === "/broken"} />
      </ErrorBoundary>
    </>
  );
}

describe("route error recovery", () => {
  it("clears a stale route error after navigation", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<BoundaryHarness />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));

    expect(screen.getByText("Recovered route")).toBeInTheDocument();
  });
});
