import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Hono } from "hono";
import type { AssetDescription } from "../src/chain.js";
import { harness } from "./helpers.js";

/**
 * The service the Playwright smoke test drives. It is the real API over in-memory databases and
 * FakeChain, plus the built dashboard, so the browser talks to one origin and nothing leaves the
 * machine. Fixtures are exposed under /__e2e__/ for the test to read; no user-facing route knows it.
 */
const PORT = Number(process.env.E2E_PORT ?? 4402);
const publicUrl = `http://127.0.0.1:${PORT}`;
const webDir = resolve(import.meta.dirname, "../../../apps/web/dist");

// Deterministic so the fixture response and the seeded chain agree across runs.
const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
const holder = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();

const { app: api, chain } = harness({
  publicUrl,
  signup: "open",
  ephemeral: false,
  networks: ["testnet"],
  defaultNetwork: "testnet",
  maxAssetsPerOrg: 10,
  trustProxyHops: 0,
});

// FakeChain has no metadata source; say what the RPC would say for this SEP-41 token.
Object.assign(chain, {
  describe: async (): Promise<AssetDescription> => ({ decimals: 7, name: "E2E Fund" }),
});

// One holder with 100 units. The register uploaded by the test says 90, so exactly that position
// disagrees; the supply is off by the same amount and shows as a second, whole-asset break.
chain.latest = 100;
chain.push(contractId, "mint", 30, { to: holder, amount: 100n * 10_000_000n });

const registerCsv = `holder_id,holder_name,account,units,status\nH-E2E,E2E Holder,${holder},90,active\n`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const app = new Hono();
app.route("/", api);

app.get("/__e2e__/fixtures", (c) => {
  c.header("cache-control", "no-store");
  return c.json({ contractId, holder, registerCsv });
});

// The dashboard, exactly as the production server serves it: a file when it exists, otherwise the
// app shell so hash routes load. Vite assets are content hashed and safe to cache.
app.get("*", (c) => {
  if (!existsSync(webDir)) {
    return c.text("Build the dashboard first: pnpm --filter @concord/web build", 500);
  }
  let requested: string;
  try {
    requested = decodeURIComponent(c.req.path);
  } catch {
    return c.text("Bad request", 400);
  }
  const path = normalize(join(webDir, requested));
  const inside = path === webDir || path.startsWith(webDir + sep);
  const found = inside && existsSync(path) && statSync(path).isFile();
  if (!found && requested.startsWith("/assets/")) return c.text("Not found", 404);
  const file = found ? path : join(webDir, "index.html");
  return c.body(new Uint8Array(readFileSync(file)), 200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": found && requested.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: PORT }, () => {
  console.log(`concord e2e · ${publicUrl} · fixture ${contractId}`);
});

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
