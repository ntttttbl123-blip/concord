import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { StellarSource } from "../src/chain.js";
import { Concord } from "../src/concord.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { createServerApp } from "../src/main.js";
import { CONTROL_MIGRATIONS, ORG_MIGRATIONS } from "../src/schema.js";
import { Tenants, fileStore, memoryStore } from "../src/tenants.js";
import { Client, FakeChain, MAINNET_PASSPHRASE, ORIGIN, PASSPHRASE, at, harness, key, u, type Harness } from "./helpers.js";

/** Strings that exist only in workspace A. None may ever reach workspace B. */
const MARKERS = ["ALPHA-HOLDER-7", "Northgate Secret Trust", "alpha sign-off note", "J-ALPHA", "I-ALPHA", "Alpha Capital"];

interface Seeded {
  h: Harness;
  a: Client;
  b: Client;
  assetId: string;
  issuer: string;
  holder: string;
  runId: number;
  registerId: number;
  actionId: number;
}

/** Workspace A with books in every table; workspace B empty. */
async function seed(): Promise<Seeded> {
  const h = harness();
  const a = await new Client(h.app).signUp("ann@alpha.test", "Alpha Capital", "Ann Alpha");
  const b = await new Client(h.app).signUp("bob@beta.test", "Beta Partners", "Bob Beta");
  const issuer = key();
  const holder = key();
  const ws = h.tenants.forOrg(a.orgId);
  const asset = await ws.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
  h.chain.push(asset.id, "mint", 3, { to: holder, amount: u(100) });
  h.chain.push(asset.id, "clawback", 5, { from: holder, amount: u(1) });
  const imported = await a.json<{ registerId: number; run: { id: number; breaks: Array<{ key: string; fingerprint: string }> } }>(
    "/api/assets/FUND/registers",
    { body: { csv: `holder_id,holder_name,account,units\nALPHA-HOLDER-7,Northgate Secret Trust,${holder},90\n`, asOf: at(40) } },
  );
  await a.json("/api/assets/FUND/journal", {
    body: { csv: `ref,date,type,from_account,to_account,units\nJ-ALPHA,${at(3)},issue,,${holder},100\n` },
  });
  await a.json("/api/assets/FUND/instructions", {
    body: { csv: `ref,type,account,units,issued_at\nI-ALPHA,clawback,${holder},1,${at(4)}\n` },
  });
  const brk = imported.run.breaks[0]!;
  await a.json("/api/assets/FUND/notes", {
    method: "PUT",
    body: { scope: "recon", key: brk.key, fingerprint: brk.fingerprint, status: "acknowledged", note: "alpha sign-off note" },
  });
  const action = await a.json<{ id: number }>("/api/assets/FUND/actions", {
    body: { type: "split", recordTime: at(10), num: "2", den: "1" },
  });
  return { h, a, b, assetId: asset.id, issuer, holder, runId: imported.run.id, registerId: imported.registerId, actionId: action.id };
}

type Probe = { method: string; path: string; body?: unknown };

/** One request per workspace route, aimed at workspace A's ids. */
function probes(s: Seeded): Record<string, Probe> {
  const id = s.assetId;
  const p = (method: string, path: string, body?: unknown): Probe => ({ method, path, ...(body === undefined ? {} : { body }) });
  return {
    "GET /api/org/members": p("GET", "/api/org/members"),
    "POST /api/org/invites": p("POST", "/api/org/invites", { email: "new@beta.test" }),
    "DELETE /api/org/invites/:inviteId": p("DELETE", "/api/org/invites/0000000000000000"),
    "PATCH /api/org/members/:userId": p("PATCH", `/api/org/members/${s.a.userId}`, { role: "member" }),
    "DELETE /api/org/members/:userId": p("DELETE", `/api/org/members/${s.a.userId}`),
    "PATCH /api/org": p("PATCH", "/api/org", { name: "Beta Partners" }),
    "DELETE /api/org": p("DELETE", "/api/org", { confirm: "Alpha Capital" }),
    "GET /api/overview": p("GET", "/api/overview"),
    "GET /api/lookup": p("GET", "/api/lookup?network=testnet&code=FUND"),
    "POST /api/assets": p("POST", "/api/assets", { network: "testnet", asset: "not an asset" }),
    "GET /api/assets/:id": p("GET", `/api/assets/${id}`),
    "PATCH /api/assets/:id": p("PATCH", `/api/assets/${id}`, { name: "stolen" }),
    "DELETE /api/assets/:id": p("DELETE", `/api/assets/${id}`),
    "POST /api/assets/:id/sync": p("POST", `/api/assets/${id}/sync`),
    "POST /api/assets/:id/rebuild": p("POST", `/api/assets/${id}/rebuild`),
    "GET /api/assets/:id/holdings": p("GET", `/api/assets/${id}/holdings`),
    "GET /api/assets/:id/events": p("GET", `/api/assets/${id}/events`),
    "GET /api/templates/:kind": p("GET", "/api/templates/register"),
    "GET /api/assets/:id/registers": p("GET", `/api/assets/${id}/registers`),
    "POST /api/assets/:id/registers": p("POST", `/api/assets/${id}/registers`, { csv: "holder_id,units\nX,1\n", asOf: at(1) }),
    "DELETE /api/assets/:id/registers/:registerId": p("DELETE", `/api/assets/${id}/registers/${s.registerId}`),
    "POST /api/assets/:id/journal": p("POST", `/api/assets/${id}/journal`, { csv: "ref,date,type,units\n" }),
    "POST /api/assets/:id/instructions": p("POST", `/api/assets/${id}/instructions`, { csv: "ref,type,account,issued_at\n" }),
    "GET /api/assets/:id/reconciliations": p("GET", `/api/assets/${id}/reconciliations`),
    "POST /api/assets/:id/reconciliations": p("POST", `/api/assets/${id}/reconciliations`, { registerId: s.registerId }),
    "GET /api/reconciliations/:id": p("GET", `/api/reconciliations/${s.runId}`),
    "GET /api/assets/:id/actions": p("GET", `/api/assets/${id}/actions`),
    "POST /api/assets/:id/actions": p("POST", `/api/assets/${id}/actions`, { type: "split", recordTime: at(1), num: "2", den: "1" }),
    "GET /api/actions/:id": p("GET", `/api/actions/${s.actionId}`),
    "POST /api/actions/:id/reconcile": p("POST", `/api/actions/${s.actionId}/reconcile`),
    "GET /api/assets/:id/controls": p("GET", `/api/assets/${id}/controls`),
    "PUT /api/assets/:id/notes": p("PUT", `/api/assets/${id}/notes`, { scope: "recon", key: "k", fingerprint: "f", status: "resolved", note: "n" }),
    "GET /api/assets/:id/export": p("GET", `/api/assets/${id}/export`),
  };
}

/** Routes that answer without a session, by design. */
const PUBLIC = new Set([
  "GET /api/health",
  "GET /api/auth/config",
  "GET /api/auth/me",
  "GET /api/auth/session",
  "POST /api/auth/signup",
  "POST /api/auth/signin",
  "POST /api/auth/signout",
  "POST /api/auth/password",
  "POST /api/auth/switch-org",
  "POST /api/auth/invites/lookup",
  "POST /api/auth/invites/accept",
  "POST /api/auth/reset",
  "GET /api/auth/google/start",
  "GET /api/auth/google/callback",
]);

function workspaceRoutes(h: Harness): string[] {
  const seen = new Set<string>();
  for (const route of h.app.routes) {
    if (route.method === "ALL" || route.path.endsWith("*")) continue;
    const name = `${route.method} ${route.path}`;
    if (!PUBLIC.has(name)) seen.add(name);
  }
  return [...seen];
}

describe("workspace isolation", () => {
  it("answers every workspace route for another tenant's ids with nothing of theirs", async () => {
    const s = await seed();
    const table = probes(s);
    const routes = workspaceRoutes(s.h);
    // A route added without a probe here fails the suite, so it cannot ship unexamined.
    expect(routes.filter((r) => !table[r])).toEqual([]);
    expect(routes.length).toBeGreaterThan(25);

    for (const name of routes) {
      const probe = table[name]!;
      const res = await s.b.call(probe.path, { method: probe.method, ...(probe.body === undefined ? {} : { body: probe.body }) });
      const text = await res.text();
      for (const marker of [...MARKERS, s.holder]) expect(text, `${name} leaked ${marker}`).not.toContain(marker);
      if (probe.path.includes(s.assetId) || /\/(reconciliations|actions)\/\d+/.test(probe.path)) {
        expect(res.status, name).toBe(404);
      }
    }
    // Workspace A is exactly as it was.
    const run = await s.a.json<{ breaks: Array<{ note: string; holderIds: string[] }> }>(`/api/reconciliations/${s.runId}`);
    expect(run.breaks[0]).toMatchObject({ note: "alpha sign-off note", holderIds: ["ALPHA-HOLDER-7"] });
    const members = await s.a.json<{ members: Array<{ email: string; role: string }> }>("/api/org/members");
    expect(members.members).toEqual([expect.objectContaining({ email: "ann@alpha.test", role: "owner" })]);
    expect((await s.a.json<{ name: string }>(`/api/assets/${s.assetId}`)).name).toBe("FUND");
  });

  it("turns away every workspace route without a session", async () => {
    const s = await seed();
    const anonymous = new Client(s.h.app);
    for (const [name, probe] of Object.entries(probes(s))) {
      const res = await anonymous.call(probe.path, { method: probe.method, ...(probe.body === undefined ? {} : { body: probe.body }) });
      expect(res.status, name).toBe(401);
    }
  });

  it("keeps two workspaces watching the same contract apart", async () => {
    const s = await seed();
    const wsB = s.h.tenants.forOrg(s.b.orgId);
    const theirs = await wsB.watchAsset({ network: "testnet", asset: `FUND:${s.issuer}`, fromLedger: 4, ignore: [s.holder] });
    expect(theirs.id).toBe(s.assetId);
    await wsB.sync(theirs.id);

    // B started later, so it never saw the mint at ledger 3.
    const b = await s.b.json<{ holders: Array<{ units: string; ignored: boolean }> }>("/api/assets/FUND/holdings");
    expect(b.holders).toEqual([expect.objectContaining({ units: "-1", ignored: true })]);
    const a = await s.a.json<{ holders: Array<{ units: string; ignored: boolean }> }>("/api/assets/FUND/holdings");
    expect(a.holders).toEqual([expect.objectContaining({ units: "99", ignored: false })]);

    expect(await s.b.json("/api/assets/FUND/registers")).toEqual([]);
    expect(await s.b.json("/api/assets/FUND/reconciliations")).toEqual([]);
    expect(await s.b.json("/api/assets/FUND/actions")).toEqual([]);

    // Both now own a "run 1"; each sees only its own.
    const imported = await s.b.json<{ run: { id: number; registerSha256: string } }>("/api/assets/FUND/registers", {
      body: { csv: "holder_id,units\nBETA-1,5\n", asOf: at(40) },
    });
    expect(imported.run.id).toBe(s.runId);
    const runA = await s.a.json<{ registerSha256: string }>(`/api/reconciliations/${s.runId}`);
    const runB = await s.b.json<{ registerSha256: string }>(`/api/reconciliations/${s.runId}`);
    expect(runB.registerSha256).toBe(imported.run.registerSha256);
    expect(runB.registerSha256).not.toBe(runA.registerSha256);

    const packA = await s.a.json<{ sha256: string }>("/api/assets/FUND/export");
    const packB = await s.b.json<{ sha256: string }>("/api/assets/FUND/export");
    expect(packA.sha256).not.toBe(packB.sha256);
    expect(JSON.stringify(packB)).not.toContain("ALPHA-HOLDER-7");
  });

  it("opens only workspaces it knows, under ids it generated", () => {
    const h = harness();
    for (const bad of ["../x", "..%2Fx", "", "ZZZZZZZZZZZZZZZZ", "0123456789abcdef"]) {
      expect(() => h.tenants.forOrg(bad), bad).toThrow(/no such workspace/);
    }
    expect(() => h.tenants.forOrg(undefined as unknown as string)).toThrow(/no such workspace/);
  });

  it("refuses a database that belongs to another workspace", () => {
    const shared = new Db(":memory:", ORG_MIGRATIONS);
    const tenants = new Tenants({ open: () => shared, remove: () => {} }, {}, () => true, () => []);
    tenants.forOrg("aaaaaaaaaaaaaaaa");
    const again = new Tenants({ open: () => shared, remove: () => {} }, {}, () => true, () => []);
    expect(() => again.forOrg("bbbbbbbbbbbbbbbb")).toThrow(/belongs to aaaaaaaaaaaaaaaa/);
  });

  it("deletes SQLite db/WAL/SHM files and only reopens an explicitly known org (#500)", () => {
    // Exercise the real file store, not the in-memory store used for route tests.
    const temp = mkdtempSync(join(tmpdir(), "concord-tenant-drop-"));
    const orgDir = join(temp, "orgs");
    const alpha = "aaaaaaaaaaaaaaaa";
    const beta = "bbbbbbbbbbbbbbbb";
    const stale = "cccccccccccccccc";
    const known = new Set([alpha, beta]);
    const tenants = new Tenants(fileStore(temp), {}, (id) => known.has(id), () => [...known]);
    const paths = (id: string) => [`${id}.db`, `${id}.db-wal`, `${id}.db-shm`];
    const files = () => readdirSync(orgDir).sort();

    try {
      const alphaDb = tenants.forOrg(alpha).db;
      const betaDb = tenants.forOrg(beta).db;
      alphaDb.run("INSERT INTO meta (key, value) VALUES ('sample', 'ALPHA ONLY')");
      betaDb.run("INSERT INTO meta (key, value) VALUES ('sample', 'BETA ONLY')");

      // SQLite holds its WAL and shared-memory files while both handles are open.
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());

      // Invalid path-like ids cannot delete an unrelated file.
      const sentinel = join(temp, "x.db");
      writeFileSync(sentinel, "not a workspace");
      tenants.drop("../x");
      expect(existsSync(sentinel)).toBe(true);
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());

      tenants.drop(alpha);
      expect(files()).toEqual(paths(beta).sort());
      expect(betaDb.get<{ value: string }>("SELECT value FROM meta WHERE key = 'sample'")?.value).toBe("BETA ONLY");

      known.delete(alpha);
      expect(() => tenants.forOrg(alpha)).toThrow(/no such workspace/);
      expect(files()).toEqual(paths(beta).sort()); // rejected reopen creates nothing

      known.add(alpha);
      const fresh = tenants.forOrg(alpha).db;
      expect(fresh.get("SELECT value FROM meta WHERE key = 'sample'")).toBeUndefined();
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());

      // A never-opened id can still have stale on-disk artifacts after a crash.
      for (const name of paths(stale)) writeFileSync(join(orgDir, name), "stale");
      tenants.drop(stale);
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());
    } finally {
      tenants.close();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("deletes a workspace without touching its neighbour", async () => {
    const s = await seed();
    await s.b.json("/api/assets", { body: { network: "testnet", asset: `KEEP:${key()}` } }).catch(() => undefined);
    const wrong = await s.a.call("/api/org", { method: "DELETE", body: { confirm: "alpha capital" } });
    expect(wrong.status).toBe(400);
    expect((await s.a.call("/api/org", { method: "DELETE", body: { confirm: "Alpha Capital" } })).status).toBe(200);
    expect(s.h.removed).toEqual([s.a.orgId]);
    expect((await s.a.call("/api/overview")).status).toBe(401);
    expect(() => s.h.tenants.forOrg(s.a.orgId)).toThrow(/no such workspace/);
    // The sole member's account went with it, so the address is free again.
    expect((await new Client(s.h.app).call("/api/auth/signin", { body: { email: "ann@alpha.test", password: "correct horse battery" } })).status).toBe(401);
    expect((await s.b.call("/api/overview")).status).toBe(200);
  });
});

describe("accounts and sessions", () => {
  it("sets a session cookie script cannot read, and a stricter one over https", async () => {
    const h = harness();
    const res = await h.app.request("/api/auth/signup", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.test", name: "A", password: "correct horse battery", orgName: "A" }),
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^concord_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toMatch(/Secure/i);

    const tls = harness({ publicUrl: "https://concord.example" });
    const secure = await tls.app.request("/api/auth/signup", {
      method: "POST",
      headers: { origin: "https://concord.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.test", name: "A", password: "correct horse battery", orgName: "A" }),
    });
    const strict = secure.headers.getSetCookie()[0]!;
    expect(strict).toMatch(/^__Host-concord_session=/);
    expect(strict).toMatch(/Secure/i);
    expect(strict).toMatch(/Path=\//i);
  });

  it("refuses state-changing requests that do not come from its own pages", async () => {
    const h = harness();
    const body = { email: "a@example.test", name: "A", password: "correct horse battery", orgName: "A" };
    expect((await new Client(h.app, null).call("/api/auth/signup", { body })).status).toBe(403);
    expect((await new Client(h.app, "https://evil.example").call("/api/auth/signup", { body })).status).toBe(403);
    const crossSite = await h.app.request("/api/auth/signup", {
      method: "POST",
      headers: { origin: ORIGIN, "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(crossSite.status).toBe(403);
    // A form post dressed as JSON is turned away even from the right origin.
    const form = await h.app.request("/api/auth/signup", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify(body),
    });
    expect(form.status).toBe(400);
    expect((await h.app.request("/api/auth/config")).headers.get("cache-control")).toBe("no-store");
  });

  it("checks passwords, hides which emails exist, and slows guessing", async () => {
    const h = harness();
    await new Client(h.app).signUp("ann@example.test", "Ann");
    const client = new Client(h.app);
    const weak = await client.call("/api/auth/signup", { body: { email: "b@example.test", name: "B", password: "short", orgName: "B" } });
    expect(weak.status).toBe(400);
    const dup = await client.call("/api/auth/signup", { body: { email: "ANN@example.test", name: "B", password: "correct horse battery", orgName: "B" } });
    expect(dup.status).toBe(409);

    const unknown = await client.call("/api/auth/signin", { body: { email: "nobody@example.test", password: "correct horse battery" } });
    const wrong = await client.call("/api/auth/signin", { body: { email: "ann@example.test", password: "incorrect horse" } });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());

    for (let i = 0; i < 9; i++) await client.call("/api/auth/signin", { body: { email: "ann@example.test", password: "nope nope nope" } });
    const locked = await client.call("/api/auth/signin", { body: { email: "ann@example.test", password: "correct horse battery" } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("ends other sessions on a password change and expires idle ones", async () => {
    const h = harness();
    const first = await new Client(h.app).signUp("ann@example.test", "Ann");
    const second = new Client(h.app);
    await second.json("/api/auth/signin", { body: { email: "ann@example.test", password: "correct horse battery" } });
    expect((await first.call("/api/auth/password", { body: { current: "wrong", next: "another long password" } })).status).toBe(400);
    await first.json("/api/auth/password", { body: { current: "correct horse battery", next: "another long password" } });
    expect((await second.call("/api/auth/me")).status).toBe(401);
    expect((await first.call("/api/auth/me")).status).toBe(200);

    h.now.value += 8 * 86_400_000;
    expect((await first.call("/api/auth/me")).status).toBe(401);
  });

  it("signs out", async () => {
    const h = harness();
    const client = await new Client(h.app).signUp("ann@example.test", "Ann");
    expect(await client.json("/api/auth/session")).toMatchObject({ me: { user: { email: "ann@example.test" } } });
    expect(await new Client(h.app).json("/api/auth/session")).toEqual({ me: null });
    await client.json("/api/auth/signout", { method: "POST" });
    expect(client.cookies.size).toBe(0);
    expect((await client.call("/api/overview")).status).toBe(401);
  });

  it("asks for a code when sign-up is by invitation of the operator", async () => {
    const h = harness({ signup: "code" });
    const body = { email: "a@example.test", name: "A", password: "correct horse battery", orgName: "A" };
    expect((await new Client(h.app).call("/api/auth/signup", { body })).status).toBe(403);
    const code = h.auth.createSignupCode("for A");
    expect((await new Client(h.app).call("/api/auth/signup", { body: { ...body, code } })).status).toBe(201);
    const reuse = await new Client(h.app).call("/api/auth/signup", { body: { ...body, email: "b@example.test", code } });
    expect(reuse.status).toBe(403);
  });

  it("lets the operator issue a one-time reset link", async () => {
    const h = harness();
    const old = await new Client(h.app).signUp("ann@example.test", "Ann");
    const token = h.auth.createResetToken("ann@example.test");
    const fresh = new Client(h.app);
    expect((await fresh.call("/api/auth/reset", { body: { token, password: "a brand new password" } })).status).toBe(200);
    expect((await fresh.call("/api/auth/me")).status).toBe(200);
    expect((await old.call("/api/auth/me")).status).toBe(401);
    expect((await new Client(h.app).call("/api/auth/reset", { body: { token, password: "yet another password" } })).status).toBe(400);
  });
});

describe("teams", () => {
  async function team() {
    const h = harness();
    const owner = await new Client(h.app).signUp("ann@alpha.test", "Alpha", "Ann");
    const invite = await owner.json<{ id: string; link: string }>("/api/org/invites", { body: { email: "cat@alpha.test" } });
    const token = invite.link.split("/#/invite/")[1]!;
    return { h, owner, token, invite };
  }

  it("admits a new person by invitation, once, as the invited address", async () => {
    const { h, owner, token } = await team();
    const looked = await new Client(h.app).json("/api/auth/invites/lookup", { body: { token } });
    expect(looked).toEqual({ org: "Alpha", email: "cat@alpha.test", role: "member", hasAccount: false });

    const cat = new Client(h.app);
    const joined = await cat.json<{ org: { id: string }; role: string; user: { email: string } }>("/api/auth/invites/accept", {
      body: { token, name: "Cat", password: "correct horse battery" },
    });
    expect(joined).toMatchObject({ org: { id: owner.orgId }, role: "member", user: { email: "cat@alpha.test" } });
    expect((await new Client(h.app).call("/api/auth/invites/accept", { body: { token, name: "X", password: "correct horse battery" } })).status).toBe(400);

    // A member works in the workspace but cannot run it.
    expect((await cat.call("/api/overview")).status).toBe(200);
    expect((await cat.call("/api/org/invites", { body: { email: "dan@alpha.test" } })).status).toBe(403);
    expect((await cat.call("/api/org", { method: "PATCH", body: { name: "Mine" } })).status).toBe(403);
    expect((await cat.call(`/api/org/members/${owner.userId}`, { method: "DELETE" })).status).toBe(403);
  });

  it("expires invitations and lets an owner withdraw them", async () => {
    const { h, owner, token, invite } = await team();
    h.now.value += 8 * 86_400_000;
    // The owner's own session has idled out by now too; sign in again.
    await owner.json("/api/auth/signin", { body: { email: "ann@alpha.test", password: "correct horse battery" } });
    expect((await new Client(h.app).call("/api/auth/invites/lookup", { body: { token } })).status).toBe(400);

    const fresh = await owner.json<{ id: string; link: string }>("/api/org/invites", { body: { email: "cat@alpha.test" } });
    expect(fresh.id).not.toBe(invite.id);
    await owner.json(`/api/org/invites/${fresh.id}`, { method: "DELETE" });
    const gone = await new Client(h.app).call("/api/auth/invites/lookup", { body: { token: fresh.link.split("/#/invite/")[1] } });
    expect(gone.status).toBe(400);
  });

  it("never lets an invitation open or re-key an existing account", async () => {
    const { h, owner, token } = await team();
    const cat = await new Client(h.app).signUp("cat@alpha.test", "Cat's own", "Cat");

    const stranger = new Client(h.app);
    const hijack = await stranger.call("/api/auth/invites/accept", { body: { token, name: "Mallory", password: "mallory's password" } });
    expect(hijack.status).toBe(401);
    expect((await stranger.call("/api/auth/signin", { body: { email: "cat@alpha.test", password: "mallory's password" } })).status).toBe(401);
    // Signed in as someone else is not enough either.
    expect((await owner.call("/api/auth/invites/accept", { body: { token } })).status).toBe(401);

    const joined = await cat.json<{ org: { id: string }; orgs: unknown[] }>("/api/auth/invites/accept", { body: { token } });
    expect(joined.org.id).toBe(owner.orgId);
    expect(joined.orgs).toHaveLength(2);

    // A tab still showing the old workspace is told so instead of acting on the new one.
    const stale = await cat.call("/api/overview", { headers: { "x-concord-org": cat.orgId } });
    expect(stale.status).toBe(409);
    expect((await cat.call("/api/auth/switch-org", { body: { orgId: "ffffffffffffffff" } })).status).toBe(403);
    const back = await cat.json<{ org: { id: string } }>("/api/auth/switch-org", { body: { orgId: cat.orgId } });
    expect(back.org.id).toBe(cat.orgId);
  });

  it("cuts off a removed member at once and keeps a workspace owned", async () => {
    const { h, owner, token } = await team();
    const cat = new Client(h.app);
    const me = await cat.json<{ user: { id: string } }>("/api/auth/invites/accept", { body: { token, name: "Cat", password: "correct horse battery" } });
    expect((await owner.call(`/api/org/members/${owner.userId}`, { method: "DELETE" })).status).toBe(400);
    await owner.json(`/api/org/members/${me.user.id}`, { method: "DELETE" });
    expect((await cat.call("/api/overview")).status).toBe(401);
    expect((await cat.call("/api/auth/signin", { body: { email: "cat@alpha.test", password: "correct horse battery" } })).status).toBe(401);
  });
});

describe("Google sign-in", () => {
  const google = { clientId: "client-123", clientSecret: "shh" };

  function idToken(claims: Record<string, unknown>): string {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return `${part({ alg: "RS256" })}.${part(claims)}.sig`;
  }

  async function begin(h: Harness, client: Client, query = "") {
    const res = await client.call(`/api/auth/google/start${query}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    return { state: to.searchParams.get("state")!, nonce: to.searchParams.get("nonce")! };
  }

  function withGoogle(claims: (nonce: string) => Record<string, unknown>) {
    const box: { nonce: string; sent?: URLSearchParams } = { nonce: "" };
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      box.sent = init?.body as URLSearchParams;
      return new Response(JSON.stringify({ id_token: idToken(claims(box.nonce)) }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { h: harness({ google, fetch }), box };
  }

  const good = (email: string, extra: Record<string, unknown> = {}) => (nonce: string) => ({
    iss: "https://accounts.google.com",
    aud: google.clientId,
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce,
    sub: `sub-${email}`,
    email,
    email_verified: true,
    name: "Gail Example",
    ...extra,
  });

  it("is not offered unless configured", async () => {
    const h = harness();
    expect(await (await h.app.request("/api/auth/config")).json()).toMatchObject({ google: false });
    expect((await h.app.request("/api/auth/google/start")).status).toBe(404);
  });

  it("creates an account and workspace on first use, and signs in after", async () => {
    const { h, box } = withGoogle(good("gail@example.test"));
    expect(await (await h.app.request("/api/auth/config")).json()).toMatchObject({ google: true });
    const client = new Client(h.app);
    const { state, nonce } = await begin(h, client);
    box.nonce = nonce;
    const done = await client.call(`/api/auth/google/callback?code=abc&state=${state}`);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/#/`);
    expect(box.sent!.get("code_verifier")).toBeTruthy();
    const me = await client.json<{ user: { email: string; hasGoogle: boolean; hasPassword: boolean }; org: { name: string }; role: string }>("/api/auth/me");
    expect(me).toMatchObject({ user: { email: "gail@example.test", hasGoogle: true, hasPassword: false }, org: { name: "Gail's workspace" }, role: "owner" });

    const again = new Client(h.app);
    const second = await begin(h, again);
    box.nonce = second.nonce;
    await again.call(`/api/auth/google/callback?code=abc&state=${second.state}`);
    expect((await again.json<{ org: { id: string } }>("/api/auth/me")).org).toEqual(me.org);
  });

  it("will not merge into a password account nobody proved they own", async () => {
    const { h, box } = withGoogle(good("ann@example.test"));
    await new Client(h.app).signUp("ann@example.test", "Squatter's");
    const client = new Client(h.app);
    const { state, nonce } = await begin(h, client);
    box.nonce = nonce;
    const done = await client.call(`/api/auth/google/callback?code=abc&state=${state}`);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/#/signin?error=google_exists`);
    expect((await client.call("/api/auth/me")).status).toBe(401);
  });

  it("connects Google to the signed-in account that shares its address", async () => {
    const { h, box } = withGoogle(good("ann@example.test"));
    const ann = await new Client(h.app).signUp("ann@example.test", "Ann");
    const { state, nonce } = await begin(h, ann, "?link=1");
    box.nonce = nonce;
    const done = await ann.call(`/api/auth/google/callback?code=abc&state=${state}`);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/#/settings?linked=google`);
    expect((await ann.json<{ user: { hasGoogle: boolean } }>("/api/auth/me")).user.hasGoogle).toBe(true);
    // Connecting needs a session at the start.
    expect((await new Client(h.app).call("/api/auth/google/start?link=1")).status).toBe(401);
  });

  it("rejects a forged state, a stale token and an unverified address", async () => {
    const forged = withGoogle(good("gail@example.test"));
    const c1 = new Client(forged.h.app);
    const s1 = await begin(forged.h, c1);
    forged.box.nonce = s1.nonce;
    expect((await c1.call("/api/auth/google/callback?code=abc&state=wrong")).headers.get("location")).toContain("error=google_failed");
    // The pending sign-in is spent by the failed attempt.
    expect((await c1.call(`/api/auth/google/callback?code=abc&state=${s1.state}`)).headers.get("location")).toContain("error=google_failed");

    const replayed = withGoogle(good("gail@example.test"));
    const c2 = new Client(replayed.h.app);
    const s2 = await begin(replayed.h, c2);
    replayed.box.nonce = "a nonce from another sign-in";
    expect((await c2.call(`/api/auth/google/callback?code=abc&state=${s2.state}`)).headers.get("location")).toContain("error=google_failed");

    const wrongAudience = withGoogle(good("gail@example.test", { aud: "someone-else" }));
    const c3 = new Client(wrongAudience.h.app);
    const s3 = await begin(wrongAudience.h, c3);
    wrongAudience.box.nonce = s3.nonce;
    expect((await c3.call(`/api/auth/google/callback?code=abc&state=${s3.state}`)).headers.get("location")).toContain("error=google_failed");

    const unverified = withGoogle(good("gail@example.test", { email_verified: false }));
    const c4 = new Client(unverified.h.app);
    const s4 = await begin(unverified.h, c4);
    unverified.box.nonce = s4.nonce;
    expect((await c4.call(`/api/auth/google/callback?code=abc&state=${s4.state}`)).headers.get("location")).toContain("error=google_unverified");
  });
});

describe("networks", () => {
  it("derives a different contract for the same asset on each network, and keeps payments on one", async () => {
    const testnet = new FakeChain();
    const mainnet = new FakeChain();
    const concord = new Concord(new Db(":memory:"), {
      testnet: { passphrase: PASSPHRASE, chain: testnet },
      mainnet: { passphrase: MAINNET_PASSPHRASE, chain: mainnet },
    });
    const issuer = key();
    const onTest = await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
    const onMain = await concord.watchAsset({ network: "mainnet", asset: `FUND:${issuer}`, fromLedger: 1 });
    expect(onTest.id).not.toBe(onMain.id);
    expect(concord.overview("mainnet").assets.map((a) => a.id)).toEqual([onMain.id]);
    expect(concord.overview().networks).toEqual(["mainnet", "testnet"]);

    const holder = key();
    mainnet.push(onMain.id, "mint", 3, { to: holder, amount: u(7) });
    testnet.push(onTest.id, "mint", 3, { to: holder, amount: u(9) });
    // An outage on one network leaves the other indexing.
    testnet.failOnCall = 1;
    const results = await concord.syncAll();
    expect(results[onMain.id]).toEqual({ added: 1 });
    expect(results[onTest.id]).toEqual({ error: "Indexing stopped on an unexpected error." });
    expect(concord.holdings(onMain.id).supply).toBe("7");
    expect(concord.asset(onTest.id).syncError).toBeTruthy();
    await concord.syncAll();
    expect(concord.holdings(onTest.id).supply).toBe("9");
    expect(concord.asset(onTest.id).syncError).toBeUndefined();

    await expect(
      concord.createAction(onMain.id, { type: "dividend", recordTime: at(5), ratePerUnit: "1", payAsset: onTest.id }),
    ).rejects.toThrow(/same network/);
    await expect(concord.watchAsset({ network: "devnet" as "testnet", asset: `FUND:${issuer}` })).rejects.toThrow(/mainnet or testnet/);
  });

  it("serves both networks with public endpoints by default and names retired settings", () => {
    const config = loadConfig({});
    expect(config.defaultNetwork).toBe("mainnet");
    expect(config.networks.mainnet.rpc.length).toBeGreaterThan(1);
    expect(config.networks.testnet.rpc[0]!.url).toBe("https://soroban-testnet.stellar.org");
    expect(loadConfig({ CONCORD_MAINNET_RPC_URLS: "https://rpc.example/key/abc/ , https://b.example" }).networks.mainnet.rpc.map((e) => e.url)).toEqual([
      "https://rpc.example/key/abc",
      "https://b.example",
    ]);
    expect(loadConfig({ PORT: "10000", CONCORD_HOST: "0.0.0.0" })).toMatchObject({ port: 10000, publicUrl: "http://127.0.0.1:10000" });
    expect(() => loadConfig({ CONCORD_API_TOKEN: "x" })).toThrow(/no longer read/);
    expect(() => loadConfig({ CONCORD_DB: "x.db" })).toThrow(/CONCORD_DATA_DIR/);
    expect(() => loadConfig({ CONCORD_GOOGLE_CLIENT_ID: "only-one" })).toThrow(/both/);
    expect(loadConfig({ CONCORD_PASSWORD_COST: "16384:8:1" }).passwordCost).toEqual({ N: 16384, r: 8, p: 1 });
    expect(loadConfig({}).passwordCost).toBeUndefined();
    for (const weak of ["1024:8:1", "20000:8:1", "32768:8", "nope"]) {
      expect(() => loadConfig({ CONCORD_PASSWORD_COST: weak }), weak).toThrow(/CONCORD_PASSWORD_COST/);
    }
  });
});

describe("chain endpoints", () => {
  const network = (urls: string[], headers?: Record<string, string>) => ({
    name: "mainnet" as const,
    passphrase: MAINNET_PASSPHRASE,
    rpc: urls.map((url) => ({ url, ...(headers ? { headers } : {}) })),
    horizon: [{ url: "https://horizon.example" }],
  });
  const health = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { latestLedger: 50, oldestLedger: 10, oldestLedgerCloseTime: "1790000000" } }));

  function scripted(answers: Record<string, Array<() => Response | Promise<Response>>>) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const clock = { value: 1_000_000 };
    const fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
      const next = answers[u]?.shift();
      if (!next) throw new TypeError("fetch failed");
      return next();
    }) as typeof globalThis.fetch;
    const deps = { fetch, sleep: async (ms: number) => void (clock.value += ms), now: () => clock.value };
    return { calls, clock, deps };
  }

  it("moves to the next endpoint when one is rate limited, and rests the first", async () => {
    const a = "https://a.example/secret-key-123";
    const b = "https://b.example";
    const { calls, clock, deps } = scripted({
      [a]: [() => new Response("slow down", { status: 429, headers: { "retry-after": "40" } }), health],
      [b]: [health, health],
    });
    const source = new StellarSource(network([a, b], { "x-api-key": "k" }), deps);
    expect(await source.latestLedger()).toEqual({ latest: 50, oldest: 10, oldestClosedAt: new Date(1790000000 * 1000).toISOString() });
    expect(calls.map((c) => c.url)).toEqual([a, b]);
    expect(calls[0]!.headers["x-api-key"]).toBe("k");
    // Still resting: the next call goes straight to the second endpoint.
    await source.latestLedger();
    expect(calls.map((c) => c.url)).toEqual([a, b, b]);
    clock.value += 41_000;
    await source.latestLedger();
    expect(calls.at(-1)!.url).toBe(a);
  });

  it("retries a failing endpoint once, then reports hosts only", async () => {
    const a = "https://a.example/secret-key-123";
    const { calls, deps } = scripted({ [a]: [() => new Response("", { status: 503 }), health] });
    const source = new StellarSource(network([a]), deps);
    await source.latestLedger();
    expect(calls).toHaveLength(2);

    const down = scripted({ [a]: [() => new Response("", { status: 429 })] });
    const limited = new StellarSource(network([a, "https://b.example/another-key"]), down.deps);
    const err = await limited.latestLedger().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("a.example: rate limited");
    expect((err as Error).message).toContain("b.example: unreachable");
    expect((err as Error).message).not.toContain("secret-key");
    expect((err as Error).message).not.toContain("another-key");
    // With every endpoint resting, the next call says so without knocking again.
    const before = down.calls.length;
    await expect(limited.latestLedger()).rejects.toThrow(/not answering/);
    expect(down.calls).toHaveLength(before);
  });

  it("does not retry a request the RPC rejected", async () => {
    const a = "https://a.example";
    const { calls, deps } = scripted({
      [a]: [() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "startLedger must be within the ledger range" } }))],
    });
    const source = new StellarSource(network([a, "https://b.example"]), deps);
    await expect(source.getEvents("C", { startLedger: 1 }, 10)).rejects.toThrow(/ledger range/);
    expect(calls).toHaveLength(1);
  });

  it("does not rest an endpoint on request faults (400, 404, 422)", async () => {
    const a = "https://a.example";
    const { calls, deps } = scripted({
      [a]: [
        () => new Response("bad request", { status: 400 }),
        health,
      ],
    });
    const source = new StellarSource(network([a, "https://b.example"]), deps);
    await expect(source.latestLedger()).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
    // Endpoint `a` was not rested: the subsequent call hits `a` immediately rather than falling back or waiting.
    const head = await source.latestLedger();
    expect(head.latest).toBe(50);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(a);
  });

  it("rests an endpoint on 401/403 with a distinct message", async () => {
    const a = "https://a.example/bad-key";
    const b = "https://b.example";
    const { calls, deps } = scripted({
      [a]: [() => new Response("unauthorized", { status: 401 })],
      [b]: [health, health],
    });
    const source = new StellarSource(network([a, b]), deps);
    const head = await source.latestLedger();
    expect(head.latest).toBe(50);
    expect(calls.map((c) => c.url)).toEqual([a, b]);
    // Endpoint `a` is now resting due to bad API key, so next call goes straight to `b`.
    await source.latestLedger();
    expect(calls.map((c) => c.url)).toEqual([a, b, b]);

    // When all endpoints fail with 401/403, error message reports bad API key.
    const badKeyScript = scripted({ [a]: [() => new Response("forbidden", { status: 403 })] });
    const failingSource = new StellarSource(network([a]), badKeyScript.deps);
    const err = await failingSource.latestLedger().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("a.example: bad API key");
  });

  it("reads opening balances page by page from one Horizon, and refuses one that goes backwards", async () => {
    const issuer = key();
    const [h1, h2] = [key(), key()];
    const line = (balance: string, authorized = true) => ({ asset_code: "FUND", asset_issuer: issuer, balance, is_authorized: authorized });
    const record = (id: string, balance: string) => ({ account_id: id, balances: [line(balance)] });
    const many = Array.from({ length: 199 }, () => record(key(), "1.0000000"));
    const first = `https://horizon.example/accounts?asset=FUND:${issuer}&limit=200&order=asc`;
    const second = "https://horizon.example/accounts?cursor=abc&limit=200";
    const page = (records: unknown[], ledger: number, next?: string) => () =>
      new Response(JSON.stringify({ _links: next ? { next: { href: next } } : {}, _embedded: { records } }), {
        headers: { "latest-ledger": String(ledger) },
      });
    const ok = scripted({
      [first]: [page([record(h1, "70.0000000"), ...many], 150, "https://other-host.example/accounts?cursor=abc&limit=200")],
      [second]: [page([record(h2, "30.5000000")], 152)],
    });
    const source = new StellarSource(network(["https://rpc.example"]), ok.deps);
    const baseline = await source.baseline("FUND", issuer, 7);
    expect(baseline.ledger).toBe(150);
    expect(baseline.openings.size).toBe(201);
    expect(baseline.openings.get(h1)).toEqual({ amount: u(70), asOfLedger: 150, authorized: true });
    expect(baseline.openings.get(h2)).toEqual({ amount: 305_000_000n, asOfLedger: 152, authorized: true });
    // The next link named another host; the request stayed on the configured one.
    expect(ok.calls.map((c) => c.url)).toEqual([first, second]);

    const lagging = scripted({
      [first]: [page([record(h1, "70.0000000"), ...many], 150, second)],
      [second]: [page([record(h2, "30.5000000")], 149)],
    });
    await expect(new StellarSource(network(["https://rpc.example"]), lagging.deps).baseline("FUND", issuer, 7)).rejects.toThrow(/back in time/);
  });

  it("finds classic assets by code, most widely held first", async () => {
    const [i1, i2] = [key(), key()];
    const asset = (issuer: string, authorized: number, flags: boolean) => ({
      asset_code: "BENJI",
      asset_issuer: issuer,
      accounts: { authorized, authorized_to_maintain_liabilities: 0, unauthorized: 2 },
      balances: { authorized: "10.0000000" },
      flags: { auth_required: flags, auth_revocable: flags, auth_clawback_enabled: flags },
    });
    const { deps } = scripted({
      "https://horizon.example/assets?asset_code=BENJI&limit=200": [
        () => new Response(JSON.stringify({ _embedded: { records: [asset(i1, 4, false), asset(i2, 1376, true)] } })),
      ],
    });
    const found = await new StellarSource(network(["https://rpc.example"]), deps).search("BENJI");
    expect(found.map((f) => [f.issuer, f.trustlines, f.clawbackEnabled])).toEqual([
      [i2, 1378, true],
      [i1, 6, false],
    ]);
    expect(found[0]!.asset).toBe(`BENJI:${i2}`);
    expect(found[0]!.contractId).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("fails over to the next Horizon endpoint when _embedded.records is omitted, and reports ChainError naming hosts if all fail", async () => {
    const h1 = "https://h1.example";
    const h2 = "https://h2.example";
    const net = {
      name: "mainnet" as const,
      passphrase: MAINNET_PASSPHRASE,
      rpc: [{ url: "https://rpc.example" }],
      horizon: [{ url: h1 }, { url: h2 }],
    };

    // Test search(): h1 returns malformed { title: "oops" }, h2 succeeds
    const okSearch = () => new Response(JSON.stringify({ _embedded: { records: [] } }));
    const badBody = () => new Response(JSON.stringify({ title: "oops" }));
    const s1 = scripted({
      [`${h1}/assets?asset_code=FOO&limit=200`]: [badBody],
      [`${h2}/assets?asset_code=FOO&limit=200`]: [okSearch],
    });
    const src1 = new StellarSource(net, s1.deps);
    const searchRes = await src1.search("FOO");
    expect(searchRes).toEqual([]);
    expect(s1.calls.map((c) => c.url)).toEqual([
      `${h1}/assets?asset_code=FOO&limit=200`,
      `${h2}/assets?asset_code=FOO&limit=200`,
    ]);

    // Test baseline(): h1 returns malformed accounts page, h2 succeeds
    const issuer = key();
    const okAccounts = () => new Response(JSON.stringify({ _links: {}, _embedded: { records: [] } }), {
      headers: { "latest-ledger": "100" },
    });
    const s2 = scripted({
      [`${h1}/accounts?asset=FOO:${issuer}&limit=200&order=asc`]: [badBody],
      [`${h2}/accounts?asset=FOO:${issuer}&limit=200&order=asc`]: [okAccounts],
    });
    const src2 = new StellarSource(net, s2.deps);
    const baseRes = await src2.baseline("FOO", issuer, 7);
    expect(baseRes.ledger).toBe(100);
    expect(baseRes.openings.size).toBe(0);

    // Test describe(): h1 returns malformed, h2 succeeds
    const s3 = scripted({
      [`${h1}/assets?asset_code=FOO&asset_issuer=${issuer}&limit=200`]: [badBody],
      [`${h2}/assets?asset_code=FOO&asset_issuer=${issuer}&limit=200`]: [okSearch],
    });
    const src3 = new StellarSource(net, s3.deps);
    const descRes = await src3.describe({ id: "C123", code: "FOO", issuer });
    expect(descRes).toBeUndefined();

    // If all fail, a ChainError names the hosts
    const sAllFail = scripted({
      [`${h1}/assets?asset_code=FOO&limit=200`]: [badBody],
      [`${h2}/assets?asset_code=FOO&limit=200`]: [badBody],
    });
    const srcAllFail = new StellarSource(net, sAllFail.deps);
    const err = await srcAllFail.search("FOO").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("h1.example: unexpected response");
    expect(err.message).toContain("h2.example: unexpected response");
  });
});

describe("what ships", () => {
  it("keeps the testnet practice script away from every database", () => {
    const source = readFileSync(new URL("../src/demo/testnet.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    for (const banned of ["db", "concord", "tenants", "main", "auth", "schema"]) {
      expect(imports.some((i) => i.endsWith(`/${banned}.js`)), banned).toBe(false);
    }
    expect(source).not.toMatch(/watchAsset|importRegister|DatabaseSync/);
  });

  it("documents in .env.example every environment variable the service reads", () => {
    const src = new URL("../src/", import.meta.url);
    const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(new URL(file, src), "utf8"))
      .join("\n");
    // Names built per network, e.g. `CONCORD_${upper}_RPC_URLS`, count once for each network.
    const expanded = ["MAINNET", "TESTNET"].map((upper) => sources.replaceAll("${upper}", upper)).join("\n");
    // Retired names are read only to be refused, so they belong nowhere in the example.
    const config = readFileSync(new URL("config.ts", src), "utf8");
    const retired = new Set(config.match(/const RETIRED[^]*?\n};/)![0].match(/\bCONCORD_[A-Z0-9_]+(?=:)/g));
    expect(retired.size).toBeGreaterThan(0);

    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const concord = new Set(expanded.match(/\bCONCORD_[A-Z0-9_]+/g)!.filter((name) => !retired.has(name)));
    const undocumented = [...concord].filter((name) => !new RegExp(`^#? ?${name}=`, "m").test(example));
    // Set by the platform rather than by an operator, so a mention is enough.
    const platform = [...new Set(sources.match(/\b(PORT|RENDER_EXTERNAL_URL)\b/g))];
    undocumented.push(...platform.filter((name) => !new RegExp(`\\b${name}\\b`).test(example)));
    expect(undocumented).toEqual([]);
  });

  it("starts both schemas from nothing and refuses a database from before versioning", () => {
    const control = new Db(":memory:", CONTROL_MIGRATIONS);
    expect(control.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(CONTROL_MIGRATIONS.length);
    const org = new Db(":memory:", ORG_MIGRATIONS);
    expect(org.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
    expect(() => new Db(":memory:", [...ORG_MIGRATIONS, "CREATE TABLE broken (x REFERENCES nowhere (y)); INSERT INTO broken VALUES (1);"])).toThrow();
  });

  it("does not mask the original error when rollback fails in tx and migrate", () => {
    // 1. In migrate: COMMIT inside migration followed by invalid statement
    expect(() => {
      new Db(":memory:", ["CREATE TABLE a (x); COMMIT; CREATE TABLE b (y;"]);
    }).toThrow(/syntax error|near/i);

    // 2. In tx: transaction already committed or rolled back inside fn
    const db = new Db(":memory:", []);
    expect(() => {
      db.tx(() => {
        db.raw.exec("COMMIT");
        throw new Error("original failure");
      });
    }).toThrow("original failure");
  });

  it("does not serve files reached through encoded dot-dot with immutable caching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
    const webDir = join(dir, "web");
    const dataDir = join(dir, "data");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
    writeFileSync(join(webDir, "secret.txt"), "secret outside assets");
    writeFileSync(join(webDir, "assets/app.123.js"), "console.log('asset');");

    const cfg = loadConfig({
      CONCORD_DATA_DIR: dataDir,
      CONCORD_WEB_DIR: webDir,
      CONCORD_SIGNUP: "open",
    });
    const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
    const auth = new Auth(control, { signup: "open" });
    const tenants = new Tenants(fileStore(dataDir), {}, () => false, () => []);
    const runtime = { control, auth, tenants, close: () => { tenants.close(); control.close(); } };
    const app = createServerApp(runtime, cfg);

    try {
      // Normal asset in webDir/assets gets immutable caching
      const resAsset = await app.request("/assets/app.123.js");
      expect(resAsset.status).toBe(200);
      expect(resAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      // Encoded dot-dot request (/assets/..%2fsecret.txt) returns 404 and never immutable caching
      const resDotDot1 = await app.request("/assets/..%2fsecret.txt");
      expect(resDotDot1.status).toBe(404);
      expect(resDotDot1.headers.get("cache-control") ?? "").not.toContain("immutable");

      // Regular file outside assets directory is not cached with immutable header
      const resSecret = await app.request("/secret.txt");
      expect(resSecret.status).toBe(200);
      expect(resSecret.headers.get("cache-control")).not.toContain("immutable");
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 404 for missing files with an extension while extensionless routes get index.html", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
    const webDir = join(dir, "web");
    const dataDir = join(dir, "data");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
    writeFileSync(join(webDir, "favicon.ico"), "fake-ico");

    const cfg = loadConfig({
      CONCORD_DATA_DIR: dataDir,
      CONCORD_WEB_DIR: webDir,
      CONCORD_SIGNUP: "open",
    });
    const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
    const auth = new Auth(control, { signup: "open" });
    const tenants = new Tenants(fileStore(dataDir), {}, () => false, () => []);
    const runtime = { control, auth, tenants, close: () => { tenants.close(); control.close(); } };
    const app = createServerApp(runtime, cfg);

    try {
      // Existing file returns 200
      const resFavicon = await app.request("/favicon.ico");
      expect(resFavicon.status).toBe(200);

      // Missing files with an extension return 404
      const resMissingIco = await app.request("/missing-favicon.ico");
      expect(resMissingIco.status).toBe(404);

      const resMissingJs = await app.request("/a/b/c.js");
      expect(resMissingJs.status).toBe(404);

      const resMissingTxt = await app.request("/robots.txt");
      expect(resMissingTxt.status).toBe(404);

      // Extensionless route falls back to SPA index.html
      const resSpa = await app.request("/a/abc/reconciliation");
      expect(resSpa.status).toBe(200);
      expect(await resSpa.text()).toBe("<html>shell</html>");
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses dotfiles from web directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
    const webDir = join(dir, "web");
    const dataDir = join(dir, "data");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(join(webDir, "a/.git"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
    writeFileSync(join(webDir, ".hidden"), "secret dotfile");
    writeFileSync(join(webDir, "a/.git/config"), "secret git config");
    writeFileSync(join(webDir, "assets/x.js"), "console.log('x');");

    const cfg = loadConfig({
      CONCORD_DATA_DIR: dataDir,
      CONCORD_WEB_DIR: webDir,
      CONCORD_SIGNUP: "open",
    });
    const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
    const auth = new Auth(control, { signup: "open" });
    const tenants = new Tenants(fileStore(dataDir), {}, () => false, () => []);
    const runtime = { control, auth, tenants, close: () => { tenants.close(); control.close(); } };
    const app = createServerApp(runtime, cfg);

    try {
      // /.hidden and /a/.git/config return 404
      const resDot = await app.request("/.hidden");
      expect(resDot.status).toBe(404);

      const resSubDot = await app.request("/a/.git/config");
      expect(resSubDot.status).toBe(404);

      // /assets/x.js still served
      const resAsset = await app.request("/assets/x.js");
      expect(resAsset.status).toBe(200);
      expect(await resAsset.text()).toBe("console.log('x');");
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
