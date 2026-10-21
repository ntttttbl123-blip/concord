import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";
const assetId = `C${"A".repeat(55)}`;
const me = {
  user: { id: "user-1", email: "owner@example.test", name: "Workspace owner", hasPassword: true, hasGoogle: false },
  org: { id: "org-1", name: "Example workspace" },
  role: "owner",
  orgs: [{ id: "org-1", name: "Example workspace", role: "owner" }],
};
const asset = {
  id: assetId,
  network: "mainnet",
  code: "DEMO",
  name: "Demo asset",
  decimals: 7,
  state: "ready",
  startMode: "window",
  startLedger: 1,
  syncedLedger: 100,
  ignore: [],
  supply: "0",
  holderCount: 0,
  eventCount: 0,
  incomplete: false,
  lastRun: null,
  openBreaks: { reconciliation: 0, controls: 0, actions: 0 },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    let body: unknown = {};
    if (path === "/auth/config") {
      body = { signup: "open", google: false, ephemeral: false, networks: ["mainnet", "testnet"], defaultNetwork: "mainnet" };
    } else if (path === "/auth/session") {
      body = { me: new URL(route.request().url()).hash ? null : me };
    } else if (path === "/overview") {
      body = { networks: ["mainnet", "testnet"], assets: [asset] };
    } else if (path === "/org/members") {
      body = { members: [], invites: [] };
    } else if (path.endsWith("/holdings")) {
      body = { asOf: null, ledger: 100, supply: "0", holderCount: 0, incomplete: [], holders: [] };
    } else if (path.endsWith("/controls")) {
      body = { asOf: null, summary: { controls: 0, instructed: 0, uninstructed: 0, unexecuted: 0, pending: 0 }, records: [], pending: [], breaks: [], openBreaks: 0 };
    } else if (/\/assets\/[^/]+\/(events|actions|reconciliations|registers|instructions|journal)$/.test(path)) {
      body = [];
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
});

async function expectNoSeriousA11yViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  // No current violations are allow-listed: add a narrowly scoped exception with a reason if one is unavoidable.
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test("sign-in screen has no serious or critical accessibility violations", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ me: null }) }));
  await page.goto(`${baseURL}/#/signin`);
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test("overview, settings, and every asset tab have no serious or critical accessibility violations", async ({ page }) => {
  const routes = [
    ["overview", "#/"],
    ["settings", "#/settings"],
    ["reconciliation", `#/a/${assetId}/reconciliation`],
    ["holdings", `#/a/${assetId}/holdings`],
    ["actions", `#/a/${assetId}/actions`],
    ["controls", `#/a/${assetId}/controls`],
    ["events", `#/a/${assetId}/events`],
    ["export", `#/a/${assetId}/export`],
  ] as const;
  for (const [label, hash] of routes) {
    await page.goto(`${baseURL}/${hash}`);
    if (label === "overview") await expect(page.getByRole("heading", { name: "Watched assets" })).toBeVisible();
    else if (label === "settings") await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    else await expect(page.getByRole("heading", { name: "Demo asset" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  }
});
