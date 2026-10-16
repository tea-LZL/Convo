import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeIndexStatus } from "../../../lib/api";
import { IndexStatusBanner } from "../IndexStatusBanner";

function status(overrides: Partial<KnowledgeIndexStatus> = {}): KnowledgeIndexStatus {
  return {
    memoryCount: 10,
    noteCount: 3,
    embeddedCount: 10,
    needsEmbedding: 0,
    needsReindex: false,
    embeddingModel: "nomic-embed-text",
    semanticNote: null,
    ...overrides,
  };
}

describe("IndexStatusBanner", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("renders nothing when the index is healthy", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "knowledge_index_status") return status();
      return null;
    });

    const { container } = render(<IndexStatusBanner />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("knowledge_index_status"));
    expect(container.firstChild).toBeNull();
  });

  it("renders semanticNote verbatim when no embedding model is configured, without claiming recall is live", async () => {
    const note =
      "No embedding model configured. Recall is keyword-only, so it will miss memories that share no words with the question.";
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "knowledge_index_status") {
        return status({
          embeddingModel: null,
          embeddedCount: 0,
          semanticNote: note,
        });
      }
      return null;
    });

    render(<IndexStatusBanner />);
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.getByText(/semantic recall off/i)).toBeInTheDocument();
    expect(screen.queryByText(/\blive\b/i)).not.toBeInTheDocument();
  });

  it("distinguishes needsReindex from needsEmbedding > 0", async () => {
    const reindexNote =
      "The embedding model changed, so existing vectors are not comparable. They will be rebuilt on the next index pass.";
    const pendingNote =
      "4 row(s) are not embedded yet. Semantic recall will improve as they fill in.";

    vi.mocked(invoke).mockImplementationOnce(async (cmd) => {
      if (cmd === "knowledge_index_status") {
        return status({
          needsReindex: true,
          needsEmbedding: 4,
          semanticNote: reindexNote,
        });
      }
      return null;
    });

    const { unmount } = render(<IndexStatusBanner />);
    const reindexBanner = await screen.findByRole("status");
    const reindexText = reindexBanner.textContent ?? "";
    expect(reindexText).toContain(reindexNote);
    expect(reindexText.toLowerCase()).toContain("needs reindex");
    unmount();

    vi.mocked(invoke).mockImplementationOnce(async (cmd) => {
      if (cmd === "knowledge_index_status") {
        return status({
          needsReindex: false,
          needsEmbedding: 4,
          semanticNote: pendingNote,
        });
      }
      return null;
    });

    render(<IndexStatusBanner />);
    const pendingBanner = await screen.findByRole("status");
    const pendingText = pendingBanner.textContent ?? "";
    expect(pendingText).toContain(pendingNote);
    expect(pendingText).not.toBe(reindexText);
    expect(pendingText.toLowerCase()).not.toContain("needs reindex");
  });

  it("re-fetches when refreshKey changes after a pin or toggle mutation", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "knowledge_index_status") {
        return status({
          embeddingModel: null,
          semanticNote: "No embedding model configured.",
        });
      }
      return null;
    });

    const { rerender } = render(<IndexStatusBanner refreshKey={0} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    rerender(<IndexStatusBanner refreshKey={1} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });
});
