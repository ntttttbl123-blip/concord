
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Team } from "./api";
import { Settings } from "./Settings";

const { mockMe, mockAdopt } = vi.hoisted(() => ({
  mockMe: {
    user: {
      id: "user-owner",
      email: "owner@example.com",
      name: "Workspace Owner",
      hasPassword: true,
      hasGoogle: false,
    },
    org: { id: "org-1", name: "Test Workspace" },
    role: "owner" as const,
    orgs: [{ id: "org-1", name: "Test Workspace", role: "owner" as const }],
  },
  mockAdopt: vi.fn(),
}));

vi.mock("./api", () => ({
  api: vi.fn(),
}));

vi.mock("./session", () => ({
  useMe: () => mockMe,
  useSession: () => ({
    config: { google: false },
    adopt: mockAdopt,
  }),
}));

const team: Team = {
  members: [
    {
      id: "user-owner",
      email: "owner@example.com",
      name: "Workspace Owner",
      role: "owner",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "user-member",
      email: "member@example.com",
      name: "Test Member",
      role: "member",
      joinedAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  invites: [],
};

function renderSettings() {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/org/members") return team as never;
    return {} as never;
  });

  return render(<Settings query={new URLSearchParams()} />);
}

describe("team member removal confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows confirmation without sending a DELETE request", async () => {
    const user = userEvent.setup();
    renderSettings();

    await screen.findByText("Test Member");

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      screen.getByText(/Remove Test Member\?/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/account will be deleted if they belong to no other workspace/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    expect(api).not.toHaveBeenCalledWith(
      "/org/members/user-member",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("cancels removal without sending a DELETE request", async () => {
    const user = userEvent.setup();
    renderSettings();

    await screen.findByText("Test Member");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm" }),
    ).not.toBeInTheDocument();

    expect(api).not.toHaveBeenCalledWith(
      "/org/members/user-member",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends the DELETE request only after confirmation", async () => {
    const user = userEvent.setup();
    renderSettings();

    await screen.findByText("Test Member");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(api).not.toHaveBeenCalledWith(
      "/org/members/user-member",
      expect.objectContaining({ method: "DELETE" }),
    );

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        "/org/members/user-member",
        { method: "DELETE" },
      );
    });
  });
});
