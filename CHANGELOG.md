# Changelog

## 2.1.1 (2026-10-26)

- **Security:** nodemailer 10.2.1 (was 9.x). It fixes three advisories in nodemailer's address
  parser and DNS cache, one of them high (quadratic backtracking on a crafted email address).
  Sending email works as before.

## 2.1.0 (2026-10-26)

- **SSH without secrets on the server.** The server no longer stores SSH passwords or private keys.
  Each agent (the next ESP32 firmware and Agent-Linux 1.1.0, Linux in Wake-on-LAN mode) creates
  two key pairs of its own, one for shutdown and one for reboot, and reports only the public keys.
  The SSH tab shows one `authorized_keys` line per key with a forced command, so each key can run
  exactly its command, on Windows too. Requests are renamed: `SSH_EXEC` is now `SSH_POWER`, the
  capability `ssh` is now `ssh.power`, and neither carries credentials. Agents only offer SSH over
  TLS and allow 10 SSH logins a minute. Agents from 2.0.0 (ESP32) and 1.0.0 (Linux) keep working,
  but without SSH until they are updated.
- **SSH is off by default.** Admins turn it on under Server Settings (`ssh_enabled`).
- **Windows and macOS agents.** New agent kinds `windows` and `macos` (Agent-Linux 1.1.0 runs on
  both), with install scripts at `/install/windows.ps1` and `/install/macos.sh`. Any Linux,
  Windows or macOS agent can be a device's **Agent on the device** (was "Linux agent on the
  device"). `NETIGNITE_AGENT_REPO` / `NETIGNITE_AGENT_VERSION` replace
  `NETIGNITE_LINUX_AGENT_REPO` / `_VERSION`, which still work.
- `NETIGNITE_SECRETS_KEY` is gone. After updating from 2.0.0: remove the old `authorized_keys`
  lines that the server generated (or the password logins) from your devices, delete
  `config/secrets.key`, update the agents, turn SSH on, and add the two new lines from each
  device's SSH tab.

## 2.0.0 (2026-10-21)

The first stable release of NetIgnite v2: the server rewritten from scratch, with new agents for
the ESP32 (firmware 2.0.0) and for Linux (Agent-Linux 1.0.0). It includes everything from
2.0.0-beta.1 and 2.0.0-beta.2 below.

### Upgrading from v1 (0.1.x)

- **The `latest` image is now v2.** A v1 server that pulls it starts v2 with an empty database next
  to the v1 one. The v1 users, agents and devices stay in `data/db.sqlite` until you import them,
  and the server log says so on every start. To stay on v1 for now, use
  `ghcr.io/netignite-project/server:0.1.3`.
- Follow the [upgrade guide](https://netignite.dev/docs/server/upgrading): back up, start v2 with
  the same volumes plus `NETIGNITE_APP_URL`, run `import-v1`, then set up the agents again.
- v1 agents can't connect to v2. Install the ESP32 firmware 2.0.0 once over USB with the
  dashboard's web installer; replace v1 "server" agents with the Linux agent.

### What's new since v1

- Wake-on-LAN through an ESP32 or Linux agent, and status checks by MAC (IPv6 link-local), IPv4,
  IPv6, TCP port, SSH port or the Linux agent on the device.
- Shutdown and reboot through the Linux agent on the device (recommended), or over SSH with a login
  restricted to these two commands.
- Sharing devices with other users as viewer, operator or manager.
- ESP32 web installer, firmware updates over the network with automatic rollback, and a console.
- Linux agent with a one-line installer.
- Installable as an app (PWA); REST API with API keys and an OpenAPI reference at `/api/docs/v1`.

### Changes since 2.0.0-beta.2

- On start, the server warns when it finds a v1 database (`data/db.sqlite`) that hasn't been
  imported, with the import command.
- The Linux agent install script installs the newest stable Agent-Linux release, and a pre-release
  only while there is none (before: the newest release, pre-releases included).

## 2.0.0-beta.2 (2026-10-21)

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
  use. Passwords and keys are stored encrypted and never returned by the API. The tab recommends
  the Linux agent instead where it runs, asks for a dedicated user that may only shut down and
  reboot, and warns about `root` and administrator logins (Windows, which only shuts down for
  administrators, gets its own advice).
- **Installable as an app (PWA):** web app manifest, icons and a service worker that only shows an
  offline page when the server can't be reached.

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
