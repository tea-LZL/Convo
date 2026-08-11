import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RouteShell } from "../RouteShell";

describe("RouteShell", () => {
  it("provides a consistent heading, description, actions, and scroll region", () => {
    render(
      <RouteShell title="Workspace" description="A focused route" actions={<button>Action</button>}>
        <p>Content</p>
      </RouteShell>,
    );
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByText("A focused route")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
  });
});
