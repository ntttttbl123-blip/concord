# Deploying Concord with Docker Compose

This guide walks through deploying Concord using Docker Compose for self-hosted production or staging environments.

---

## 1. Prerequisites & Architecture

Concord is a single stateful Node.js service that runs the API, serves the dashboard, and manages an embedded SQLite database per workspace.

When deployed in Docker:
- **Persistent Volume:** All databases and runtime state live under `/data` (configured by `CONCORD_DATA_DIR=/data` in the [`Dockerfile`](../../Dockerfile)). A persistent named volume or host bind-mount must be attached to `/data`.
- **Internal Port:** Concord listens inside the container on port `4400` as the unprivileged `node` user.
- **TLS Termination:** In production, run a reverse proxy (such as Caddy or Nginx) in front of Concord to terminate TLS and forward requests.

---

## 2. Docker Compose File

Create `docker-compose.yml`:

```yaml
services:
  concord:
    image: concord:latest
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "127.0.0.1:4400:4400"
    environment:
      - NODE_ENV=production
      - CONCORD_PUBLIC_URL=${CONCORD_PUBLIC_URL:-https://concord.example.com}
      - CONCORD_TRUST_PROXY=${CONCORD_TRUST_PROXY:-1}
      - CONCORD_SIGNUP=${CONCORD_SIGNUP:-open}
      - CONCORD_MAINNET_RPC_URLS=${CONCORD_MAINNET_RPC_URLS:-}
      - CONCORD_SYNC_INTERVAL=${CONCORD_SYNC_INTERVAL:-30}
    volumes:
      - concord-data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4400/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3

volumes:
  concord-data:
    name: concord_data
```

---

## 3. Environment Variables (`.env`)

Beside `docker-compose.yml`, create a `.env` file:

```dotenv
# Canonical public HTTPS URL for cookies and OAuth callbacks
CONCORD_PUBLIC_URL=https://concord.example.com

# Number of reverse proxy hops in front of Concord (1 if behind Caddy or Traefik)
CONCORD_TRUST_PROXY=1

# Workspace registration mode: "open" allows public signups; "code" requires an invite code
CONCORD_SIGNUP=open

# Optional dedicated Stellar RPC provider endpoints (comma-separated)
CONCORD_MAINNET_RPC_URLS=https://stellar-rpc.example.com

# Background ledger sync interval in seconds (default: 30)
CONCORD_SYNC_INTERVAL=30
```

---

## 4. Starting and Managing the Service

Start the service in the background:
```bash
docker compose up -d
```

Check logs and health status:
```bash
# Check container status and healthcheck verdict
docker compose ps

# Follow real-time application logs
docker compose logs -f concord
```

---

## 5. Healthchecks

The container healthcheck inspects `/api/health` ([`services/api/src/api.ts`](../../services/api/src/api.ts)):
```bash
docker inspect --format='{{json .State.Health}}' $(docker compose ps -q concord)
```
A status of `"healthy"` confirms:
1. The Node process is alive and responding on port `4400`.
2. The SQLite control database is mounted and accessible.
3. The background sync loop has initialized.

---

## 6. Backups from Inside the Container

Because Concord stores each workspace as a SQLite database in WAL mode under `/data/orgs/` and metadata in `/data/control.db`, snapshots should be taken using the atomic backup command:

```bash
# Run backup inside the running container as the 'node' user
docker compose exec -u node concord pnpm concord backup /data/backups/backup-$(date +%Y%m%d)

# Copy the backup out to the host
docker compose cp concord:/data/backups/backup-$(date +%Y%m%d) ./backups/
```
The built-in backup CLI locks each database in WAL mode cleanly and safely copies snapshots without stopping the service.

---

## 7. Upgrading Concord

To upgrade to a new version without data loss:

```bash
# 1. Pull the newest image or rebuild
docker compose pull concord
# Or if building locally:
# docker compose build concord

# 2. Take a safety backup
docker compose exec -u node concord pnpm concord backup /data/backup-pre-upgrade

# 3. Recreate the container with the new image
docker compose up -d --remove-orphans concord

# 4. Verify startup and schema migrations
docker compose logs --tail=50 concord
```
Any schema migrations ([`services/api/src/schema.ts`](../../services/api/src/schema.ts)) execute automatically on startup when the database connections are opened.
