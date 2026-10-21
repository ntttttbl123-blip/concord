import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { templateCsv } from "@concord/core";
import { Auth, Conflict, Forbidden, Rejected, Unauthorized, type SessionInfo } from "./auth.js";
import { authRoutes, clientIp, jsonBody, me, sessions, type ApiOptions } from "./auth-api.js";
import { ChainError } from "./chain.js";
import { isNetworkName } from "./config.js";
import { Concord, Invalid, NotFound, type ActionInput, type Actor, type NoteInput } from "./concord.js";
import { RateLimiter, TooMany } from "./security.js";
import type { Tenants } from "./tenants.js";

export type { ApiOptions } from "./auth-api.js";

type Env = { Variables: { ws: Concord; session: SessionInfo; actor: Actor } };

const KB = 1024;

/** Keeps a download's name to characters every browser and header parser accepts. */
const fileSafe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";

export function createApi(tenants: Tenants, auth: Auth, options: ApiOptions): Hono {
  const app = new Hono();
  const limiter = options.limiter ?? new RateLimiter();
  const cookies = sessions(auth, options);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof TooMany) {
      c.header("retry-after", String(err.retryAfter));
      return c.json({ error: err.message }, 429);
    }
    const status: ContentfulStatusCode =
      err instanceof NotFound
        ? 404
        : err instanceof Invalid || err instanceof Rejected
          ? 400
          : err instanceof Unauthorized
            ? 401
            : err instanceof Forbidden
              ? 403
              : err instanceof Conflict
                ? 409
                : err instanceof ChainError
                  ? 502
                  : 500;
    if (status === 500) {
      // Whatever went wrong here is ours to read in the log, not the caller's.
      console.error(err);
      return c.json({ error: "Something went wrong on the server." }, 500);
    }
    return c.json({ error: err.message }, status);
  });

  const tooLarge = (c: Context) => c.json({ error: "That upload is too large." }, 413);
  const small = bodyLimit({ maxSize: 16 * KB, onError: tooLarge });
  const normal = bodyLimit({ maxSize: 128 * KB, onError: tooLarge });
  const upload = bodyLimit({ maxSize: 10 * KB * KB, onError: tooLarge });

  app.use("/api/*", async (c, next) => {
    c.header("cache-control", "no-store");
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      // The session rides in a cookie, so a state-changing request must show it came from our
      // own pages. Browsers state that in Sec-Fetch-Site; anything else has to name our origin.
      const site = c.req.header("sec-fetch-site");
      const sameOrigin = site ? site === "same-origin" : c.req.header("origin") === options.publicUrl;
      if (!sameOrigin) return c.json({ error: "This request did not come from the Concord dashboard." }, 403);
    }
    const path = c.req.path;
    const limit = path.startsWith("/api/auth/") ? small : /\/(registers|journal|instructions)$/.test(path) ? upload : normal;
    return limit(c, next);
  });

  app.get("/api/health", (c) => {
    auth.orgIds();
    return c.json({ ok: true });
  });

  app.route("/api/auth", authRoutes(auth, { ...options, limiter }));

  // Everything below is a workspace route. The session check is the first thing on this
  // router, so no route here can be reached without one, and each sees only its own workspace.
  const priv = new Hono<Env>();
  priv.use("*", async (c, next) => {
    const session = cookies.read(c);
    if (!session) throw new Unauthorized("Sign in to continue.");
    // A tab still showing another workspace must not act on this one.
    const shown = c.req.header("x-concord-org");
    if (shown && shown !== session.org.id) throw new Conflict("This tab is showing a different workspace. Reload it.");
    c.set("session", session);
    c.set("ws", tenants.forOrg(session.org.id));
    c.set("actor", { id: session.user.id, label: `${session.user.name} <${session.user.email}>` });
    await next();
  });

  const owner = (c: Context<Env>) => {
    if (c.var.session.role !== "owner") throw new Forbidden("Only a workspace owner can do that.");
  };
  const period = (c: Context) => {
    const out: { from?: string; to?: string } = {};
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (from) out.from = from;
    if (to) out.to = to;
    return out;
  };
  const numeric = (c: Context, name: string) => {
    const n = Number(c.req.param(name));
    if (!Number.isInteger(n)) throw new NotFound("not found");
    return n;
  };
  const id = (c: Context) => c.req.param("id") ?? "";
  /** Caps how often one person can make Concord call the ledger's public services on demand. */
  const throttle = (c: Context<Env>, what: string, max: number, windowMs: number) => {
    const wait = limiter.hit(`${what}:${c.var.session.user.id}`, max, windowMs);
    if (wait > 0) throw new TooMany(wait);
  };

  // ── workspace and team ────────────────────────────────────────────────────

  priv.get("/org/members", (c) => {
    const { session } = c.var;
    return c.json({
      members: auth.members(session.org.id),
      invites: session.role === "owner" ? auth.invites(session.org.id) : [],
    });
  });
  priv.post("/org/invites", async (c) => {
    owner(c);
    const input = await jsonBody<{ email: unknown; role?: unknown }>(c);
    const invite = auth.createInvite(c.var.session, input.email, input.role);
    const { token, ...rest } = invite;
    return c.json({ ...rest, link: `${options.publicUrl}/#/invite/${token}` }, 201);
  });
  priv.delete("/org/invites/:inviteId", (c) => {
    owner(c);
    auth.revokeInvite(c.var.session.org.id, c.req.param("inviteId"));
    return c.json({ ok: true });
  });
  priv.patch("/org/members/:userId", async (c) => {
    owner(c);
    const input = await jsonBody<{ role: unknown }>(c);
    auth.setRole(c.var.session.org.id, c.req.param("userId"), input.role);
    return c.json({ ok: true });
  });
  priv.delete("/org/members/:userId", (c) => {
    const { session } = c.var;
    // Anyone may leave; removing someone else takes an owner.
    if (c.req.param("userId") !== session.user.id) owner(c);
    auth.removeMember(session.org.id, c.req.param("userId"));
    return c.json({ ok: true });
  });
  priv.patch("/org", async (c) => {
    owner(c);
    const input = await jsonBody<{ name: unknown }>(c);
    auth.renameOrg(c.var.session.org.id, input.name);
    return c.json(me(auth, cookies.read(c)!));
  });
  priv.delete("/org", async (c) => {
    owner(c);
    const { session } = c.var;
    const input = await jsonBody<{ confirm: unknown }>(c);
    if (input.confirm !== session.org.name) throw new Invalid("Type the workspace name exactly to delete it.");
    auth.deleteOrg(session.org.id);
    tenants.drop(session.org.id);
    cookies.end(c);
    return c.json({ ok: true });
  });

  // ── assets ────────────────────────────────────────────────────────────────

  priv.get("/overview", (c) => {
    const network = c.req.query("network");
    return c.json(c.var.ws.overview(isNetworkName(network) ? network : undefined));
  });

  priv.get("/lookup", async (c) => {
    throttle(c, "lookup", 30, 60_000);
    const network = c.req.query("network");
    if (!isNetworkName(network)) throw new Invalid("network must be mainnet or testnet");
    return c.json(await c.var.ws.lookup(network, c.req.query("code") ?? ""));
  });

  priv.post("/assets", async (c) => {
    const { ws, actor } = c.var;
    throttle(c, "watch", 20, 10 * 60_000);
    if (ws.assets().length >= options.maxAssetsPerOrg) {
      throw new Invalid(`A workspace can watch ${options.maxAssetsPerOrg} assets. Stop watching one to add another.`);
    }
    const input = await jsonBody<{ network: unknown; asset: unknown; name?: string; ignore?: string[]; decimals?: number }>(c);
    if (!isNetworkName(input.network)) throw new Invalid("network must be mainnet or testnet");
    // The starting ledger is not the caller's to choose here; the service works it out.
    const asset = await ws.watchAsset(
      {
        network: input.network,
        asset: String(input.asset ?? ""),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.ignore !== undefined ? { ignore: input.ignore } : {}),
        ...(input.decimals !== undefined ? { decimals: input.decimals } : {}),
      },
      { defer: true, actor },
    );
    return c.json(ws.assetSummary(asset), 201);
  });
  priv.get("/assets/:id", (c) => c.json(c.var.ws.assetSummary(c.var.ws.asset(id(c)))));
  priv.patch("/assets/:id", async (c) =>
    c.json(c.var.ws.updateAsset(id(c), await jsonBody<{ name?: string; ignore?: string[] }>(c))),
  );
  priv.delete("/assets/:id", async (c) => {
    owner(c);
    await c.var.ws.unwatchAsset(id(c));
    return c.json({ ok: true });
  });
  priv.post("/assets/:id/sync", async (c) => {
    throttle(c, "sync", 60, 10 * 60_000);
    return c.json(await c.var.ws.sync(id(c)));
  });
  priv.post("/assets/:id/rebuild", async (c) => {
    const { ws } = c.var;
    throttle(c, "watch", 20, 10 * 60_000);
    return c.json(ws.assetSummary(await ws.rebuild(id(c), { defer: true })));
  });

  priv.get("/assets/:id/holdings", (c) => c.json(c.var.ws.holdings(id(c), c.req.query("asOf"))));
  priv.get("/assets/:id/events", (c) => {
    const filter: { kind?: string; address?: string; limit?: number; before?: string } = {};
    const { kind, address, limit, before } = c.req.query();
    if (kind) filter.kind = kind;
    if (address) filter.address = address;
    if (before) filter.before = before;
    if (limit) filter.limit = Number(limit);
    return c.json(c.var.ws.events(id(c), filter));
  });

  // ── books ─────────────────────────────────────────────────────────────────

  priv.get("/templates/:kind", (c) => {
    const kind = c.req.param("kind").replace(/\.csv$/, "");
    const example = c.req.query("example");
    const csv = templateCsv(kind, { example: example === "1" || example === "true" });
    if (csv === undefined) throw new NotFound("no such template");
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="concord-${kind}-template.csv"`);
    return c.body(csv);
  });

  priv.get("/assets/:id/registers", (c) => c.json(c.var.ws.registers(id(c))));
  priv.post("/assets/:id/registers", async (c) => {
    const { ws, actor } = c.var;
    const input = await jsonBody<{ csv: string; asOf: string; source?: string; reconcile?: boolean }>(c);
    if (typeof input.csv !== "string" || typeof input.asOf !== "string") throw new Invalid("csv and asOf are required");
    const imported = ws.importRegister(id(c), input, actor);
    const run = input.reconcile === false ? null : await ws.reconcile(id(c), imported.registerId, actor);
    return c.json({ ...imported, run }, 201);
  });
  priv.delete("/assets/:id/registers/:registerId", (c) => {
    c.var.ws.deleteRegister(id(c), numeric(c, "registerId"));
    return c.json({ ok: true });
  });
  priv.post("/assets/:id/journal", async (c) => {
    const input = await jsonBody<{ csv: string }>(c);
    if (typeof input.csv !== "string") throw new Invalid("csv is required");
    return c.json(c.var.ws.importJournal(id(c), input.csv), 201);
  });
  priv.post("/assets/:id/instructions", async (c) => {
    const input = await jsonBody<{ csv: string }>(c);
    if (typeof input.csv !== "string") throw new Invalid("csv is required");
    return c.json(c.var.ws.importInstructions(id(c), input.csv), 201);
  });

  // ── reconciliation ────────────────────────────────────────────────────────

  priv.get("/assets/:id/reconciliations", (c) => c.json(c.var.ws.runs(id(c))));
  priv.post("/assets/:id/reconciliations", async (c) => {
    const input = Number(c.req.header("content-length") ?? 0) > 0 ? await jsonBody<{ registerId?: number }>(c) : {};
    return c.json(await c.var.ws.reconcile(id(c), input.registerId, c.var.actor), 201);
  });
  priv.get("/reconciliations/:id", (c) => c.json(c.var.ws.run(numeric(c, "id"))));

  priv.get("/assets/:id/actions", (c) => c.json(c.var.ws.actions(id(c))));
  priv.post("/assets/:id/actions", async (c) =>
    c.json(await c.var.ws.createAction(id(c), await jsonBody<ActionInput>(c), c.var.actor), 201),
  );
  priv.get("/actions/:id", (c) => c.json(c.var.ws.action(numeric(c, "id"))));
  priv.post("/actions/:id/reconcile", async (c) => c.json(await c.var.ws.reconcileAction(numeric(c, "id"))));

  priv.get("/assets/:id/controls", (c) => c.json(c.var.ws.controls(id(c))));

  priv.put("/assets/:id/notes", async (c) => {
    const input = await jsonBody<NoteInput & { scope: string; key: string }>(c);
    if (!input.scope || !input.key || typeof input.fingerprint !== "string") {
      throw new Invalid("scope, key and fingerprint are required");
    }
    // Only these three fields are taken from the caller. Who signed is the session's user.
    const note: NoteInput = { fingerprint: input.fingerprint, status: input.status, note: input.note };
    return c.json(c.var.ws.setNote(id(c), input.scope, input.key, note, c.var.actor));
  });

  priv.get("/assets/:id/export", (c) => {
    const { ws } = c.var;
    const asset = ws.asset(id(c));
    const section = c.req.query("section");
    const name = `concord-${fileSafe(asset.code)}`;
    const stamp = new Date().toISOString().slice(0, 10);
    if (section) {
      const csv = ws.exportCsv(asset.id, section, period(c));
      c.header("content-type", "text/csv; charset=utf-8");
      c.header("content-disposition", `attachment; filename="${name}-${fileSafe(section)}-${stamp}.csv"`);
      return c.body(csv);
    }
    const pack = ws.auditExport(asset.id, period(c));
    if (c.req.query("download")) {
      c.header("content-disposition", `attachment; filename="${name}-audit-${stamp}.json"`);
    }
    return c.json(pack);
  });

  app.route("/api", priv);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  return app;
}

export { clientIp };
