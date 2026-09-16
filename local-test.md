# Local Test & Development Environment

How to run the SmartFace / SmartLock gateway on a developer machine, run the
unit test suite, and reach the app through the local domain
`gate-watch.vota.local`.

---

## 1. Stack Overview

A plain `docker compose up -d --build` starts two services:

| Service | Container | Image | Exposed |
| :--- | :--- | :--- | :--- |
| `smartface-app` | `smartface-local-gateway` | `smartface-app:latest` (built from `Dockerfile`) | `8080` -> container `3000` |
| `postgres` | `smartface-postgres-18` | `postgres:18-alpine` | `5432` |

A third service, `tests`, is behind the `test` profile and is never started by
a plain `up` — see [Unit Tests](#3-unit-tests).

Data lives in the named volume `smartface_postgres18_data`; `docker compose
down` preserves it, `docker compose down -v` destroys it.

---

## 2. Bringing the Environment Up

### 2.1 First run

```bash
cp .env.example .env          # only if .env does not exist yet
docker compose up -d --build
```

`deploy-local.sh` wraps the same flow and additionally detects whether port
5432 is already taken by a host PostgreSQL, in which case it starts only the
app container.

### 2.2 Verify

```bash
docker compose ps                                   # both must read (healthy)
curl -s http://localhost:8080/api/health            # {"status":"ok", ...}
curl -s http://localhost:8080/api/employees | head
docker exec smartface-postgres-18 \
  psql -U smartface_user -d smartface_db -c '\dt'   # 8 tables
```

Expected steady state:

```
NAME                      STATUS           PORTS
smartface-local-gateway   Up (healthy)     0.0.0.0:8080->3000/tcp
smartface-postgres-18     Up (healthy)     0.0.0.0:5432->5432/tcp
```

On a healthy start the app log reports the PostgreSQL handshake:

```
[PostgreSQL] Đã kết nối cơ sở dữ liệu PostgreSQL thành công (postgres/smartface_db)!
[PostgreSQL] Các bảng dữ liệu đã sẵn sàng trên PostgreSQL!
```

### 2.3 Storage modes

The backend picks its store from `DATABASE_URL`:

| Mode | `.env` setting | Start command |
| :--- | :--- | :--- |
| PostgreSQL 18 container (default) | `DATABASE_URL=postgresql://smartface_user:smartface_secret_pass@postgres:5432/smartface_db` | `docker compose up -d --build` |
| PostgreSQL on the host machine | `DATABASE_URL=postgresql://postgres:<pass>@host.docker.internal:5432/smartface_db` | `docker compose up -d --build smartface-app` |
| Native SQLite, no database server | `DATABASE_URL=` (empty) | `docker compose up -d --build smartface-app` |

> **Known issue (SQLite mode):** startup logs
> `no such table: camera_streams_config`, `door_controller_config` and
> `door_api_logs`. The SQLite initializer does not create these three tables;
> `init-db.sql` creates the first two for PostgreSQL only, and `door_api_logs`
> exists in neither schema. Harmless while PostgreSQL is the active store, but
> the SQLite-only mode is degraded.

### 2.4 Common operations

```bash
docker compose logs -f smartface-app     # follow app logs
docker compose restart smartface-app     # restart app only
docker compose down                      # stop, keep the database volume
docker compose down -v                   # stop and DESTROY the database
```

---

## 3. Unit Tests

Tests use the Node built-in runner (`node:test` + `node:assert/strict`) with
`tsx` for TypeScript, so they add no new dependencies.

| File | Covers |
| :--- | :--- |
| `tests/localBiometrics.test.ts` | Embedding generation, cosine similarity, anti-spoofing heuristic, `runLocalFaceRecognition` branching |
| `tests/api.test.ts` | `normalizeApiUrl`, `buildEventSourceUrl`, API base URL resolution |
| `tests/strangers.test.ts` | Face signature hashing and stranger clustering |

### 3.1 Run them (recommended — no local install needed)

```bash
docker compose --profile test run --rm --build tests
```

This builds the `tester` stage, which reuses the `builder` stage where
devDependencies are already installed.

Expected tail:

```
# tests 49
# suites 10
# pass 49
# fail 0
```

### 3.2 Run them on the host

Requires `node_modules` to be installed locally (needs npm registry access):

```bash
npm install
npm test          # node --import tsx --test tests/*.test.ts
npm run lint      # tsc --noEmit
```

### 3.3 One-off without compose

```bash
docker build --target tester -t smartface-tests .
docker run --rm smartface-tests
```

---

## 4. Local Domain: `gate-watch.vota.local`

### 4.1 Hosts entry

```bash
echo '127.0.0.1 gate-watch.vota.local' | sudo tee -a /etc/hosts
getent hosts gate-watch.vota.local        # -> 127.0.0.1 gate-watch.vota.local
```

On Windows the file is `C:\Windows\System32\drivers\etc\hosts`.

### 4.2 Port

The app publishes on host port **8080** (`APP_PORT` in `.env`); the container
itself always listens on 3000. So it is reached at
**`http://gate-watch.vota.local:8080`**.

Port 80 is held by the k3d load balancer (`k3d-dev-grab-serverlb`) and this
stack deliberately does not compete for it. An nginx reverse proxy is expected
to own port 80 later and forward to `127.0.0.1:8080` — see §4.6.

To use a different host port, set `APP_PORT` in `.env` and re-run
`docker compose up -d`. Nothing else needs to change.

### 4.3 CORS

The origin must be in `CORS_ALLOWED_ORIGINS`, otherwise the browser blocks API
calls. Both `.env.example` and the compose fallback ship with the direct
`:8080` origins plus the bare `http://gate-watch.vota.local` for the future
nginx proxy on port 80:

```
CORS_ALLOWED_ORIGINS="http://localhost:8080,http://127.0.0.1:8080,http://gate-watch.vota.local:8080,http://gate-watch.vota.local"
```

After changing it, restart so the container picks up the new value:

```bash
docker compose up -d
```

### 4.4 Verify

```bash
curl -s http://gate-watch.vota.local:8080/api/health

curl -s -i -X OPTIONS http://gate-watch.vota.local:8080/api/employees \
  -H 'Origin: http://gate-watch.vota.local:8080' \
  -H 'Access-Control-Request-Method: GET' | grep -i access-control-allow-origin
```

Expected:

```
{"status":"ok","time":"..."}
Access-Control-Allow-Origin: http://gate-watch.vota.local:8080
```

### 4.5 Camera access caveat

`getUserMedia` (webcam capture for face scanning) requires a secure context.
Browsers treat `localhost` / `127.0.0.1` as secure, but **not** a custom
hostname over plain HTTP. Face scanning via `http://gate-watch.vota.local:8080`
will therefore fail in Chrome unless one of the following applies:

- use `http://localhost:8080` for camera work, or
- serve the domain over HTTPS with a locally trusted certificate, or
- allowlist the origin under `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

### 4.6 Mapping the domain to an IP

`/etc/hosts` is per-machine. To reach the app from other devices, point the
name at this host's LAN IP instead of `127.0.0.1`:

```
192.168.6.52 gate-watch.vota.local
```

For network-wide resolution without editing every client, add an A record on
the LAN DNS server (dnsmasq / Pi-hole / router static DNS):

```
address=/gate-watch.vota.local/192.168.6.52
```

> **`.local` caveat:** RFC 6762 reserves `.local` for mDNS, so some systems
> (macOS especially) route it to multicast DNS and ignore the hosts entry.
> This host is fine — `/etc/nsswitch.conf` has `hosts: files dns` and
> `avahi-daemon` is inactive. Check a client with
> `grep '^hosts:' /etc/nsswitch.conf`. For a wider rollout, `.lan` or
> `.internal` avoids the problem entirely.

### 4.7 Planned nginx reverse proxy

nginx will own port 80 and forward to the published app port, which removes
the `:8080` from the URL:

```nginx
server {
    listen 80;
    server_name gate-watch.vota.local;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # /api/events is Server-Sent Events - buffering must stay off
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 24h;
    }
}
```

Port 80 is currently taken by `k3d-dev-grab-serverlb`, so nginx needs that
freed, a different port, or a host with the port available. Once nginx is in
front, consider narrowing the compose port binding to `127.0.0.1:8080:3000` so
the app is no longer directly reachable from the LAN.

---

## 5. Useful Endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/health` | Liveness probe (used by the container healthcheck) |
| `GET /api/employees` | Enrolled employee roster |
| `GET /api/access-logs` | Entry/exit history |
| `GET /api/lock/status` | Smart lock state |
| `GET /api/events` | Server-Sent Events stream |
| `GET /api/config/ai` | Face recognition engine configuration |

> `GET /api/database/status`, referenced in `README.md` and `deploy-local.sh`,
> is **not implemented** in `server.ts` and returns 404. Use
> `docker exec smartface-postgres-18 psql -U smartface_user -d smartface_db -c '\dt'`
> to inspect the database instead.

---

## 6. Troubleshooting

| Symptom | Cause / Fix |
| :--- | :--- |
| Container stays `unhealthy` but `curl` works | The healthcheck must target `127.0.0.1`, not `localhost`: BusyBox `wget` resolves `localhost` to `::1` while the server binds IPv4 `0.0.0.0`. |
| `npm ci` fails during build | No `package-lock.json` is committed (only `bun.lock`). The Dockerfile falls back to `npm install`; commit a lockfile for reproducible builds. |
| Port 5432 already allocated | A host PostgreSQL is running. Either set `POSTGRES_PORT=5433` in `.env`, or start only the app: `docker compose up -d --build smartface-app`. |
| Port 8080 already allocated | Set `APP_PORT` to a free port in `.env`, then `docker compose up -d`. |
| Browser blocks API calls from the local domain | The origin is missing from `CORS_ALLOWED_ORIGINS` — see §4.3. |
| Webcam not available on the local domain | Insecure-context restriction — see §4.5. |
| Database empty after restart | `docker compose down -v` was used, which drops `smartface_postgres18_data`. |
