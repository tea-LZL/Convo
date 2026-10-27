import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../../../lib/api";
import { useChatStreamStore } from "../../../stores/chatStream";
import { MessageList, parseMemoryUsed } from "../MessageRow";

const NOW = "2026-01-27T00:00:00.000Z";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    session_id: "s1",
    role: "assistant",
    content: "an answer",
    thinking: null,
    attachments_json: null,
    prompt_tokens: null,
    output_tokens: null,
    memory_used: null,
    created_at: NOW,
    ...over,
  };
}

function seed(messages: ChatMessage[]) {
  useChatStreamStore.setState({
    sessions: {
      s1: {
        messages,
        status: "complete",
        streaming: false,
        streamContent: "",
        streamThinking: "",
        error: null,
        loadingMessages: false,
      },
    },
  } as never);
}

function renderList() {
  return render(
    <MessageList
      sessionId="s1"
      editingMessageId={null}
      setEditingMessageId={() => {}}
      collapsedThinking={new Set<number>()}
      setCollapsedThinking={() => {}}
      setContextMenu={() => {}}
      onBumpScroll={() => {}}
      onResend={async () => {}}
    />,
  );
}

const SNAPSHOT = JSON.stringify([
  {
    ownerType: "note",
    ownerId: "n1",
    label: "Pinned note",
    title: "Release runbook",
    reason: null,
  },
  {
    ownerType: "memory",
    ownerId: "m1",
    label: "Project facts",
    title: "Database",
    reason: "keyword match on postgres",
  },
]);

describe("parseMemoryUsed", () => {
  it("reads what Rust wrote, and calls a missing reason what it is", () => {
    expect(parseMemoryUsed(SNAPSHOT)).toEqual([
      { ownerType: "note", ownerId: "n1", label: "Pinned note", title: "Release runbook", reason: null },
      {
        ownerType: "memory",
        ownerId: "m1",
        label: "Project facts",
        title: "Database",
        reason: "keyword match on postgres",
      },
    ]);
  });

  it("treats anything it cannot read as no provenance rather than throwing", () => {
    // A message from before V013, a hand-edited row, and a row from a newer
    // build all reach this function. Provenance is decoration; the answer is
    // not, so none of these may take the row down.
    expect(parseMemoryUsed(null)).toEqual([]);
    expect(parseMemoryUsed("")).toEqual([]);
    expect(parseMemoryUsed("{not json")).toEqual([]);
    expect(parseMemoryUsed('{"ownerType":"memory"}')).toEqual([]);
    expect(parseMemoryUsed("[null, 3, {\"ownerType\":\"memory\"}]")).toEqual([]);
    expect(
      parseMemoryUsed('[{"ownerType":"memory","ownerId":"m1","label":"L","reason":7}]'),
    ).toEqual([{ ownerType: "memory", ownerId: "m1", label: "L", title: null, reason: null }]);
  });
});

describe("a message shows what it was sent with", () => {
  beforeEach(() => {
    useChatStreamStore.setState({ sessions: {} });
  });

  it("lists every row with its label and why it was there", () => {
    seed([message({ memory_used: SNAPSHOT })]);
    renderList();

    expect(screen.getByText("2 memories used")).toBeInTheDocument();
    // The row's name, not its kind group: "Project facts" names six memories
    // and none of them, which is the difference between a list a user can
    // audit and a list they have to take on faith.
    expect(screen.getByText("Release runbook")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    // A pinned row was not retrieved, so it must not claim a reason.
    expect(screen.getByText("— pinned")).toBeInTheDocument();
    expect(screen.getByText("— keyword match on postgres")).toBeInTheDocument();
  });

  it("says nothing when the send used no memory, and nothing when it recorded none", () => {
    seed([message({ memory_used: "[]" }), message({ id: "m2", memory_used: null })]);
    renderList();

    expect(screen.queryByText(/memor(y|ies) used/)).not.toBeInTheDocument();
    // The answer is still there: a missing snapshot is not a missing message.
    expect(screen.getAllByText("an answer")).toHaveLength(2);
  });

  it("re-renders the row when only the snapshot changes", () => {
    // The row is memoised on a hand-written comparator. A new field that is
    // not added there renders once and then never updates, which is exactly
    // what a reload would hide.
    seed([message({ memory_used: null })]);
    renderList();
    expect(screen.queryByText("1 memory used")).not.toBeInTheDocument();

    act(() => {
      seed([message({ memory_used: SNAPSHOT })]);
    });
    expect(screen.getByText("2 memories used")).toBeInTheDocument();
  });
});
