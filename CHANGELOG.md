# Changelog

## 2.0.0-beta.2 (unreleased)

### New

- **ESP32 web installer.** An ESP32 agent's **Install** tab flashes the firmware from the browser
  (ESP Web Tools; Chrome, Edge or Firefox 151+ over HTTPS) together with the agent's setup data:
  the server URL, its name and a single-use enrollment token. Wi-Fi is entered in the browser and
  goes to the ESP32 only. Reinstalling or changing Wi-Fi works the same way.
- **Firmware catalog.** The server downloads ESP32 firmware from the
  [Agent-ESP32](https://github.com/NetIgnite-project/Agent-ESP32) GitHub releases on start and every
  6 hours and checks every file's SHA-256 (and the signature with `NETIGNITE_FIRMWARE_PUBLIC_KEY`).
  Admins pick the stable or pre-release channel and can sync manually under Server Settings.
- **Firmware updates over the network** for ESP32 agents with firmware 2.0.0-beta.2 or newer, one
  agent or several one after another. A new firmware that doesn't reach the server within
  5 minutes goes back to the previous one, and the dashboard shows the failed update.
- **Console** tab for ESP32 agents: live log, log level, server address, host name and IP settings
  (tried before they are kept), restart and factory reset.
- **Linux agent installer:** a Linux agent's page shows
  `curl -fsSL https://<server>/install/linux.sh | sudo sh -s -- <token>`, which downloads the
  [Agent-Linux](https://github.com/NetIgnite-project/Agent-Linux) binary for the machine's CPU,
  checks it against `SHA256SUMS`, pairs it and installs the systemd service.
- **SSH shutdown and reboot.** A device's **SSH** tab (owner only) stores a login: an Ed25519 key
  pair the server generates (with ready-made `authorized_keys` and `sudoers` lines that allow only
  shutdown and reboot) or a password. The device's agent logs in; host keys are trusted on first
  use. Passwords and keys are stored encrypted and never returned by the API.

### Changed

- Enrollment takes the agent's kind and refuses a token of another kind (409) without using it up.
- The ESP32 setup data writes the agent's name as a valid host name ("Garage ESP32" → "Garage-ESP32").

### Configuration

New, all optional: `NETIGNITE_FIRMWARE_SYNC`, `NETIGNITE_FIRMWARE_REPO`, `NETIGNITE_FIRMWARE_DIR`
(Docker: `/opt/netignite/data/firmware`), `NETIGNITE_FIRMWARE_PUBLIC_KEY`, `NETIGNITE_GITHUB_TOKEN`,
`NETIGNITE_LINUX_AGENT_REPO`, `NETIGNITE_LINUX_AGENT_VERSION`, `NETIGNITE_SECRETS_KEY` (default: a
key generated in `config/secrets.key`; back it up with the database).

### Upgrading from 2.0.0-beta.1

The database migrations run on start. ESP32 agents with firmware 2.0.0-beta.1 keep working but
can't be updated over the network or log in over SSH: install firmware 2.0.0-beta.2 once with the
web installer.

## 2.0.0-beta.1 (2026-10-20)

The server rewritten on the LeiCraftMC full-stack Nuxt template (Nuxt 4, Hono, Drizzle on SQLite,
Bun). Not compatible with v1 agents.

- Dashboard: overview with favorites, devices, agents, account settings, admin area.
- Agents (ESP32 firmware v2, Linux agent) enroll with a single-use token and generate their own
  secret; protocol v2 over `/ws/agent`.
- Devices: Wake-on-LAN, status checks by MAC (IPv6 link-local), IPv4, IPv6, SSH port or a Linux
  agent running on the device; shutdown and reboot through that agent.
- Sharing devices with other users as viewer, operator or manager.
- Users: initial admin through a password-reset link, optional public sign-up, API keys, OpenAPI
  reference at `/api/docs/v1`.
- One-time import of a v1 database (`import-v1`).
- Port 18232 and the `/opt/netignite/data` and `/opt/netignite/config` volumes as in v1; the
  database is `data/netignite.sqlite`.
