import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { TasksRoute } from "../TasksRoute";

const tasks = [
  {
    id: "task-open",
    title: "Ship release",
    body: "Run the release gates",
    due_at: "2020-01-01",
    completed_at: null,
    priority: 3,
    session_id: null,
    created_at: "now",
  },
  {
    id: "task-done",
    title: "Write notes",
    body: null,
    due_at: null,
    completed_at: "2026-08-01T00:00:00Z",
    priority: 1,
    session_id: null,
    created_at: "now",
  },
];

describe("TasksRoute", () => {
  beforeEach(() => {
    vi.spyOn(api, "listTasks").mockResolvedValue(tasks);
    vi.spyOn(api, "upsertTask").mockResolvedValue("task-new");
    vi.spyOn(api, "completeTask").mockResolvedValue(undefined);
    vi.spyOn(api, "deleteTask").mockResolvedValue(undefined);
  });

  it("renders task fields and filters completed and overdue work", async () => {
    render(
      <MemoryRouter>
        <TasksRoute />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Run the release gates")).toBeInTheDocument();
    expect(screen.getByText("overdue")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(screen.getByText("Write notes")).toBeInTheDocument();
    expect(screen.queryByText("Ship release")).not.toBeInTheDocument();
  });

  it("creates and edits tasks with body, due date, and priority", async () => {
    render(
      <MemoryRouter>
        <TasksRoute />
      </MemoryRouter>,
    );
    await screen.findByText("Ship release");

    fireEvent.change(screen.getByPlaceholderText("New task…"), { target: { value: "New task" } });
    fireEvent.change(screen.getByPlaceholderText("Details (optional)"), { target: { value: "Body" } });
    fireEvent.change(screen.getByLabelText("New task due date"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.upsertTask).toHaveBeenCalledWith({
      title: "New task",
      body: "Body",
      due_at: "2026-09-01",
      priority: 0,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Edit Ship release" }));
    const editTitle = screen.getByDisplayValue("Ship release");
    fireEvent.change(editTitle, { target: { value: "Ship RC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      id: "task-open",
      title: "Ship RC",
    })));
  });
});
