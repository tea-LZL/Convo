import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { DiagnosticsRoute } from "../DiagnosticsRoute";

const report = {
  app: { version: "0.7.0", data_dir: "/tmp/convo", db_path: "/tmp/convo.db", os: "linux", arch: "x86_64", uptime_secs: 1 },
  db: { ok: true, size_bytes: 1, wal_size_bytes: 0, schema_version: 5, tables: [], page_count: 1, page_size: 4096 },
  providers: [],
  counts: { sessions: 0, messages: 0, notes: 0, tasks: 0, documents: 0, memory_items: 0, enabled_memory: 0, compare_runs: 0, attachments: 0 },
  storage: { blobs_bytes: 0, logs_bytes: 0, themes_bytes: 0 },
  recent_logs: [],
};

describe("DiagnosticsRoute", () => {
  it("renders database health and recovery actions", async () => {
    vi.spyOn(api, "getDiagnostics").mockResolvedValue(report as never);
    render(<MemoryRouter><DiagnosticsRoute /></MemoryRouter>);
    expect(await screen.findByText("Diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Schema version")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import backup" })).toBeInTheDocument();
  });

  it("shows a retryable failure state", async () => {
    vi.spyOn(api, "getDiagnostics").mockRejectedValue(new Error("db unavailable"));
    render(<MemoryRouter><DiagnosticsRoute /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("db unavailable"));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
