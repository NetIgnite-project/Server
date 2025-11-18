# NetIgnite Server

NetIgnite Server is the server-side core of the NetIgnite / Device Power Management platform. It provides:

- HTTP/REST API for authentication and management of agents & devices
- WebSocket "Agent Control Service" for bidirectional control of registered agents (servers / microcontrollers)
- Persistence via embedded SQLite (libsql) database
- Session-based authentication (HTTP cookies)
- Automatic startup initialization (DB, default admin, session handler, agent loading)
- Extensible command system for agents (heartbeat, future commands)
- Docker-ready deployment with separate volumes for data, configuration & logs

---
## Table of Contents
1. Overview & Architecture
2. Features
3. Directory Structure (server portion)
4. Prerequisites
5. Installation & Development (Bun / Node)
6. Docker Deployment
7. Configuration (`config.json`, ENV variables)
8. Database
9. Authentication & Sessions
10. API Endpoints (excerpt)
11. Agent Control WebSocket
12. Logging & Error Handling
13. Security Notes
14. Roadmap / Extensions
15. License

---
## 1. Overview & Architecture
The server is built on Nuxt 3 (Nitro) with experimental WebSocket support enabled (`nitro.experimental.websocket = true`). At startup a bootstrap plugin (`server/plugins/startup.ts`) loads in sequence:
1. Configuration (`ConfigHandler`)
2. Database & tables (`DBStorage.init()`)
3. Default admin (if no users exist) – credentials written to `./data/initial_admin_credentials`
4. Session management (`SessionHandler.init()`)
5. Agents from the database and initialization of the `AgentControlService`

The REST API is exposed via Nitro routes under `server/api/**`. The WebSocket service manages connected agents, periodically sends heartbeats and accepts commands.

## 2. Features
- Agents (type `server` or `microcontroller`) with secret and owner assignment
- Basic Auth for WebSocket agent connections (ID:Secret)
- Session-based user login (cookie `session`)
- CRUD for agents including online/offline status queries
- Heartbeat every 60 seconds to connected agents
- Dynamic log level control (`debug`, `info`, `warn`, `error`, `critical`)
- Automatic generation of a secure admin password on first start

## 3. Directory Structure (excerpt)
```
server/
  api/
    auth/ (login, logout, session)
    agents/ (CRUD & status)
    devices/, account/, admin/ (...additional routes)
  agent-control-service/
    agent.ts (agent model & command dispatch)
    server.ts (WebSocket handler, heartbeat cron)
    index.ts (initialization & access)
  db/
    index.ts (table setup & access)
    models/ (*.ts per table)
  plugins/startup.ts (bootstrap sequence)
  utils/
    auth/ (sessions.ts, handler.ts)
    config.ts (configuration loading logic)
    logger.ts (log level handling)
```

## 4. Prerequisites
- Node.js >= 18 or Bun >= 1
- Git
- (Optional) Docker

## 5. Installation & Development
### Option A: Bun (recommended per Dockerfile)
```powershell
bun install
bun run dev  # runs via nuxt dev (port 3000 in development)
```
### Option B: Node/NPM
If you do not use Bun:
```powershell
npm install
npx nuxt dev --host 0.0.0.0 --port 3000
```
Production build (artifacts):
```powershell
bun run build        # or: npx nuxt build
```
Preview (test Nitro output):
```powershell
bun run preview      # or: npx nuxt preview
```

## 6. Docker Deployment
The provided `Dockerfile` builds a production image:
- Base: `oven/bun:1`
- Build artifact: `.output/server/index.mjs`
- Exposed port: `18232/tcp`
- Volumes:
  - `/opt/netignite/data` (SQLite DB, initial admin credentials)
  - `/opt/netignite/config` (configuration file)
  - `/opt/netignite/logs` (optional log output)

Build & run example:
```powershell
docker build -t netignite:latest ./app

docker run -d ^
  -p 18232:18232 ^
  -v netignite_data:/opt/netignite/data ^
  -v netignite_config:/opt/netignite/config ^
  -v netignite_logs:/opt/netignite/logs ^
  --name netignite netignite:latest
```

## 7. Configuration
Default file path: `./config/config.json` (override via ENV `CONFIG_FILE_PATH`). Minimal example:
```json
{}
```
Current possible fields (more planned):
- `logLevel`: `"debug" | "info" | "warn" | "error" | "critical"`
- (Agents are loaded from the DB, not the config file)

### Important ENV Variables
- `CONFIG_FILE_PATH` – custom path to configuration file
- `NITRO_ENV` – production mode (Docker sets `production`)
- `NITRO_HOST` – host bind (`0.0.0.0`)
- `NITRO_PORT` – API / web app port (default in container: `18232`)
- `NODE_ENV` – influences cookie `secure` flag for sessions

## 8. Database
- Driver: `@libsql/client` (local SQLite file) at `./data/db.sqlite`
- Tables automatically created (Users, PasswordResets, Agents, Devices)
- On first start: admin creation & credential output

## 9. Authentication & Sessions
- Login: `POST /api/auth/login` with `username`, `password`
- Successful login sets `session` cookie
- Session lifetime: 30 days (refreshed on use)
- Logout: `POST /api/auth/logout` clears the session
- Session status: `GET /api/auth/session`
Success response shape:
```json
{ "status": "OK", "data": { "userID": 1, "username": "admin", "role": "admin", "favorites": [] } }
```

## 10. API Endpoints (Agents – excerpt)
All agent routes require a valid session.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all own agents |
| POST | `/api/agents` | Create agent (`name`, `description`, `type`, `secret`) |
| GET | `/api/agents/status?ids=1,2` | Online status filtered or all own agents |
| GET | `/api/agents/{id}` | Agent detail |
| PUT | `/api/agents/{id}` | Update (changing secret disconnects existing connection) |
| DELETE | `/api/agents/{id}` | Delete agent |

Payload example (POST):
```json
{
  "name": "Server A",
  "description": "Main host",
  "type": "server", // or "microcontroller"
  "secret": "<RANDOM-STRING>"
}
```
Generic success response:
```json
{ "status": "OK", "message": "...", "data": null }
```
Errors use standard HTTP status codes (`400`, `401`, `404`, `500`).

## 11. Agent Control WebSocket
The WebSocket service manages online status & heartbeats. Agents connect using a Basic Auth header:
```
Authorization: Basic base64("<agentID>:<secret>")
```
Flow:
1. Server validates credentials & closes old connection on reconnect
2. Stores socket + peer ID for the agent
3. Cron (every minute) sends HEARTBEAT command

The concrete WebSocket path depends on Nitro deployment / config (experimental feature). Check your reverse proxy and Nitro documentation; by default the server can accept upgrades on the main port.

### Commands
- HEARTBEAT (Server → Agent)
- More via `AgentCMDRegistry` (extension potential)

## 12. Logging & Error Handling
Configurable log levels: `debug`, `info`, `warn`, `error`, `critical`. Startup failures (e.g. config or DB init) trigger process termination (`process.exit(1)`) to avoid inconsistent state.

## 13. Security Notes
- Change the admin password immediately after first start.
- Use long cryptographically random secrets for agents.
- Enable TLS (reverse proxy: Nginx / Caddy) before production use.
- Set `NODE_ENV=production` so cookies use the `secure` flag (with HTTPS).
- Restrict network access to the WebSocket port if only internal agents connect.

## 14. Roadmap / Extensions (suggestions)
- Expanded role / permission matrix (admin vs superadmin vs user granularity)
- Device-specific Wake-on-LAN actions directly via API
- Persistent agent command queue
- Token-based API auth in addition to sessions
- Encryption at rest (secret rotation)
- Metrics / Prometheus export

## 15. License
See the project license file (`LICENSE`).

---
## Quick Start (TL;DR)
```powershell
# Development
bun install
bun run dev

# First start: check file ./data/initial_admin_credentials
# Login with admin + generated password

# Docker
docker build -t netignite:latest ./app
docker run -d -p 18232:18232 netignite:latest
```

