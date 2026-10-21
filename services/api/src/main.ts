import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createApi } from "./api.js";
import { Auth } from "./auth.js";
import { StellarSource } from "./chain.js";
import type { Networks } from "./concord.js";
import { NETWORK_NAMES, loadConfig, type Config } from "./config.js";
import { Db } from "./db.js";
import { CONTROL_MIGRATIONS } from "./schema.js";
import { Tenants, fileStore } from "./tenants.js";

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

export interface Runtime {
  control: Db;
  auth: Auth;
  tenants: Tenants;
  close(): void;
}

/** Identity records, the chain sources for both networks, and the workspaces over them. */
export function openRuntime(config: Config): Runtime {
  const control = new Db(join(config.dataDir, "control.db"), CONTROL_MIGRATIONS);
  const auth = new Auth(control, { signup: config.signup, ...(config.passwordCost ? { cost: config.passwordCost } : {}) });
  const networks: Networks = {};
  for (const name of NETWORK_NAMES) {
    networks[name] = { passphrase: config.networks[name].passphrase, chain: new StellarSource(config.networks[name]) };
  }
  const tenants = new Tenants(
    fileStore(config.dataDir),
    networks,
    (orgId) => auth.orgExists(orgId),
    () => auth.orgIds(),
  );
  return {
    control,
    auth,
    tenants,
    close() {
      tenants.close();
      control.close();
    },
  };
}

export function createServerApp(runtime: Runtime, config: Config): Hono {
  const secure = config.publicUrl.startsWith("https://");
  const app = new Hono();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React sets element styles inline.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      strictTransportSecurity: secure ? "max-age=31536000; includeSubDomains" : false,
      referrerPolicy: "same-origin",
    }),
  );

  app.route(
    "/",
    createApi(runtime.tenants, runtime.auth, {
      publicUrl: config.publicUrl,
      signup: config.signup,
      ephemeral: config.ephemeral,
      networks: [...NETWORK_NAMES],
      defaultNetwork: config.defaultNetwork,
      maxAssetsPerOrg: config.maxAssetsPerOrg,
      trustProxyHops: config.trustProxyHops,
      ...(config.google ? { google: config.google } : {}),
    }),
  );

  // The built dashboard, with index.html standing in for client-side routes.
  app.get("*", (c) => {
    if (!existsSync(config.webDir)) {
      return c.text("Concord API is running. Build the dashboard with `pnpm build` to serve it here.");
    }
    let requested: string;
    try {
      requested = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Bad request", 400);
    }
    // Refuse dotfile segments (e.g. /.hidden, /a/.git/config).
    const segments = requested.split("/").filter(Boolean);
    if (segments.some((s) => s.startsWith("."))) {
      return c.text("Not found", 404);
    }

    const path = normalize(join(config.webDir, requested));
    // The separator matters: without it a sibling directory sharing the prefix would count as inside.
    const inside = path === config.webDir || path.startsWith(config.webDir + sep);
    const found = inside && existsSync(path) && statSync(path).isFile();
    // A build asset that is not there, or any missing file with an extension, is a 404; only extensionless routes fall back to the app shell.
    const lastSegment = segments[segments.length - 1] ?? "";
    const hasExtension = extname(lastSegment) !== "";
    if (!found && (hasExtension || requested.startsWith("/assets/"))) return c.text("Not found", 404);
    const file = found ? path : join(config.webDir, "index.html");
    const assetsDir = normalize(join(config.webDir, "assets"));
    const isAsset = found && (path === assetsDir || path.startsWith(assetsDir + sep));
    return c.body(new Uint8Array(readFileSync(file)), 200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      // Vite names build assets by content hash, so they never change under a given name.
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
  });

  return app;
}

export function startServer(config: Config = loadConfig()): void {
  const runtime = openRuntime(config);
  const secure = config.publicUrl.startsWith("https://");
  const app = createServerApp(runtime, config);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`concord · ${config.publicUrl} · listening on ${config.host}:${info.port}`);
    console.log(`data ${config.dataDir}`);
    if (!secure && config.host !== "127.0.0.1" && config.host !== "localhost") {
      console.warn("CONCORD_PUBLIC_URL is not https: sessions travel in the clear. Put TLS in front before anyone signs in.");
    }
    if (config.ephemeral) console.warn("CONCORD_EPHEMERAL is set: users are told their data does not survive a restart.");
  });

  let timer: NodeJS.Timeout | undefined;
  if (config.syncIntervalSec > 0) {
    let busy = false;
    const pass = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const r of await runtime.tenants.syncAll()) {
          const where = r.assetId ? `${r.orgId}/${r.assetId.slice(0, 8)}` : r.orgId;
          if (r.error) console.error(`sync ${where}: ${r.error}`);
          else if (r.added) console.log(`sync ${where}: +${r.added} events`);
        }
      } catch (err) {
        // Nothing here may take the process down; the next pass tries again.
        console.error("sync pass failed", err);
      } finally {
        busy = false;
      }
    };
    void pass();
    timer = setInterval(() => void pass(), config.syncIntervalSec * 1000);
    timer.unref();
  }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    if (timer) clearInterval(timer);
    server.close(() => {
      runtime.close();
      process.exit(0);
    });
    // A request that will not finish must not hold the databases open for ever.
    setTimeout(() => {
      runtime.close();
      process.exit(0);
    }, 8000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

function isEntry(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (isEntry()) startServer();
