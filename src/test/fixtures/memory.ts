import { MemoryItem, MemorySearchHit, ExtractedFact } from "../../lib/api";

export const preferenceItem: MemoryItem = {
  id: "mem-pref-1",
  kind: "user_pref",
  title: "Tone",
  content: "Keep responses concise and friendly.",
  tags: "tone,style",
  is_enabled: true,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

export const factItem: MemoryItem = {
  id: "mem-fact-1",
  kind: "project_fact",
  title: "Stack",
  content: "Convo is built with React, Zustand, and Tauri.",
  tags: "stack",
  is_enabled: true,
  created_at: "2024-01-02T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
};

export const skillItem: MemoryItem = {
  id: "mem-skill-1",
  kind: "skill",
  title: "Code review",
  content: "When reviewing code, check for types, tests, and edge cases.",
  tags: "coding",
  is_enabled: false,
  created_at: "2024-01-03T00:00:00Z",
  updated_at: "2024-01-03T00:00:00Z",
};

export const memoryItems = [preferenceItem, factItem, skillItem];

export const memorySearchHits: MemorySearchHit[] = [
  { item: preferenceItem, snippet: "...concise and friendly..." },
  { item: factItem, snippet: "...React, Zustand, and Tauri..." },
];

export const extractedFacts: ExtractedFact[] = [
  { kind: "user_pref", title: "Conciseness", content: "Prefers short answers.", tags: "tone" },
];
