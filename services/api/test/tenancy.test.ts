import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { readFileSync as readFixture } from "node:fs";
import { Asset, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { Auth } from "../src/auth.js";
import { StellarSource } from "../src/chain.js";
import { Concord } from "../src/concord.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { createServerApp, openRuntime } from "../src/main.js";
import { CONTROL_MIGRATIONS, ORG_MIGRATIONS } from "../src/schema.js";
import { Tenants, fileStore, memoryStore, type OrgStore } from "../src/tenants.js";
import { Client, FakeChain, MAINNET_PASSPHRASE, ORIGIN, PASSPHRASE, at, harness, key, u, type Harness } from "./helpers.js";

/** Strings that exist only in workspace A. None may ever reach workspace B. */
const MARKERS = ["ALPHA-HOLDER-7", "Northgate Secret Trust", "alpha sign-off note", "J-ALPHA", "I-ALPHA", "Alpha Capital"];

/** SHA-256 of each shipped migration, in order. A changed entry means a shipped migration was edited. */
const ORG_MIGRATION_DIGESTS = [
  "1a4f90d62ead1ba8254ab3244d04be0ca9f46646df78cd12f1ece6db41bd2387",
  "2002f2e1b269939a38de8da3768a85787f98ce207246cf15134423ffdce6db72",
  "ece8f3334de957d19e76585727af4790c2f6ba78f60407ade9a67e1edb25cd55",
];
const CONTROL_MIGRATION_DIGESTS = ["ba25bc5419cfcc376d2e7ff027845b2da4b789d9c7e966424b70cdfbbb90a422"];

/** Hash each migration as LF text so a CRLF checkout does not change the pinned values. */
function migrationDigests(migrations: readonly string[]): string[] {
  return migrations.map((sql) => createHash("sha256").update(sql.replace(/\r\n?/g, "\n")).digest("hex"));
}

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
    "GET /api/reconciliations/:id/report": p("GET", `/api/reconciliations/${s.runId}/report`),
    "GET /api/assets/:id/actions": p("GET", `/api/assets/${id}/actions`),
    "POST /api/assets/:id/actions": p("POST", `/api/assets/${id}/actions`, { type: "split", recordTime: at(1), num: "2", den: "1" }),
    "GET /api/actions/:id": p("GET", `/api/actions/${s.actionId}`),
    "POST /api/actions/:id/reconcile": p("POST", `/api/actions/${s.actionId}/reconcile`),
    "GET /api/assets/:id/controls": p("GET", `/api/assets/${id}/controls`),
    "PUT /api/assets/:id/notes": p("PUT", `/api/assets/${id}/notes`, { scope: "recon", key: "k", fingerprint: "f", status: "resolved", note: "n" }),
    "GET /api/assets/:id/notes/history": p("GET", `/api/assets/${id}/notes/history`),
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

  it("opens only workspaces it knows, under ids it generated, returning one shared instance (#499)", () => {
    const temp = mkdtempSync(join(tmpdir(), "concord-for-org-"));
    const orgDir = join(temp, "orgs");
    try {
      const tenants = new Tenants(fileStore(temp), {}, () => true, () => []);
      const valid = "0123456789abcdef";

      // Regex-only rejection proven by known being true:
      // uppercase hex, ../../etc, empty string, 15 and 17 characters all throw
      const badIds = [
        "../../etc",
        "../x",
        "..%2Fx",
        "",
        "0123456789ABCDEF",
        "0123456789abcde",
        "0123456789abcdef0",
        undefined as unknown as string,
      ];
      for (const bad of badIds) {
        expect(() => tenants.forOrg(bad), String(bad)).toThrow(/no such workspace/);
      }

      // Rejections created no file under tmp/orgs
      expect(existsSync(orgDir) ? readdirSync(orgDir) : []).toEqual([]);

      // Returns one shared instance per workspace
      const a = tenants.forOrg(valid);
      const b = tenants.forOrg(valid);
      expect(a).toBe(b);

      // When known returns false, even a structurally valid id throws
      const unknownTenants = new Tenants(fileStore(temp), {}, () => false, () => []);
      expect(() => unknownTenants.forOrg(valid)).toThrow(/no such workspace/);

      // A store whose open throws propagates and is retried, not cached
      let attempts = 0;
      const retryStore = {
        open: () => {
          attempts++;
          if (attempts === 1) throw new Error("transient open failure");
          return new Db(":memory:", ORG_MIGRATIONS);
        },
        remove: () => {},
      };
      const retrying = new Tenants(retryStore, {}, () => true, () => []);
      expect(() => retrying.forOrg(valid)).toThrow("transient open failure");
      expect(attempts).toBe(1);

      const recovered = retrying.forOrg(valid);
      expect(recovered).toBeDefined();
      expect(attempts).toBe(2);
      expect(retrying.forOrg(valid)).toBe(recovered);
      expect(attempts).toBe(2);
      retrying.drop(valid);
      tenants.drop(valid);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
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
      alphaDb.insert("INSERT INTO meta (key, value) VALUES ('sample', 'ALPHA ONLY')");
      betaDb.insert("INSERT INTO meta (key, value) VALUES ('sample', 'BETA ONLY')");

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

  describe("shutting down", () => {
    const alpha = "aaaaaaaaaaaaaaaa";
    const beta = "bbbbbbbbbbbbbbbb";

    /** Workspaces over in-memory databases that record, in order, each id closed and each id removed. */
    function recorded(): { tenants: Tenants; closed: string[]; removed: string[] } {
      const closed: string[] = [];
      const removed: string[] = [];
      const store: OrgStore = {
        open: (orgId) => {
          const db = new Db(":memory:", ORG_MIGRATIONS);
          const close = db.close.bind(db);
          db.close = () => {
            closed.push(orgId);
            close();
          };
          return db;
        },
        remove: (orgId) => void removed.push(orgId),
      };
      return { tenants: new Tenants(store, {}, () => true, () => [alpha, beta]), closed, removed };
    }

    it("closes every open workspace once, and closing again does nothing", () => {
      const { tenants, closed } = recorded();
      const handles = [tenants.forOrg(alpha).db, tenants.forOrg(beta).db];

      tenants.close();
      expect([...closed].sort()).toEqual([alpha, beta]);
      for (const db of handles) expect(() => db.get("SELECT 1")).toThrow(/not open/);

      // Shutdown reaches close() from more than one path.
      expect(() => tenants.close()).not.toThrow();
      expect(closed).toHaveLength(2);
    });

    it("does not close a dropped workspace a second time", () => {
      const { tenants, closed, removed } = recorded();
      tenants.forOrg(alpha);
      const kept = tenants.forOrg(beta).db;

      tenants.drop(alpha);
      expect(closed).toEqual([alpha]);
      expect(removed).toEqual([alpha]);
      // The neighbour is untouched by the drop.
      expect(kept.get<{ value: string }>("SELECT value FROM meta WHERE key = 'org_id'")?.value).toBe(beta);

      tenants.close();
      expect(closed).toEqual([alpha, beta]);
      // Nor does a drop after close() reach a handle that is already closed.
      tenants.drop(beta);
      expect(closed).toEqual([alpha, beta]);
      expect(removed).toEqual([alpha, beta]);
    });

    it("opens a new instance for a workspace asked for after close()", () => {
      const { tenants, closed } = recorded();
      const before = tenants.forOrg(alpha);
      expect(tenants.forOrg(alpha)).toBe(before);

      tenants.close();
      const after = tenants.forOrg(alpha);
      expect(after).not.toBe(before);
      expect(after.db).not.toBe(before.db);
      // The handle from before stays closed; the new one is the workspace's own and is open.
      expect(() => before.db.get("SELECT 1")).toThrow(/not open/);
      expect(after.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'org_id'")?.value).toBe(alpha);
      expect(tenants.forOrg(alpha)).toBe(after);

      tenants.close();
      expect(closed).toEqual([alpha, alpha]);
    });

    it("closes the runtime twice without throwing, and frees its files", async () => {
      const temp = mkdtempSync(join(tmpdir(), "concord-runtime-close-"));
      try {
        // The cheapest password cost the config accepts: the sign-up is only here to make a workspace.
        const runtime = openRuntime(loadConfig({ CONCORD_DATA_DIR: temp, CONCORD_PASSWORD_COST: "16384:8:1" }));
        const { orgId } = await runtime.auth.signUp({
          email: "ann@alpha.test",
          name: "Ann Alpha",
          password: "correct horse battery",
          orgName: "Alpha Capital",
        });
        const workspace = runtime.tenants.forOrg(orgId).db;
        expect(existsSync(join(temp, "control.db"))).toBe(true);
        expect(readdirSync(join(temp, "orgs"))).toContain(`${orgId}.db`);

        runtime.close();
        // The second close used to throw "database is not open" from the control database.
        expect(() => runtime.close()).not.toThrow();
        // Both are closed: the identity records, and the workspace opened through the runtime.
        for (const db of [runtime.control, workspace]) expect(() => db.get("SELECT 1")).toThrow(/not open/);
      } finally {
        // On Windows this fails while a handle is still open, so it checks the close as well.
        rmSync(temp, { recursive: true, force: true });
      }
      expect(existsSync(temp)).toBe(false);
    });
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

  it("isolates a failing workspace during syncAll, reports its error and advances due actions in healthy ones (#501)", async () => {
    const chain = new FakeChain();
    chain.latest = 50;
    const org1 = "1111111111111111";
    const org2 = "2222222222222222";
    const org3 = "3333333333333333";
    const orgIds = [org1, org2, org3];

    const dbs = new Map<string, Db>();
    const store = {
      open: (id: string) => {
        if (id === org2) throw new Error("disk full");
        if (!dbs.has(id)) dbs.set(id, new Db(":memory:", ORG_MIGRATIONS));
        return dbs.get(id)!;
      },
      remove: (id: string) => dbs.delete(id),
    };

    const tenants = new Tenants(store, { testnet: { passphrase: PASSPHRASE, chain } }, () => true, () => orgIds);

    try {
      const w1 = tenants.forOrg(org1);
      const w3 = tenants.forOrg(org3);

      const a1 = await w1.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
      const a3 = await w3.watchAsset({ network: "testnet", asset: `BOND:${key()}`, fromLedger: 1 });

      // Schedule a split in w1 beyond chain.latest (recordTime at ledger 250)
      const action = await w1.createAction(a1.id, {
        type: "split",
        recordTime: at(250),
        num: "1",
        den: "1",
      });

      // Before chain advances, action is scheduled and has no snapshot
      expect(action.state).toBe("scheduled");
      expect(action.snapshot).toBeNull();

      // First syncAll pass with chain.latest = 50
      const results1 = await tenants.syncAll();
      expect(results1).toEqual([
        { orgId: org1, assetId: a1.id, added: 0 },
        { orgId: org2, assetId: "", error: "disk full" },
        { orgId: org3, assetId: a3.id, added: 0 },
      ]);
      expect(w1.action(action.id).state).toBe("scheduled");

      // Advance chain to 300 so recordTime (at(250)) is reached
      chain.latest = 300;
      const results2 = await tenants.syncAll();
      expect(results2).toEqual([
        { orgId: org1, assetId: a1.id, added: 0 },
        { orgId: org2, assetId: "", error: "disk full" },
        { orgId: org3, assetId: a3.id, added: 0 },
      ]);

      // ReconcileDue ran during syncAll and advanced the scheduled action to clean
      const advanced = w1.action(action.id);
      expect(advanced.state).toBe("clean");
      expect(advanced.snapshot).not.toBeNull();
    } finally {
      tenants.close();
    }
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

  it("normalizes long Google names and reports invalid email without a mismatch message", async () => {
    const renamed = withGoogle(good("longname@example.test", { name: "N".repeat(140) }));
    const first = new Client(renamed.h.app);
    const start = await begin(renamed.h, first);
    renamed.box.nonce = start.nonce;
    const done = await first.call(`/api/auth/google/callback?code=abc&state=${start.state}`);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/#/`);
    const me = await first.json<{ user: { name: string } }>("/api/auth/me");
    expect(me.user.name).toBe("N".repeat(80));

    const malformed = withGoogle(good("invalid-email", { email: "invalid-email" }));
    const second = new Client(malformed.h.app);
    const state = await begin(malformed.h, second);
    malformed.box.nonce = state.nonce;
    const failure = await second.call(`/api/auth/google/callback?code=abc&state=${state.state}`);
    expect(failure.headers.get("location")).toBe(`${ORIGIN}/#/signin?error=google_invalid_email`);
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
    expect(results[onTest.id]).toEqual({ error: "[internal] Indexing stopped on an unexpected error." });
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

  it("rejects a CONCORD_PUBLIC_URL with a path instead of silently dropping it", () => {
    // A sub-path used to be trimmed to the origin, so cookies and the OAuth
    // redirect quietly pointed at the wrong place. Now it is named as the
    // configuration error it is.
    expect(() => loadConfig({ CONCORD_PUBLIC_URL: "https://x.example/concord" })).toThrow(
      /sub-path hosting is not supported.*https:\/\/x\.example/,
    );
    expect(() => loadConfig({ CONCORD_PUBLIC_URL: "https://x.example/?tenant=a" })).toThrow(/query/);
    // A trailing slash alone is still accepted, and still normalizes to the origin.
    expect(loadConfig({ CONCORD_PUBLIC_URL: "https://x.example/" }).publicUrl).toBe("https://x.example");
    expect(loadConfig({ CONCORD_PUBLIC_URL: "https://x.example" }).publicUrl).toBe("https://x.example");
    expect(() => loadConfig({ CONCORD_PUBLIC_URL: "not a url" })).toThrow(/must be a URL/);
  });

  it.each([
    {
      name: "CONCORD_PUBLIC_URL beats RENDER_EXTERNAL_URL",
      env: { CONCORD_PUBLIC_URL: "https://public.example", RENDER_EXTERNAL_URL: "https://render.example" },
      expected: "https://public.example",
    },
    {
      name: "RENDER_EXTERNAL_URL beats default http://host:port",
      env: { RENDER_EXTERNAL_URL: "https://render.example" },
      expected: "https://render.example",
    },
    {
      name: "default http://host:port fallback",
      env: { CONCORD_HOST: "127.0.0.1", CONCORD_PORT: "4400" },
      expected: "http://127.0.0.1:4400",
    },
    {
      name: "trailing slash is dropped",
      env: { CONCORD_PUBLIC_URL: "https://x.example/" },
      expected: "https://x.example",
    },
    {
      name: "0.0.0.0 host maps to 127.0.0.1",
      env: { CONCORD_HOST: "0.0.0.0", CONCORD_PORT: "4400" },
      expected: "http://127.0.0.1:4400",
    },
    {
      name: "IPv6 ::1 host brackets to [::1]",
      env: { CONCORD_HOST: "::1", CONCORD_PORT: "4400" },
      expected: "http://[::1]:4400",
    },
    {
      // Sub-paths were previously stripped silently; current behavior rejects them explicitly
      // to avoid cookies and OAuth redirect URI pointing to the wrong root origin.
      name: "path is rejected (sub-path hosting not supported)",
      env: { CONCORD_PUBLIC_URL: "https://x.example/app/" },
      error: /sub-path hosting is not supported/,
    },
    {
      // Current behavior accepts non-http schemes like ftp:// because any valid URL
      // with pathname "/" is parsed by new URL() and its origin is preserved.
      name: "ftp scheme is accepted",
      env: { CONCORD_PUBLIC_URL: "ftp://x.example" },
      expected: "ftp://x.example",
    },
  ])("derives publicUrl correctly: $name (#488)", ({ env, expected, error }) => {
    if (error) {
      expect(() => loadConfig(env)).toThrow(error);
    } else {
      expect(loadConfig(env).publicUrl).toBe(expected);
    }
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
    expect(() => loadConfig({ PORT: "70000" })).toThrow("PORT must be a whole number from 1 to 65535");

    const withHeaders = loadConfig({
      CONCORD_MAINNET_RPC_URLS: "https://x.example:8443/rpc, https://y.example:8443/rpc, https://z.example/rpc",
      CONCORD_RPC_HEADERS: JSON.stringify({
        "x.example": { "x-api-key": "fallback-key" },
        "y.example": { "x-api-key": "hostname-key" },
        "y.example:8443": { "x-api-key": "exact-key" },
        "z.example": { "x-api-key": "standard-key" },
      }),
    });
    expect(withHeaders.networks.mainnet.rpc[0]?.headers).toEqual({ "x-api-key": "fallback-key" });
    expect(withHeaders.networks.mainnet.rpc[1]?.headers).toEqual({ "x-api-key": "exact-key" });
    expect(withHeaders.networks.mainnet.rpc[2]?.headers).toEqual({ "x-api-key": "standard-key" });
    // Node fetch does not support userinfo URLs: fail configuration instead of retrying forever.
    for (const url of [
      "https://user:password@rpc.example/secret",
      "https://user@rpc.example",
      "https://:password@rpc.example",
    ]) {
      expect(() => loadConfig({ CONCORD_MAINNET_RPC_URLS: url })).toThrow(
        /CONCORD_MAINNET_RPC_URLS must not contain URL credentials; configure Authorization via CONCORD_RPC_HEADERS/,
      );
    }
    expect(() => loadConfig({ CONCORD_TESTNET_HORIZON_URLS: "https://u:p@horizon.example" })).toThrow(
      /CONCORD_TESTNET_HORIZON_URLS must not contain URL credentials/,
    );
    expect(
      loadConfig({
        CONCORD_MAINNET_RPC_URLS: "https://rpc.example/secret",
        CONCORD_RPC_HEADERS: JSON.stringify({ "rpc.example": { Authorization: "Bearer token" } }),
      }).networks.mainnet.rpc[0]?.headers,
    ).toEqual({ Authorization: "Bearer token" });
    for (const truthy of ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON"]) {
      expect(loadConfig({ CONCORD_EPHEMERAL: truthy }).ephemeral, truthy).toBe(true);
    }
    for (const falsy of ["0", "false", "FALSE", "False", "no", "NO", "off", "OFF"]) {
      expect(loadConfig({ CONCORD_EPHEMERAL: falsy }).ephemeral, falsy).toBe(false);
    }
    expect(loadConfig({}).ephemeral).toBe(false);
    for (const junk of ["maybe", "2", "none", "enabled"]) {
      expect(() => loadConfig({ CONCORD_EPHEMERAL: junk }), junk).toThrow(/CONCORD_EPHEMERAL must be a boolean flag/);
    }
    expect(loadConfig({ CONCORD_RPC_HEADERS: '{"mainnet.sorobanrpc.com": {"Authorization": "Bearer token"}}' })).toBeDefined();
    for (const invalid of [
      "null",
      "[]",
      '{"mainnet.sorobanrpc.com": "Bearer token"}',
      '{"mainnet.sorobanrpc.com": {"Authorization": 123}}',
      '{"mainnet.sorobanrpc.com": null}',
      '{"mainnet.sorobanrpc.com": ["header"]}',
    ]) {
      expect(() => loadConfig({ CONCORD_RPC_HEADERS: invalid }), invalid).toThrow(/CONCORD_RPC_HEADERS must be JSON/);
    }
  });

  it.each([
    {
      description: "whitespace, empty items and trailing slashes",
      input: " https://a.example/ , ,https://b.example//",
      expected: ["https://a.example", "https://b.example"],
    },
    {
      // dedupe follow-up: duplicates are currently kept as-is
      description: "duplicates are preserved",
      input: "https://a.example, https://a.example",
      expected: ["https://a.example", "https://a.example"],
    },
    {
      description: "non-http scheme throws",
      input: "ftp://x",
      error: "CONCORD_MAINNET_RPC_URLS holds something that is not a URL",
    },
    {
      description: "non-URL string throws",
      input: "not a url",
      error: "CONCORD_MAINNET_RPC_URLS holds something that is not a URL",
    },
    {
      // CON-0314: credentials in URL are rejected; configure Authorization via CONCORD_RPC_HEADERS
      description: "credentials in URL throw",
      input: "https://user:pw@a.example",
      error: "CONCORD_MAINNET_RPC_URLS must not contain URL credentials; configure Authorization via CONCORD_RPC_HEADERS",
    },
    {
      description: "blank input falls back to defaults",
      input: "   ",
      expected: loadConfig({}).networks.mainnet.rpc.map((e) => e.url),
    },
  ])("$description", ({ input, expected, error }) => {
    if (error) {
      expect(() => loadConfig({ CONCORD_MAINNET_RPC_URLS: input })).toThrow(error);
    } else {
      expect(loadConfig({ CONCORD_MAINNET_RPC_URLS: input }).networks.mainnet.rpc.map((e) => e.url)).toEqual(expected);
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
    const sleeps: number[] = [];
    const fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
      const next = answers[u]?.shift();
      if (!next) throw new TypeError("fetch failed");
      return next();
    }) as typeof globalThis.fetch;
    const deps = {
      fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock.value += ms;
      },
      now: () => clock.value,
    };
    return { calls, clock, deps, sleeps };
  }

  it("URL-encodes unusual asset and issuer values in search, describe and baseline", async () => {
    const code = "A&B?";
    const issuer = "G?X&Y";
    const h = "https://horizon.example";
    const emptyAssets = () => new Response(JSON.stringify({ _embedded: { records: [] } }));
    const emptyAccounts = () => new Response(JSON.stringify({ _embedded: { records: [] } }), {
      headers: { "latest-ledger": "42" },
    });
    const { calls, deps } = scripted({
      [`${h}/assets?asset_code=A%26B%3F&limit=200`]: [emptyAssets],
      [`${h}/assets?asset_code=A%26B%3F&asset_issuer=G%3FX%26Y&limit=200`]: [emptyAssets],
      [`${h}/accounts?asset=A%26B%3F%3AG%3FX%26Y&limit=200&order=asc`]: [emptyAccounts],
    });
    const source = new StellarSource(network(["https://rpc.example"]), deps);
    expect(await source.search(code)).toEqual([]);
    expect(await source.describe({ id: "unused", code, issuer })).toBeUndefined();
    expect(await source.baseline(code, issuer, 7)).toEqual({ ledger: 42, openings: new Map() });
    expect(calls.map((call) => call.url)).toEqual([
      `${h}/assets?asset_code=A%26B%3F&limit=200`,
      `${h}/assets?asset_code=A%26B%3F&asset_issuer=G%3FX%26Y&limit=200`,
      `${h}/accounts?asset=A%26B%3F%3AG%3FX%26Y&limit=200&order=asc`,
    ]);
  });

  it.each([
    ["600", 600_000],
    [new Date(1_600_000).toUTCString(), 600_000],
    ["not-a-retry-time", 30_000],
    ["3600", 900_000],
  ])("respects Retry-After %s for %s milliseconds", async (header, delay) => {
    const url = "https://limited.example";
    const { calls, clock, deps } = scripted({
      [url]: [() => new Response("slow down", { status: 429, headers: { "retry-after": header } }), health],
    });
    const source = new StellarSource(network([url]), deps);
    await expect(source.latestLedger()).rejects.toThrow(/rate limited/);
    await expect(source.latestLedger()).rejects.toThrow(`trying again in ${delay / 1000}s`);
    expect(calls).toHaveLength(1);
    clock.value += delay - 1_000;
    await expect(source.latestLedger()).rejects.toThrow(/not answering/);
    expect(calls).toHaveLength(1);
    clock.value += 1_000;
    await expect(source.latestLedger()).resolves.toMatchObject({ latest: 50 });
    expect(calls).toHaveLength(2);
  });

  it.each<{ name: string; header: (now: number) => string | undefined; seconds: number }>([
    { name: "seconds '40' -> 40s", header: () => "40", seconds: 40 },
    { name: "zero '0' -> 1s minimum floor", header: () => "0", seconds: 1 },
    { name: "HTTP-date 20s ahead -> 20s", header: (now) => new Date(now + 20_000).toUTCString(), seconds: 20 },
    { name: "garbage 'soon' -> 30s default", header: () => "soon", seconds: 30 },
    { name: "absent header -> 30s default", header: () => undefined, seconds: 30 },
    { name: "'999' above 900s MAX_REST_MS cap -> 900s", header: () => "999", seconds: 900 },
  ])("handles 429 Retry-After ($name)", async ({ header, seconds }) => {
    const url = "https://limited.example";
    const { calls, clock, deps } = scripted({
      [url]: [
        () => {
          const value = header(clock.value);
          return new Response("slow down", {
            status: 429,
            ...(value !== undefined ? { headers: { "retry-after": value } } : {}),
          });
        },
        health,
      ],
    });
    const source = new StellarSource(network([url]), deps);
    await expect(source.latestLedger()).rejects.toThrow(/rate limited/);
    await expect(source.latestLedger()).rejects.toThrow(`not answering; trying again in ${seconds}s`);
    expect(calls).toHaveLength(1);
  });

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
    // After the shared getHealth cache expires, the next call skips the resting endpoint.
    clock.value += 2_001;
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
      [a]: [() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "startLedger must be within the ledger range" } }))],
    });
    const source = new StellarSource(network([a, "https://b.example"]), deps);
    await expect(source.getEvents("C", { startLedger: 1 }, 10)).rejects.toThrow(/ledger range/);
    expect(calls).toHaveLength(1);
  });

  it("fails over to the next endpoint and rests the endpoint on rate-limit and transient JSON-RPC errors", async () => {
    const a = "https://a.example";
    const b = "https://b.example";
    const { calls, clock, deps } = scripted({
      [a]: [() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rate limit exceeded" } }))],
      [b]: [health, health],
    });
    const source = new StellarSource(network([a, b]), deps);
    const head = await source.latestLedger();
    expect(head.latest).toBe(50);
    expect(calls.map((c) => c.url)).toEqual([a, b]);

    // Endpoint `a` was rested, so the next call goes directly to `b` (once the head cache lapses)
    clock.value += 3_000;
    await source.latestLedger();
    expect(calls.map((c) => c.url)).toEqual([a, b, b]);

    // Also fails over on internal/behind error (-32603 or 'behind')
    const c = "https://c.example";
    const d = "https://d.example";
    const script2 = scripted({
      [c]: [() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "node is behind" } }))],
      [d]: [health],
    });
    const source2 = new StellarSource(network([c, d]), script2.deps);
    const head2 = await source2.latestLedger();
    expect(head2.latest).toBe(50);
    expect(script2.calls.map((call) => call.url)).toEqual([c, d]);
  });

  it("produces a descriptive ChainError when RPC returns null or missing result", async () => {
    const a = "https://a.example";
    const { deps: nullDeps } = scripted({
      [a]: [
        () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null })),
        () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null })),
        () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
      ],
    });
    const source = new StellarSource(network([a]), nullDeps);
    await expect(source.getEvents("C", { startLedger: 1 }, 10)).rejects.toThrow("Stellar RPC getEvents returned no result");
    await expect(source.latestLedger()).rejects.toThrow("Stellar RPC getHealth returned no result");
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
    await expect(source.describe({ id: contractId })).rejects.toThrow("Stellar RPC getLedgerEntries returned no result");
  });

  it.each([
    [400, "surfaces to caller", "surface"],
    [404, "surfaces to caller", "surface"],
    [422, "surfaces to caller", "surface"],
    [401, "rests endpoint and fails over", "failover"],
    [403, "rests endpoint and fails over", "failover"],
    [429, "rests endpoint and fails over", "failover"],
  ] as const)("classifies HTTP %i (%s)", async (status, _label, mode) => {
    const a = "https://a.example";
    const b = "https://b.example";
    const { calls, clock, deps } = scripted({
      [a]: [
        () => new Response("status response", { status, headers: status === 429 ? { "retry-after": "60" } : {} }),
        health,
      ],
      [b]: [health, health],
    });
    const source = new StellarSource(network([a, b]), deps);
    if (mode === "surface") {
      await expect(source.latestLedger()).rejects.toThrow(`HTTP ${status}`);
      expect(calls.map((c) => c.url)).toEqual([a]);
      // Request fault leaves endpoint awake: next call hits a again
      const head = await source.latestLedger();
      expect(head.latest).toBe(50);
      expect(calls.map((c) => c.url)).toEqual([a, a]);
    } else {
      // Endpoint fault rests a and fails over to b immediately
      const head = await source.latestLedger();
      expect(head.latest).toBe(50);
      expect(calls.map((c) => c.url)).toEqual([a, b]);
      // Once getHealth cache expires, subsequent call continues using b
      clock.value += 2_001;
      await source.latestLedger();
      expect(calls.map((c) => c.url)).toEqual([a, b, b]);
    }
  });

  it("rests an endpoint on 401/403 with a distinct message", async () => {
    const a = "https://a.example/bad-key";
    const b = "https://b.example";
    const { calls, deps, clock } = scripted({
      [a]: [() => new Response("unauthorized", { status: 401 })],
      [b]: [health, health],
    });
    const source = new StellarSource(network([a, b]), deps);
    const head = await source.latestLedger();
    expect(head.latest).toBe(50);
    expect(calls.map((c) => c.url)).toEqual([a, b]);
    // Once the brief getHealth cache expires, the bad-key endpoint remains rested.
    clock.value += 2_001;
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
    const first = `https://horizon.example/accounts?asset=FUND%3A${issuer}&limit=200&order=asc`;
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

  it.each([
    {
      scenario: "503, 503, 200 on page 2",
      page1Pages: 1,
      page2Responses: [
        () => new Response("", { status: 503 }),
        () => new Response("", { status: 503 }),
        () => "ok" as const,
      ],
      expectedPage1Calls: 1,
      expectedPage2Calls: 3,
      expectedSleepRanges: [
        [500, 750],
        [1000, 1250],
      ],
      expectedError: undefined,
    },
    {
      scenario: "503 x3 on one Horizon",
      page1Pages: 2,
      page2Responses: [
        () => new Response("", { status: 503 }),
        () => new Response("", { status: 503 }),
        () => new Response("", { status: 503 }),
        () => "ok" as const,
      ],
      expectedPage1Calls: 2,
      expectedPage2Calls: 4,
      expectedSleepRanges: [
        [500, 750],
        [1000, 1250],
        [250, 500],
      ],
      expectedError: undefined,
    },
    {
      scenario: "429 on page 2",
      page1Pages: 1,
      page2Responses: [
        () => new Response("slow down", { status: 429 }),
      ],
      expectedPage1Calls: 1,
      expectedPage2Calls: 1,
      expectedSleepRanges: [],
      expectedError: /rate limited/,
    },
  ])(
    "baseline() retries a failing page up to three times without restarting from page one ($scenario)",
    async ({
      page1Pages,
      page2Responses,
      expectedPage1Calls,
      expectedPage2Calls,
      expectedSleepRanges,
      expectedError,
    }) => {
      const issuer = key();
      const [h1, h2] = [key(), key()];
      const line = (balance: string) => ({
        asset_code: "FUND",
        asset_issuer: issuer,
        balance,
        is_authorized: true,
      });
      const record = (id: string, balance: string) => ({ account_id: id, balances: [line(balance)] });
      const many = Array.from({ length: 199 }, () => record(key(), "1.0000000"));
      const first = `https://horizon.example/accounts?asset=FUND%3A${issuer}&limit=200&order=asc`;
      const second = "https://horizon.example/accounts?cursor=abc&limit=200";

      const page1Response = () =>
        new Response(
          JSON.stringify({
            _links: { next: { href: second } },
            _embedded: { records: [record(h1, "70.0000000"), ...many] },
          }),
          { headers: { "latest-ledger": "150" } },
        );
      const page2Ok = () =>
        new Response(
          JSON.stringify({
            _links: {},
            _embedded: { records: [record(h2, "30.5000000")] },
          }),
          { headers: { "latest-ledger": "152" } },
        );

      const p2Answers = page2Responses.map((fn) => {
        const res = fn();
        return res === "ok" ? page2Ok : () => res;
      });

      const p1Answers = Array.from({ length: page1Pages }, () => page1Response);

      const { calls, deps, sleeps } = scripted({
        [first]: p1Answers,
        [second]: p2Answers,
      });

      const source = new StellarSource(network(["https://rpc.example"]), deps);
      const run = () => source.baseline("FUND", issuer, 7);

      if (expectedError) {
        await expect(run()).rejects.toThrow(expectedError);
      } else {
        const res = await run();
        expect(res.ledger).toBe(150);
        expect(res.openings.size).toBe(201);
      }

      // URL call counts asserted per row
      expect(calls.filter((c) => c.url === first)).toHaveLength(expectedPage1Calls);
      expect(calls.filter((c) => c.url === second)).toHaveLength(expectedPage2Calls);

      // Sleep ranges asserted
      expect(sleeps).toHaveLength(expectedSleepRanges.length);
      for (let i = 0; i < expectedSleepRanges.length; i++) {
        const [min, max] = expectedSleepRanges[i]!;
        expect(sleeps[i]).toBeGreaterThanOrEqual(min);
        expect(sleeps[i]).toBeLessThanOrEqual(max);
      }
    },
  );

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

  it("prefers Horizon contract_id in search(), derives it when absent, keeps tie order, and returns [] on empty records", async () => {
    const [i1, i2, i3] = [key(), key(), key()];
    const record = (issuer: string, authorized: number, contract_id?: string) => ({
      asset_code: "BENJI",
      asset_issuer: issuer,
      ...(contract_id ? { contract_id } : {}),
      accounts: { authorized, authorized_to_maintain_liabilities: 0, unauthorized: 0 },
      balances: { authorized: "10.0000000" },
      flags: { auth_required: false, auth_revocable: false, auth_clawback_enabled: false },
    });
    const url = "https://horizon.example/assets?asset_code=BENJI&limit=200";
    const { deps } = scripted({
      [url]: [
        () =>
          new Response(
            JSON.stringify({
              _embedded: {
                records: [
                  record(i1, 50, "CVERBATIM"),
                  record(i2, 50),
                  record(i3, 100),
                ],
              },
            }),
          ),
        () => new Response(JSON.stringify({ _embedded: { records: [] } })),
      ],
    });
    const source = new StellarSource(network(["https://rpc.example"]), deps);
    const found = await source.search("BENJI");
    expect(found.map((f) => [f.issuer, f.contractId, f.trustlines])).toEqual([
      [i3, new Asset("BENJI", i3).contractId(MAINNET_PASSPHRASE), 100],
      [i1, "CVERBATIM", 50],
      [i2, new Asset("BENJI", i2).contractId(MAINNET_PASSPHRASE), 50],
    ]);

    expect(await source.search("BENJI")).toEqual([]);
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
      [`${h1}/accounts?asset=FOO%3A${issuer}&limit=200&order=asc`]: [badBody],
      [`${h2}/accounts?asset=FOO%3A${issuer}&limit=200&order=asc`]: [okAccounts],
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

  it("stops retrying and fails immediately when budget is exceeded on the first attempt", async () => {
    const a = "https://a.example";
    const b = "https://b.example";
    const { calls, clock, deps } = scripted({
      [a]: [
        () => {
          clock.value += 95_000;
          return new Response("", { status: 503 });
        },
      ],
      [b]: [health],
    });
    const source = new StellarSource(network([a, b]), deps);
    const err = await source.latestLedger().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("a.example: HTTP 503");
    expect(calls.map((c) => c.url)).toEqual([a]);
  });

  it("retries and falls over to the next endpoint when within budget", async () => {
    const a = "https://a.example";
    const b = "https://b.example";
    const { calls, clock, deps } = scripted({
      [a]: [
        () => {
          clock.value += 10_000;
          return new Response("", { status: 503 });
        },
        () => {
          clock.value += 10_000;
          return new Response("", { status: 503 });
        },
      ],
      [b]: [health],
    });
    const source = new StellarSource(network([a, b]), deps);
    const head = await source.latestLedger();
    expect(head.latest).toBe(50);
    expect(calls.map((c) => c.url)).toEqual([a, a, b]);
  });

  it("getEvents maps cursor, latestLedger, latestLedgerCloseTime, missing events, and skips ignored events", async () => {
    const rpc = "https://rpc.example";
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
    const [a, b] = [key(), key()];
    const sym = (s: string) => nativeToScVal(s, { type: "symbol" }).toXDR("base64");
    const addr = (s: string) => nativeToScVal(s, { type: "address" }).toXDR("base64");
    const str = (s: string) => nativeToScVal(s).toXDR("base64");
    const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" }).toXDR("base64");
    const rawEvent = (id: string, topic: string[], value: string) => ({
      id,
      ledger: 120,
      ledgerClosedAt: "2026-09-21T14:13:20.000Z",
      contractId,
      txHash: `tx-${id}`,
      topic,
      value,
    });

    const eTransfer = rawEvent("001", [sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n));
    const eApprove = rawEvent("002", [sym("approve"), addr(a), addr(b), str(`FUND:${a}`)], i128(9n));
    const eMint = rawEvent("003", [sym("mint"), addr(b), str(`FUND:${a}`)], i128(12n));

    const { deps } = scripted({
      [rpc]: [
        () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                events: [eTransfer, eApprove, eMint],
                cursor: "003",
                latestLedger: 120,
                latestLedgerCloseTime: "1790000000",
              },
            }),
          ),
        () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                events: [],
                latestLedger: 121,
                latestLedgerCloseTime: "0",
              },
            }),
          ),
        () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                latestLedger: 122,
              },
            }),
          ),
      ],
    });
    const source = new StellarSource(network([rpc]), deps);

    // 1. Maps 2 tracked events (skipping approve), passes cursor, and converts latestLedgerCloseTime
    const firstPage = await source.getEvents(contractId, { startLedger: 100 }, 10);
    expect(firstPage).toEqual({
      events: [
        {
          id: "001",
          assetId: contractId,
          kind: "transfer",
          ledger: 120,
          closedAt: "2026-09-21T14:13:20.000Z",
          txHash: "tx-001",
          amount: 5n,
          from: a,
          to: b,
        },
        {
          id: "003",
          assetId: contractId,
          kind: "mint",
          ledger: 120,
          closedAt: "2026-09-21T14:13:20.000Z",
          txHash: "tx-003",
          amount: 12n,
          to: b,
        },
      ],
      cursor: "003",
      latestLedger: 120,
      latestLedgerClosedAt: "2026-09-21T14:13:20.000Z",
      skipped: 0,
    });

    // 2. '0' close time and missing cursor omit both keys (strict key equality)
    const zeroClosePage = await source.getEvents(contractId, { cursor: "003" }, 10);
    expect(zeroClosePage).toEqual({
      events: [],
      latestLedger: 121,
      skipped: 0,
    });
    expect("cursor" in zeroClosePage).toBe(false);
    expect("latestLedgerClosedAt" in zeroClosePage).toBe(false);

    // 3. Missing events array and missing latestLedgerCloseTime give [] and omit optional keys
    const missingEventsPage = await source.getEvents(contractId, { startLedger: 122 }, 10);
    expect(missingEventsPage).toEqual({
      events: [],
      latestLedger: 122,
      skipped: 0,
    });
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

  it("closes failed initialization handles across repeated schema version mismatches", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-db-init-"));
    const file = join(dir, "control.db");
    try {
      const seed = new Db(file, []);
      seed.raw.exec("PRAGMA user_version = 777");
      seed.close();
      const fds = () => existsSync("/proc/self/fd") ? readdirSync("/proc/self/fd").length : undefined;
      const before = fds();
      for (let i = 0; i < 100; i++) {
        expect(() => new Db(file, [])).toThrow(/at schema 777/);
      }
      const after = fds();
      // Linux can count open descriptors; tolerate incidental test-runner descriptors.
      if (before !== undefined && after !== undefined) {
        expect(after - before).toBeLessThan(10);
      }
      const raw = new DatabaseSync(file);
      raw.exec("PRAGMA user_version = 0");
      raw.close();
      const reopened = new Db(file, ["CREATE TABLE recovered (x INTEGER)"]);
      expect(reopened.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("releases database files after a syntax-error migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-db-migration-"));
    const file = join(dir, "tenant.db");
    try {
      expect(() => new Db(file, ["CREATE TABLE broken ("])).toThrow(/syntax|near|incomplete/i);
      const reopened = new Db(file, ["CREATE TABLE works (x INTEGER)"]);
      expect(reopened.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locks a WAL write transaction before reading to prevent stale snapshot writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-db-busy-"));
    const file = join(dir, "shared.db");
    const schema = ["CREATE TABLE tally (n INTEGER NOT NULL); INSERT INTO tally VALUES (0);"];
    let first: Db | undefined;
    let second: Db | undefined;
    try {
      first = new Db(file, schema);
      second = new Db(file, schema);
      // Keep contention tests fast: waiting longer cannot help a nested synchronous write.
      first.raw.exec("PRAGMA busy_timeout = 1");
      second.raw.exec("PRAGMA busy_timeout = 1");
      for (let i = 0; i < 20; i++) {
        first.tx(() => {
          const n = first!.get<{ n: number }>("SELECT n FROM tally")!.n;
          expect(() => second!.write("UPDATE tally SET n = n + 1")).toThrow(/locked/i);
          first!.write("UPDATE tally SET n = ?", n + 1);
        });
        second.tx(() => {
          const n = second!.get<{ n: number }>("SELECT n FROM tally")!.n;
          expect(() => first!.write("UPDATE tally SET n = n + 1")).toThrow(/locked/i);
          second!.write("UPDATE tally SET n = ?", n + 1);
        });
      }
      expect(first.get<{ n: number }>("SELECT n FROM tally")?.n).toBe(40);
      expect(second.get<{ n: number }>("SELECT n FROM tally")?.n).toBe(40);
    } finally {
      first?.close();
      second?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for an exclusive SQLite lock while enabling WAL on a newly created file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-db-wal-open-"));
    const file = join(dir, "shared.db");
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(workerData.file);
        db.exec("BEGIN EXCLUSIVE");
        parentPort.postMessage("locked");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
          parentPort.postMessage("released");
        }, 300);
      `,
      { eval: true, workerData: { file } },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve());
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`SQLite lock worker exited with ${code}`));
        });
      });
      // Busy timeout must be installed BEFORE journal_mode requests its lock.
      const opened = new Db(file, ["CREATE TABLE messages (id INTEGER)"]);
      expect(opened.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
      opened.close();
    } finally {
      await worker.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("treats a second close as a no-op and reports a closed database on later use", () => {
    const db = new Db(":memory:", ["CREATE TABLE t (k TEXT);"]);
    db.all("SELECT * FROM t");
    db.close();
    expect(() => db.close()).not.toThrow();
    // The statement above was cached; left in the cache it fails with "statement has been finalized".
    expect(() => db.all("SELECT * FROM t")).toThrow("database is not open");
    expect(() => db.tx(() => 1)).toThrow("database is not open");
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

  it("resolves relative CONCORD_DATA_DIR and CONCORD_WEB_DIR against the repo root, not the cwd", () => {
    // pnpm runs the API with its cwd at services/api; ROOT is two directories above that.
    const root = join(import.meta.dirname, "../../..");
    const cfg = loadConfig({ CONCORD_DATA_DIR: "./rel-data", CONCORD_WEB_DIR: "./rel-web" });
    expect(cfg.dataDir).toBe(join(root, "rel-data"));
    expect(cfg.webDir).toBe(join(root, "rel-web"));
    // Absolute paths are left alone, and the defaults sit under the root as well.
    expect(loadConfig({ CONCORD_DATA_DIR: "/srv/concord/data" }).dataDir).toBe("/srv/concord/data");
    expect(loadConfig({}).dataDir).toBe(join(root, "data"));
  });

  it("brackets IPv6 hosts and maps :: to 127.0.0.1 for publicUrl", () => {
    const cfgLoopback = loadConfig({ CONCORD_HOST: "::1", CONCORD_PORT: "4400" });
    expect(cfgLoopback.publicUrl).toBe("http://[::1]:4400");

    const cfgAny = loadConfig({ CONCORD_HOST: "::", CONCORD_PORT: "4400" });
    expect(cfgAny.publicUrl).toBe("http://127.0.0.1:4400");
  });

  it("loadConfig(process.env) loads .env with real environment variables taking precedence (#489)", () => {
    const origEnv = { ...process.env };
    const origLoadEnvFile = process.loadEnvFile;
    const tempDir = mkdtempSync(join(tmpdir(), "concord-env-test-"));
    const tempEnvFile = join(tempDir, ".env");
    writeFileSync(tempEnvFile, "CONCORD_PORT=5000\nCONCORD_SYNC_INTERVAL=7\n", "utf8");

    try {
      // Preset process.env.CONCORD_PORT=6000 to test precedence
      process.env.CONCORD_PORT = "6000";
      delete process.env.CONCORD_SYNC_INTERVAL;

      // Spy process.loadEnvFile to redirect to the temp .env file
      vi.spyOn(process, "loadEnvFile").mockImplementation(() => {
        origLoadEnvFile.call(process, tempEnvFile);
      });

      const config = loadConfig(process.env);
      // Environment variable (6000) beats the file (5000)
      expect(config.port).toBe(6000);
      // The file fills gaps (7)
      expect(config.syncIntervalSec).toBe(7);

      // Now test with the spy throwing ENOENT: expect defaults and no error
      vi.spyOn(process, "loadEnvFile").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      delete process.env.CONCORD_PORT;
      delete process.env.CONCORD_SYNC_INTERVAL;
      const defaultConfig = loadConfig(process.env);
      expect(defaultConfig.port).toBe(4400);
      expect(defaultConfig.syncIntervalSec).toBe(30);
    } finally {
      vi.restoreAllMocks();
      for (const key of Object.keys(process.env)) {
        if (!(key in origEnv)) delete process.env[key];
      }
      Object.assign(process.env, origEnv);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("serves static files with correct MIME types for Vite assets and falls back to octet-stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-mime-"));
    const dataDir = join(dir, "data");
    const webDir = join(dir, "web");
    mkdirSync(dataDir);
    mkdirSync(webDir);

    const testFiles: Record<string, string> = {
      "bundle.js.map": "application/json",
      "manifest.webmanifest": "application/manifest+json",
      "robots.txt": "text/plain; charset=utf-8",
      "feed.xml": "application/xml",
      "module.wasm": "application/wasm",
      "font.woff": "font/woff",
      "photo.jpg": "image/jpeg",
      "photo.jpeg": "image/jpeg",
      "anim.gif": "image/gif",
      "pic.webp": "image/webp",
      "pic.avif": "image/avif",
      "unknown.xyz": "application/octet-stream",
    };

    for (const file of Object.keys(testFiles)) {
      writeFileSync(join(webDir, file), "sample-content");
    }

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
      for (const [file, expectedMime] of Object.entries(testFiles)) {
        const res = await app.request(`/${file}`);
        expect(res.status, file).toBe(200);
        expect(res.headers.get("content-type"), file).toBe(expectedMime);
      }
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrations", () => {
  it("keeps shipped migrations append-only by pinning their digests", () => {
    const check = (name: string, migrations: readonly string[], pinned: readonly string[]) => {
      expect(
        migrationDigests(migrations),
        `${name} are append-only. Add a new migration and pin its digest instead of editing a shipped one.`,
      ).toEqual(pinned);
    };
    check("ORG_MIGRATIONS", ORG_MIGRATIONS, ORG_MIGRATION_DIGESTS);
    check("CONTROL_MIGRATIONS", CONTROL_MIGRATIONS, CONTROL_MIGRATION_DIGESTS);
  });

  it("rejects an edited shipped migration and an unpinned appended one", () => {
    const edited = [...ORG_MIGRATIONS];
    edited[0] = `${edited[0]} `;
    expect(migrationDigests(edited)).not.toEqual(ORG_MIGRATION_DIGESTS);

    const appended = [...CONTROL_MIGRATIONS, "CREATE TABLE later (id INTEGER);"];
    expect(migrationDigests(appended)).not.toEqual(CONTROL_MIGRATION_DIGESTS);
  });
});

describe("Db", () => {
  it("returns changed-row counts for UPDATE and DELETE, never a stale row id (#79)", () => {
    const db = new Db(":memory:", ["CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL);"]);
    expect(db.insert("INSERT INTO t (k, v) VALUES ('a', '1')")).toBe(1);
    expect(db.insert("INSERT INTO t (k, v) VALUES ('b', '2')")).toBe(2);
    expect(db.write("UPDATE t SET v = 'x'")).toBe(2);
    expect(db.write("UPDATE t SET v = 'y' WHERE k = 'missing'")).toBe(0);
    expect(db.write("DELETE FROM t WHERE k = 'a'")).toBe(1);
    expect(db.write("DELETE FROM t WHERE k = 'a'")).toBe(0);
    expect(db.write("INSERT OR IGNORE INTO t (k, v) VALUES ('b', 'dup')")).toBe(0);
    expect("run" in db).toBe(false);
  });
});

describe("configuration reference", () => {
  it("lists every variable the server and CLI read (#514)", () => {
    // Every CONCORD_* name in config.ts (the KNOWN list, the RETIRED map and the reads) and
    // cli.ts, plus the two bare names loadConfig reads. The lookbehind keeps
    // KNOWN_CONCORD_SETTINGS from contributing a spurious CONCORD_SETTINGS.
    const sources = [
      readFileSync(join(import.meta.dirname, "../src/config.ts"), "utf-8"),
      readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf-8"),
    ].join("\n");
    const names = new Set(
      [...sources.matchAll(/(?<![A-Z_])CONCORD_[A-Z_]+/g)].map((m) => m[0]),
    );
    for (const bare of ["PORT", "RENDER_EXTERNAL_URL"]) names.add(bare);
    const doc = readFileSync(join(import.meta.dirname, "../../../docs/CONFIGURATION.md"), "utf-8");
    const missing = [...names].filter((name) => !doc.includes(`\`${name}\``));
    expect(missing, "variables read but not documented").toEqual([]);
  });
});
