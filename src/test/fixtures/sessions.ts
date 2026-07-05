import { Session, SessionWithSnippet } from "../../lib/api";

export const sessionFixtures: Record<string, Session> = {
  newChat: {
    id: "sess-new",
    title: "New Chat",
    model_id: null,
    provider_id: null,
    group_id: null,
    is_pinned: false,
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  renamed: {
    id: "sess-renamed",
    title: "Project Ideas",
    model_id: "model-1",
    provider_id: "provider-1",
    group_id: null,
    is_pinned: true,
    is_archived: false,
    created_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-03T00:00:00Z",
  },
  archived: {
    id: "sess-archived",
    title: "Old Discussion",
    model_id: "model-2",
    provider_id: "provider-2",
    group_id: null,
    is_pinned: false,
    is_archived: true,
    created_at: "2024-01-04T00:00:00Z",
    updated_at: "2024-01-05T00:00:00Z",
  },
};

export const sessionList = Object.values(sessionFixtures);

export const sessionSearchHits: SessionWithSnippet[] = [
  { ...sessionFixtures.renamed, snippet: "...<mark>Project</mark>..." },
];
