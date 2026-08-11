import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { DocumentsRoute } from "../DocumentsRoute";

const document = {
  id: "doc-1",
  title: "Readme",
  content: "Original content",
  kind: "markdown" as const,
  language: null,
  file_path: null,
  created_at: "now",
  updated_at: "now",
};

describe("DocumentsRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "listDocuments").mockResolvedValue([document]);
    vi.spyOn(api, "upsertDocument").mockResolvedValue("doc-1");
    vi.spyOn(api, "deleteDocument").mockResolvedValue(undefined);
  });

  it("shows persistence type and saves DB-backed drafts without losing content", async () => {
    render(
      <MemoryRouter>
        <DocumentsRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByText("DB-backed")).toBeInTheDocument();
    const editor = screen.getByDisplayValue("Original content");
    fireEvent.change(editor, { target: { value: "Draft content" } });
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(api.upsertDocument).toHaveBeenCalledWith(expect.objectContaining({
      id: "doc-1",
      content: "Draft content",
    })));
  });

  it("keeps a dirty draft when persistence fails", async () => {
    vi.mocked(api.upsertDocument).mockRejectedValue(new Error("read only"));
    render(
      <MemoryRouter>
        <DocumentsRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByDisplayValue("Original content")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Original content"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));

    await waitFor(() => expect(screen.getByDisplayValue("Keep this draft")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("read only");
  });

  it("shows a retryable empty-state load error", async () => {
    vi.mocked(api.listDocuments).mockRejectedValue(new Error("database offline"));
    render(
      <MemoryRouter>
        <DocumentsRoute />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("database offline");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
