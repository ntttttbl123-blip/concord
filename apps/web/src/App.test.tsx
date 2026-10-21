import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./ui";

describe("dashboard test harness", () => {
  it("renders a Badge with accessible text", () => {
    render(<Badge tone="ok">Reconciled</Badge>);
    expect(screen.getByText("Reconciled")).toBeInTheDocument();
  });
});
