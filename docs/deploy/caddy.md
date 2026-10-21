# Running Concord Behind Caddy

This guide provides a production TLS recipe for deploying Concord behind the [Caddy](https://caddyserver.com/) web server as a reverse proxy with automated HTTPS, `__Host-` session cookie hardening, and spoof-resistant rate limiting.

---

## 1. Why Caddy

Concord's server ([`services/api/src/main.ts`](../../services/api/src/main.ts)) is a single Node.js process listening by default on port `4400`. It does not terminate TLS natively or bind low ports directly.

Caddy provides:
1. **Automatic HTTPS:** Issues and renews free Let's Encrypt or ZeroSSL TLS certificates with zero manual intervention.
2. **Modern TLS & HTTP/2 / HTTP/3:** Enforces secure cipher suites out of the box.
3. **Clean Proxying:** Transparently sets `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` headers.

---

## 2. Installing Caddy

### Debian / Ubuntu
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Fedora / RHEL / CentOS
```bash
sudo dnf install 'dnf-command(copr)'
sudo dnf copr enable @caddy/caddy
sudo dnf install caddy
```

### Docker
If deploying alongside Concord via Docker Compose:
```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - concord

  concord:
    image: concord:latest
    restart: unless-stopped
    environment:
      - CONCORD_PUBLIC_URL=https://concord.example.com
      - CONCORD_TRUST_PROXY=1
    volumes:
      - concord_data:/data

volumes:
  caddy_data:
  caddy_config:
  concord_data:
```

---

## 3. The Caddyfile

Create or edit `/etc/caddy/Caddyfile`:

```caddy
concord.example.com {
    # Terminate TLS and enforce HSTS
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # Proxy to Concord Node API/dashboard
    reverse_proxy 127.0.0.1:4400 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

Reload Caddy after saving:
```bash
sudo systemctl reload caddy
```

---

## 4. Concord Configuration

Concord reads two essential environment variables to operate safely behind Caddy:

### `CONCORD_PUBLIC_URL`
Set this to the public canonical HTTPS origin:
```bash
export CONCORD_PUBLIC_URL="https://concord.example.com"
```
**Code references:** [`services/api/src/config.ts`](../../services/api/src/config.ts) and [`services/api/src/auth-api.ts`](../../services/api/src/auth-api.ts).
- When `CONCORD_PUBLIC_URL` begins with `https://`:
  - `sessions()` sets `secure = true`.
  - The session cookie name changes from `concord_session` to `__Host-concord_session`.
  - The Google OAuth state cookie changes from `concord_oauth` to `__Host-concord_oauth`.
  - The cookies are emitted with flags `Secure; HttpOnly; SameSite=Strict; Path=/`.
- If `CONCORD_PUBLIC_URL` is omitted or set to `http://`, Concord emits a warning on startup:
  `CONCORD_PUBLIC_URL is not https: sessions travel in the clear. Put TLS in front before anyone signs in.`

### `CONCORD_TRUST_PROXY=1`
Set this to the exact number of reverse proxy hops in front of Concord:
```bash
export CONCORD_TRUST_PROXY=1
```
**Code reference:** [`services/api/src/auth-api.ts:28-43`](../../services/api/src/auth-api.ts#L28-L43).
- `clientIp(c, trustProxyHops)` parses the `X-Forwarded-For` chain:
  ```typescript
  const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const seen = hops[hops.length - trustProxyHops];
  ```
- **Why `1`?** When Caddy receives a request, it appends the client's peer IP to the end of `X-Forwarded-For`. With `CONCORD_TRUST_PROXY=1`, Concord inspects `hops[hops.length - 1]`, which is the IP verified by Caddy.
- **Spoof Resistance:** If an attacker sends a crafted header `X-Forwarded-For: 1.1.1.1`, Caddy appends the attacker's actual IP (e.g. `198.51.100.2`), making the header `1.1.1.1, 198.51.100.2`. Concord selects `198.51.100.2` and ignores the spoofed `1.1.1.1`.
- **Warning on Mismatch:**
  - Setting `CONCORD_TRUST_PROXY=0` (or omitting it) makes Concord fall back to `getConnInfo(c).remote.address`, which is `127.0.0.1` (Caddy itself). All clients would then share a single rate-limit bucket.
  - Setting `CONCORD_TRUST_PROXY` too high (e.g. `2` when only 1 proxy exists) allows callers to spoof their IP by prepending fake addresses in `X-Forwarded-For`.

---

## 5. Verification Checklist

### 1. Verify HSTS & HTTPS Redirect
Run `curl -i` against the HTTP endpoint to confirm automatic redirect:
```bash
curl -i http://concord.example.com
```
Expected response: `HTTP/1.1 308 Permanent Redirect` with `Location: https://concord.example.com/`.

Inspect the HTTPS headers:
```bash
curl -sI https://concord.example.com | grep -i strict-transport-security
```
Expected output:
```http
strict-transport-security: max-age=31536000; includeSubDomains; preload
```

### 2. Verify `__Host-` Session Cookies
Authenticate or sign up via the API or dashboard:
```bash
curl -i -X POST https://concord.example.com/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@example.com","password":"your-secure-password"}'
```
Inspect the `Set-Cookie` header in the response:
```http
Set-Cookie: __Host-concord_session=...; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict
```
Key attributes to verify:
- Name is prefixed with `__Host-` (only accepted by browsers over HTTPS).
- `Path=/` is present.
- `Secure` and `HttpOnly` flags are present.
- `SameSite=Strict` prevents CSRF attacks.

### 3. Verify Rate Limiting Sees the Real Client IP
Concord enforces IP-based rate limiting on sensitive auth endpoints ([`services/api/src/auth-api.ts`](../../services/api/src/auth-api.ts)):
- `signin:<ip>`: 20 attempts per 10 minutes
- `signup:<ip>`: 20 attempts per 60 minutes
- `invite:<ip>`: 20 attempts per 10 minutes
- `reset:<ip>`: 20 attempts per 10 minutes

Test spoof resistance by sending requests with a forged `X-Forwarded-For` header:
```bash
curl -i -X POST https://concord.example.com/api/auth/signin \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-For: 10.0.0.99" \
  -d '{"email":"invalid@example.com","password":"bad-password"}'
```
Check Caddy logs or repeat 20 times: Concord will lock out your real public IP, not `10.0.0.99`. This proves `CONCORD_TRUST_PROXY=1` successfully isolates the hop appended by Caddy.
