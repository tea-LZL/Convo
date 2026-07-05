import { Task, Note } from "../../lib/api";

export const pendingTask: Task = {
  id: "task-1",
  title: "Write unit tests",
  body: "Cover stores, hooks, and lib modules.",
  due_at: "2024-12-31T23:59:59Z",
  completed_at: null,
  priority: 1,
  session_id: "sess-1",
  created_at: "2024-01-01T00:00:00Z",
};

export const completedTask: Task = {
  id: "task-2",
  title: "Set up Vitest",
  body: null,
  due_at: null,
  completed_at: "2024-01-02T00:00:00Z",
  priority: 2,
  session_id: null,
  created_at: "2024-01-01T00:00:00Z",
};

export const taskList = [pendingTask, completedTask];

export const sampleNote: Note = {
  id: "note-1",
  title: "Testing checklist",
  body: "- Install Vitest\n- Write fixtures",
  tags: "testing",
  source_session_id: "sess-1",
  source_message_id: "msg-1",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};
