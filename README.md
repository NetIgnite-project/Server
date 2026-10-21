# NetIgnite Server

The NetIgnite server: the dashboard, the REST API and the WebSocket gateway that NetIgnite agents
(ESP32 firmware, the agent for Linux, Windows and macOS) connect to. Power on devices from anywhere, check whether they're
online, and share them with other users.

Documentation: <https://netignite.dev/docs>

> **v2 (in development).** This branch is the rewrite on the LeiCraftMC full-stack Nuxt template.
> v1 agents can't connect to v2; set them up again after upgrading.

## Stack

- Nuxt 4 (`app/` srcDir) + NuxtUI v4 + Tailwind v4 (CSS-first)
- Hono + Zod + `hono-openapi` (Scalar) in `server/`, mounted at `/api` via a catch-all Nitro route
- Agent gateway at `/ws/agent` (Nitro WebSocket, `server/lib/agents/`)
- Drizzle ORM + `bun-sqlite`
- Bun runtime (Nitro `bun` preset)
- Biome formatter/linter
- AGPL-3.0

## Run with Docker

```bash
docker compose -f docker/docker-compose.yml up -d
```

The server listens on port **18232**. On first start it creates the user `admin` and writes a
password-reset link to `config/initial_admin_password_reset_token.txt` (also printed to the log).
Set `NETIGNITE_APP_URL` to the server's public URL; production logins need HTTPS.

### ESP32 web installer

Agents → an ESP32 agent → **Install** flashes the NetIgnite firmware from the browser (ESP Web
Tools: Chrome, Edge or Firefox 151+ on a computer) and sets up Wi-Fi over Improv; the Wi-Fi
password goes from the browser to the ESP32 only. Browsers allow USB access only on HTTPS pages
(or `localhost`), so serve NetIgnite over HTTPS.

The firmware comes from the GitHub releases of
[Agent-ESP32](https://github.com/NetIgnite-project/Agent-ESP32): the server downloads the newest
releases into `data/firmware/` on start and every 6 hours (admins: Server Settings → Sync now) and
checks each file's SHA-256. The flash image also holds the agent's setup data: the server URL, its
name and a single-use enrollment token (15 minutes). The agent generates its long-term secret
itself when it enrolls.

| Variable | Default | |
| --- | --- | --- |
| `NETIGNITE_FIRMWARE_SYNC` | `true` | Sync automatically; `false` for offline servers |
| `NETIGNITE_FIRMWARE_REPO` | `NetIgnite-project/Agent-ESP32` | GitHub repository to sync from |
| `NETIGNITE_FIRMWARE_DIR` | `./data/firmware` | Where releases are stored |
| `NETIGNITE_FIRMWARE_PUBLIC_KEY` | — | Path of a PEM ECDSA P-256 public key; then only signed releases are accepted |
| `NETIGNITE_GITHUB_TOKEN` | — | Raises GitHub's API rate limit |

### Firmware updates and console

ESP32 agents with firmware 2.0.0 or newer update over the network: the agent page shows **Update
to …** when the admin's channel has a newer release (Agents → **Update n agents** updates several
one after another). The agent downloads the image from this server with its own credential,
checks its SHA-256 (and signature, if its firmware has a public key compiled in), restarts and goes
back to the previous firmware if the new one doesn't reach the server within 5 minutes.

The agent's **Console** tab shows its live log (WebSocket `/ws/console`) and changes its log
level, server address, host name and IP settings, restarts or factory-resets it. A new server
address or IP setting is only kept if the agent reaches the server with it within 2 minutes.

### SSH shutdown and reboot

Off by default: an admin turns it on under **Server Settings** (`ssh_enabled`). For devices that
can't run the agent themselves, the device's agent in the same network (an ESP32 with firmware
2.0.0 or newer, or a Linux agent 1.0.0 or newer in Wake-on-LAN mode) logs in over SSH.

**No secrets on the server.** Each agent creates two Ed25519 key pairs of its own, one for
shutdown and one for reboot, keeps the private keys and reports only the public keys (HELLO
`ssh_keys`). A device's **SSH** tab (owner only) stores host, port, username and OS, and shows two
`authorized_keys` lines, each with a forced command (`restrict,command="sudo -n shutdown -h now"
ssh-ed25519 …`), plus the `sudoers` line. So each key can run exactly one command, also on
Windows (`shutdown /s /t 0` in `administrators_authorized_keys`). Agents only offer SSH over a TLS
connection to the server and allow at most 10 SSH logins a minute. The device's host key is
trusted on first use: test the login, compare the fingerprint, trust it.

**Prefer the agent on the device** where it runs (Linux, Windows, macOS): no login to the device
exists at all. If you use SSH, log in as a dedicated user without other rights (on Windows, an
administrator account is required for shutdown).

### The agent on Linux, Windows and macOS

The page of a Linux, Windows or macOS agent shows a one-line installer:

```bash
curl -fsSL https://<server>/install/linux.sh | sudo sh -s -- <enrollment-token>   # Linux
curl -fsSL https://<server>/install/macos.sh | sudo sh -s -- <enrollment-token>   # macOS
```

```powershell
# Windows, in PowerShell opened with "Run as administrator"
& ([scriptblock]::Create((irm https://<server>/install/windows.ps1))) <enrollment-token>
```

The scripts download the agent from the [Agent-Linux](https://github.com/NetIgnite-project/Agent-Linux)
releases (`NETIGNITE_AGENT_REPO`; the newest stable release, a pre-release only while there is
none, or the tag in `NETIGNITE_AGENT_VERSION`; the betas' `NETIGNITE_LINUX_AGENT_*` names still
work), check it against `SHA256SUMS`, pair it and install the service (systemd, launchd or a
scheduled task). Any of the three can be a device's **Agent on the device**; only the Linux agent
has Wake-on-LAN mode.

### Upgrading from v1

The v2 image uses the same `/opt/netignite/data` and `/opt/netignite/config` volumes as v1. Its
database is `data/netignite.sqlite`, so the v1 `data/db.sqlite` stays untouched. Import it once:

```bash
docker exec netignite-server bun /opt/netignite/app/.output/import-v1.mjs --from /opt/netignite/data/db.sqlite --dry-run
docker exec netignite-server bun /opt/netignite/app/.output/import-v1.mjs --from /opt/netignite/data/db.sqlite
```

- Users keep their passwords and are asked for an email address after logging in.
- The v1 `admin` is merged into the new server's `admin`. Other users with a username that already
  exists in v2 are only merged with `--merge-users`.
- Agents are imported but must be set up again; devices keep MAC address, port and agent.
- Re-running the import is safe; already imported records are skipped.

## Development

```bash
bun install
cp example.env .env
bun run dev
```

The dev server runs on <http://localhost:18232> (port 18232 in dev and prod, an exception to the
style guide's 12xxx ports kept for v1 compatibility). Endpoints: `/api/v1/**`, `/api/health`,
`/api/docs/v1` (OpenAPI reference), `/ws/agent`, `/ws/console`, `/install/linux.sh`.

After changing the API, regenerate the typed client (boots the API in-process, no server needed):

```bash
bun run api-client:generate
```

## Scripts

- `bun run dev` — dev server on port 18232 (frontend + API + agent gateway)
- `bun run build` — production build (`.output/`, Bun preset, plus `.output/import-v1.mjs`)
- `bun run start` — run the built server
- `bun run import-v1 -- --from <v1 db.sqlite> [--dry-run] [--merge-users]` — import a v1 database
- `bun run api-client:generate` — regenerate the typed API client
- `bun run db:generate` / `db:migrate` — Drizzle migrations
- `bun run check` / `bun run format` — Biome check / format
- `bun run typecheck` — `nuxt typecheck` + `tsc` (includes `server/`)
- `bun test` — run tests

## Structure

| Path | What it is |
| --- | --- |
| `server/lib/agents/` | Agent protocol, credentials, gateway, live connection registry, console relay, Linux install script |
| `server/lib/devices/` | Device permissions (sharing roles), status polling, power actions |
| `server/lib/ssh/` | SSH logins of devices (encrypted secrets, generated Ed25519 keys, host key trust) |
| `server/lib/firmware/` | Firmware catalog (GitHub release sync), NVS image writer for the web installer, OTA updates |
| `server/lib/api/versions/v1/routes/` | REST routes (`agents`, `devices`, `firmware`, `auth`, `account`, `admin`) |
| `server/lib/migration/v1Import.ts` | v1 database import |
| `app/pages/dashboard/` | Dashboard: overview, devices, agents, settings, admin |

See the LeiCraftMC style guide:

- [docs/01-project-structure.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/01-project-structure.md) — the full-stack Nuxt shape
- [docs/04-backend-hono.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/04-backend-hono.md) — Mounting Hono in Nitro
- [docs/06-frontend-nuxt.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/06-frontend-nuxt.md)

## License

AGPL-3.0
