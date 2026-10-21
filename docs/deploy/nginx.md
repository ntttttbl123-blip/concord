# Running Concord behind nginx

This guide covers deploying Concord in production behind an nginx reverse proxy with automated TLS via Let's Encrypt (Certbot), correct header forwarding, proxy timeout tuning for chain indexing, upload body limits, and rate-limiting IP trust configuration.

## Overview

Concord is a single Node.js process listening on `127.0.0.1:4400` (or `0.0.0.0:4400` inside a container). It serves both the backend API and the compiled React dashboard from the same origin. In production, TLS termination and public traffic routing should be handled by a battle-tested reverse proxy like nginx.

```
                      HTTPS (443)
Client (Browser) ─────────────────────►  nginx (TLS termination)
                                             │
                                             │ HTTP (127.0.0.1:4400)
                                             ▼
                                     Concord (Node.js)
```

## Prerequisites

- Concord installed and running (via systemd or Docker) on the local host or private network.
- A registered domain name (e.g., `concord.example.com`) pointing to the server's public IP address.
- Port 80 and 443 open in the server firewall.
- `nginx` and `certbot` (with `python3-certbot-nginx`) installed:
  ```sh
  # Ubuntu / Debian
  sudo apt update
  sudo apt install -y nginx certbot python3-certbot-nginx
  ```

## Concord Environment Configuration

Before configuring nginx, verify Concord's environment variables (`.env` or systemd service unit):

```ini
# The public HTTPS URL where users access the dashboard
CONCORD_PUBLIC_URL=https://concord.example.com

# Listen locally; nginx handles external requests
CONCORD_HOST=127.0.0.1
CONCORD_PORT=4400

# Number of trusted proxy hops for X-Forwarded-For parsing
CONCORD_TRUST_PROXY=1
```

### Why `CONCORD_TRUST_PROXY=1` is required
Concord enforces in-memory rate limiting on authentication routes (sign-in, invite acceptance, password reset, and Google auth) in `services/api/src/auth-api.ts`.

The client IP is resolved via:
```ts
// services/api/src/auth-api.ts
export function clientIp(c: Context, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const seen = hops[hops.length - trustProxyHops];
    if (seen) return seen;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}
```
If `CONCORD_TRUST_PROXY` is 0 (the default in `services/api/src/config.ts`), Concord ignores `X-Forwarded-For` and attributes all requests to nginx's connecting socket address (`127.0.0.1`). Consequently, all external users share a single rate-limiting window (20 failed sign-in attempts per 10 minutes), allowing a single user's failed attempts to block login access for the entire organization.

Setting `CONCORD_TRUST_PROXY=1` instructs Concord to trust the 1 hop added by nginx, isolating rate limits to each remote client IP.

## Nginx Server Configuration

Create an nginx configuration file at `/etc/nginx/sites-available/concord`:

```nginx
# HTTP - Redirect all traffic to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name concord.example.com;

    # Let's Encrypt validation path
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS - Reverse Proxy to Concord
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name concord.example.com;

    # SSL certificates managed by Certbot
    ssl_certificate /etc/letsencrypt/live/concord.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/concord.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Upload body size limit
    # Concord enforces a 10MB limit in services/api/src/api.ts.
    # Nginx defaults to 1MB, which rejects large register/journal CSV imports.
    client_max_body_size 15M;

    # Proxy timeouts
    # Paging chain events and building opening baselines from Stellar RPC/Horizon
    # can take up to 90 seconds (BUDGET_MS in services/api/src/chain.ts).
    # Nginx defaults to 60s; raise it to prevent premature 504 Gateway Timeouts.
    proxy_connect_timeout 10s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;

    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;

        # Forwarded headers required for CORS, CSRF, and origin checks
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;

        # Buffer tuning for static assets and SSE
        proxy_buffering on;
        proxy_buffer_size 8k;
        proxy_buffers 8 8k;
    }
}
```

Enable the site and verify the syntax:
```sh
sudo ln -s /etc/nginx/sites-available/concord /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## TLS Setup with Certbot

If you do not yet have SSL certificates issued:

1. Temporarily comment out the `ssl_*` directives in the HTTPS server block, or obtain the initial certificate using Certbot's webroot/nginx plugin:
   ```sh
   sudo certbot --nginx -d concord.example.com
   ```
2. Certbot will automatically install the certificate paths and the standard cryptographic options (`options-ssl-nginx.conf`).
3. Verify automatic renewal is active:
   ```sh
   sudo systemctl status certbot.timer
   sudo certbot renew --dry-run
   ```

## Key Configuration Decisions

### 1. Upload Body Limit (`client_max_body_size 15M`)
Concord enforces route-specific payload size limits using Hono's `bodyLimit` middleware in `services/api/src/api.ts`:
- Normal API routes: `128 KB`
- Authentication routes: `16 KB`
- Books and register uploads (`/(registers|journal|instructions)$`): `10 * 1024 * 1024` (10 MB)

Nginx's default `client_max_body_size` is `1m`. If an operator uploads a register or journal CSV with thousands of positions (e.g. 3–8 MB), nginx rejects the connection with `413 Request Entity Too Large` before the payload reaches Node.js. Setting `client_max_body_size 15M` in nginx ensures Concord's own 10MB ceiling governs uploads.

### 2. Timeouts for Slow Pages and Deep Indexing (`proxy_read_timeout 120s`)
Stellar RPC queries and Horizon account queries use tiered timeouts (`services/api/src/chain.ts`):
- `PAGE_TIMEOUT_MS = 60_000` (60 seconds)
- `BUDGET_MS = 90_000` (90 seconds maximum duration across endpoint retries)

When importing a fresh asset or indexing assets with large trustline counts across thousands of ledger sequences, an API request or initial sync may take up to 90 seconds before returning. Nginx's default `proxy_read_timeout` of `60s` cuts the connection prematurely with a `504 Gateway Time-out`. Setting `proxy_read_timeout 120s` covers Concord's full retry budget with safety margin.

### 3. Session Security and Cookie Prefixes
When `CONCORD_PUBLIC_URL` begins with `https://`, Concord automatically upgrades session cookies (`services/api/src/auth-api.ts`):
- Cookie name is set to `__Host-concord_session` (preventing subdomain shadowing).
- Cookie attributes are configured with `Secure; HttpOnly; SameSite=Strict`.
- Security headers are automatically sent on all responses (`services/api/src/main.ts`):
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`

Nginx must preserve `$scheme` (`X-Forwarded-Proto https`) and `$host` so that Concord's CSRF checks on state-changing requests (`services/api/src/api.ts`) validate properly against `options.publicUrl`.

## Verification

### 1. Verify TLS and Security Headers
Inspect the HTTPS response headers using `curl`:
```sh
curl -I https://concord.example.com/api/health
```
Verify the output includes:
```http
HTTP/2 200
strict-transport-security: max-age=31536000; includeSubDomains
content-security-policy: default-src 'self'; ...
cache-control: no-store
```

### 2. Verify Client IP Forwarding
Check Concord's stdout/stderr log while submitting requests:
```sh
# Send a test sign-in attempt from an external host
curl -X POST https://concord.example.com/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"invalidpassword"}'
```
Concord should log the client's external IP address for rate-limit tracking rather than `127.0.0.1`.

### 3. Verify Large Register Uploads
Upload a CSV register larger than 1MB (up to 10MB):
```sh
curl -X POST https://concord.example.com/api/registers \
  -H "Cookie: __Host-concord_session=<token>" \
  -H "x-concord-org: <orgId>" \
  -F "file=@large_register.csv"
```
The request should be processed by Concord rather than blocked by nginx with a 413 error.
