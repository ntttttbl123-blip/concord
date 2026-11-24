import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { createServerApp, createStaticHandler, type Runtime } from "../src/main.js";
import { CONTROL_MIGRATIONS } from "../src/schema.js";
import { Tenants, fileStore } from "../src/tenants.js";

describe("static handler path traversal", () => {
  let tempDir: string;
  let webDir: string;
  let siblingDir: string;
  let app: Hono;
  const siblingContent = "secret sibling content";

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concord-static-traversal-"));
    webDir = join(tempDir, "web");
    siblingDir = join(tempDir, "web-sibling");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<html>app shell</html>");
    writeFileSync(join(webDir, "assets", "a.js"), "console.log('a');");
    writeFileSync(join(siblingDir, "f.txt"), siblingContent);

    app = new Hono();
    app.get("*", createStaticHandler(webDir));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const cases: Array<{ path: string; expectedStatus: number }> = [
    { path: "/%2e%2e/web-sibling/f.txt", expectedStatus: 404 },
    { path: "/..%2fweb-sibling%2ff.txt", expectedStatus: 404 },
    { path: "/%252e%252e/x", expectedStatus: 200 },
    { path: "//etc/passwd", expectedStatus: 200 },
    { path: "/..%5cweb-sibling%5cf.txt", expectedStatus: 404 },
    { path: "/assets/%00", expectedStatus: 404 },
    { path: "/assets/%ZZ", expectedStatus: 400 },
    { path: "/../web-sibling/f.txt", expectedStatus: 404 },
    { path: "/%2e%2e%2fweb-sibling%2ff.txt", expectedStatus: 404 },
  ];

  for (const { path, expectedStatus } of cases) {
    it(`never exposes sibling content and returns ${expectedStatus} for ${path}`, async () => {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status).toBe(expectedStatus);
      const text = await res.text();
      expect(text).not.toContain(siblingContent);
    });
  }
});

/**
 * The headers `secureHeaders` in main.ts sets (CON-0374). A dependency bump could silently
 * weaken them, so this test pins the exact strings on both a static response and an API
 * response, for an http origin and an https origin.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const HSTS = "max-age=31536000; includeSubDomains";

/** The real server app over a throwaway data directory and a one-file dashboard. */
function serve(publicUrl: string): { app: Hono; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
  const webDir = join(dir, "web");
  const dataDir = join(dir, "data");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
  const cfg = loadConfig({
    CONCORD_DATA_DIR: dataDir,
    CONCORD_WEB_DIR: webDir,
    CONCORD_SIGNUP: "open",
    CONCORD_PUBLIC_URL: publicUrl,
  });
  const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
  const auth = new Auth(control, { signup: "open" });
  const tenants = new Tenants(
    fileStore(dataDir),
    {},
    () => false,
    () => [],
  );
  const runtime: Runtime = {
    control,
    auth,
    tenants,
    close: () => {
      tenants.close();
      control.close();
    },
  };
  const app = createServerApp(runtime, cfg);
  return {
    app,
    close: () => {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("security headers", () => {
  it("sends the exact CSP, nosniff, referrer policy and frame options on static and API responses, without HSTS over http", async () => {
    const { app, close } = serve("http://127.0.0.1:4400");
    try {
      for (const path of ["/", "/api/health"]) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-security-policy")).toBe(CSP);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBe("same-origin");
        expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(res.headers.get("strict-transport-security")).toBeNull();
      }
    } finally {
      close();
    }
  });

  it("sends HSTS over https and keeps the other headers identical", async () => {
    const { app, close } = serve("https://concord.example.com");
    try {
      for (const path of ["/", "/api/health"]) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-security-policy")).toBe(CSP);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBe("same-origin");
        expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(res.headers.get("strict-transport-security")).toBe(HSTS);
      }
    } finally {
      close();
    }
  });
});
