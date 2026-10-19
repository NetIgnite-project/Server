# NetIgnite Server

The NetIgnite server: the dashboard, the REST API and the WebSocket gateway that NetIgnite agents
(ESP32 firmware, Linux agent) connect to. Power on devices from anywhere, check whether they're
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
`/api/docs/v1` (OpenAPI reference), `/ws/agent`.

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
| `server/lib/agents/` | Agent protocol, credentials, gateway and live connection registry |
| `server/lib/devices/` | Device permissions (sharing roles), status polling, power actions |
| `server/lib/api/versions/v1/routes/` | REST routes (`agents`, `devices`, `auth`, `account`, `admin`) |
| `server/lib/migration/v1Import.ts` | v1 database import |
| `app/pages/dashboard/` | Dashboard: overview, devices, agents, settings, admin |

See the LeiCraftMC style guide:

- [docs/01-project-structure.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/01-project-structure.md) — the full-stack Nuxt shape
- [docs/04-backend-hono.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/04-backend-hono.md) — Mounting Hono in Nitro
- [docs/06-frontend-nuxt.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/06-frontend-nuxt.md)

## License

AGPL-3.0
