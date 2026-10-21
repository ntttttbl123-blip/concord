import { expect, test } from "@playwright/test";

interface Fixtures {
  contractId: string;
  holder: string;
  registerCsv: string;
}

const NOTE = "Checked against the transfer agent's file";

/**
 * One pass through the flow the dashboard exists for: create a workspace, watch an asset on the
 * FakeChain-backed server, import a register that disagrees, sign the break off, and reload to see
 * the sign-off kept. No request may leave 127.0.0.1: the chain is FakeChain and the dashboard is
 * served by the same process.
 */
test("sign up, watch an asset, import a register, sign off a break, and keep it", async ({ page, request }) => {
  const response = await request.get("/__e2e__/fixtures");
  expect(response.ok()).toBe(true);
  const fixtures = (await response.json()) as Fixtures;

  const external: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "127.0.0.1") {
      external.push(req.url());
    }
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Create one" }).click();

  await page.getByLabel("Your name").fill("E2E User");
  await page.getByLabel("Work email").fill("e2e@concord.test");
  await page.getByLabel("Workspace name").fill("E2E Workspace");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page.getByRole("heading", { name: "Watched assets" })).toBeVisible();

  // Watch the seeded contract token. The e2e server answers the metadata lookup, so the form
  // never needs the decimals prompt or a call to a public RPC.
  await page.getByRole("button", { name: "Watch asset" }).click();
  await page.getByLabel("Asset on Testnet").fill(fixtures.contractId);
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText(/^Contract token on /)).toBeVisible();
  await page.getByLabel("Display name").fill("E2E Fund");
  await page.getByRole("button", { name: "Watch asset" }).click();

  // The asset is recorded immediately and indexed in the background; the register form appears
  // once that first pass has finished.
  const importButton = page.getByRole("button", { name: "Import and reconcile" });
  await expect(importButton).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Register export").setInputFiles({
    name: "register.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(fixtures.registerCsv),
  });
  await importButton.click();

  const breakRow = page.getByRole("row", { name: /Quantity mismatch/ }).first();
  await expect(breakRow).toBeVisible();
  await breakRow.getByRole("button", { name: "Review" }).click();
  await page.getByLabel("Note").fill(NOTE);
  await page.getByRole("button", { name: "Resolve" }).click();

  await expect(breakRow.getByText("Resolved", { exact: true })).toBeVisible();

  // A reload throws away every bit of client state; the note has to come back from the server.
  await page.reload();
  const kept = page.getByRole("row", { name: /Quantity mismatch/ }).first();
  await expect(kept.getByText("Resolved", { exact: true })).toBeVisible();
  await kept.getByRole("button", { name: "Review" }).click();
  await expect(page.getByLabel("Note")).toHaveValue(NOTE);

  expect(external, "the smoke test must not reach the network").toEqual([]);
});
