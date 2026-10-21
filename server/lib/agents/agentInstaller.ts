import type { ConfigHandler } from "../utils/config";

/**
 * The agent's install scripts, served at `/install/linux.sh`, `/install/macos.sh` and
 * `/install/windows.ps1`:
 *
 *   curl -fsSL https://<server>/install/linux.sh | sudo sh -s -- <enrollment-token>
 *   curl -fsSL https://<server>/install/macos.sh | sudo sh -s -- <enrollment-token>
 *   & ([scriptblock]::Create((irm https://<server>/install/windows.ps1))) <enrollment-token>
 *
 * Each downloads the agent binary for the machine from the Agent-Linux GitHub releases (every
 * platform's binaries are there), checks it against the release's SHA256SUMS, pairs it with this
 * server (if a token is given) and installs the service.
 */
export class AgentInstaller {
	static readonly DEFAULT_REPO = "NetIgnite-project/Agent-Linux";

	/** The settings from the server's config (see AGENT_REPO, AGENT_VERSION). */
	static optionsFrom(config: ReturnType<typeof ConfigHandler.getConfig>): AgentInstaller.Options {
		return {
			serverURL: (config?.APP_URL ?? "").replace(/\/$/, ""),
			repo: config?.AGENT_REPO ?? config?.LINUX_AGENT_REPO ?? AgentInstaller.DEFAULT_REPO,
			version: config?.AGENT_VERSION ?? config?.LINUX_AGENT_VERSION ?? null,
		};
	}
	static linux(options: AgentInstaller.Options) {
		const header = AgentInstaller.shellHeader(options, "linux.sh", "Linux");
		return `${header}
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v systemctl >/dev/null 2>&1 || fail "the agent needs systemd"
[ "$(uname -s)" = "Linux" ] || fail "this script is for Linux (macOS: $SERVER/install/macos.sh)"

case "$(uname -m)" in
	x86_64 | amd64)
		# The default build needs AVX2; older CPUs get the baseline build.
		if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then ARCH=x64; else ARCH=x64-baseline; fi
		;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) fail "unsupported CPU: $(uname -m) (supported: x86-64, 64-bit ARM)" ;;
esac
FILE="netignite-agent-linux-$ARCH"
${AgentInstaller.shellDownload()}
(
	cd "$TMP"
	grep -E "[ *]$FILE\\$" SHA256SUMS | sed "s/[ *]*$FILE\\$/  $FILE/" >"$FILE.sha256"
	[ -s "$FILE.sha256" ] || fail "SHA256SUMS has no entry for $FILE"
	sha256sum -c "$FILE.sha256" >/dev/null
) || fail "the download doesn't match SHA256SUMS"
chmod 755 "$TMP/$FILE"
${AgentInstaller.shellPairInstall()}`;
	}

	static macos(options: AgentInstaller.Options) {
		const header = AgentInstaller.shellHeader(options, "macos.sh", "macOS");
		return `${header}
[ "$(uname -s)" = "Darwin" ] || fail "this script is for macOS (Linux: $SERVER/install/linux.sh)"

# Apple silicon also when this shell runs translated by Rosetta.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi
FILE="netignite-agent-macos-$ARCH"
${AgentInstaller.shellDownload()}
(
	cd "$TMP"
	grep -E "[ *]$FILE\\$" SHA256SUMS | sed "s/[ *]*$FILE\\$/  $FILE/" >"$FILE.sha256"
	[ -s "$FILE.sha256" ] || fail "SHA256SUMS has no entry for $FILE"
	shasum -a 256 -c "$FILE.sha256" >/dev/null
) || fail "the download doesn't match SHA256SUMS"
chmod 755 "$TMP/$FILE"
# macOS only runs Apple silicon binaries with a signature: sign the checked file ad hoc.
codesign --force --sign - "$TMP/$FILE" >/dev/null 2>&1 || fail "couldn't sign $FILE (codesign)"
${AgentInstaller.shellPairInstall()}`;
	}

	static windows(options: AgentInstaller.Options) {
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		const line = (value: string) => value.replace(/[\r\n]/g, "");
		return `# NetIgnite agent installer for Windows, served by ${line(options.serverURL)}
#
# In PowerShell opened with "Run as administrator":
#   & ([scriptblock]::Create((irm ${line(options.serverURL)}/install/windows.ps1))) <enrollment-token>
#
# Downloads netignite-agent-windows-x64.exe from https://github.com/${line(options.repo)}/releases,
# checks it against SHA256SUMS, pairs it with this server and installs the scheduled task.
# Without a token it only installs or updates the agent.
param([string]$Token = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Windows PowerShell 5.1 still offers TLS 1.0 first; GitHub needs TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Server = ${quote(options.serverURL)}
$Repo = ${quote(options.repo)}
$Version = if ($env:NETIGNITE_AGENT_VERSION) { $env:NETIGNITE_AGENT_VERSION } else { ${quote(options.version ?? "")} }
$File = "netignite-agent-windows-x64.exe"

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	throw "netignite: run this in PowerShell opened with 'Run as administrator'"
}
if (-not [Environment]::Is64BitOperatingSystem) { throw "netignite: the agent needs 64-bit Windows" }

# NETIGNITE_AGENT_BASE_URL: a mirror with the release files.
$Base = $env:NETIGNITE_AGENT_BASE_URL
if (-not $Base) {
	if (-not $Version) {
		# The newest stable release; the newest pre-release only while there is no stable one.
		$releases = @(Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases?per_page=30" | Where-Object { -not $_.draft })
		$release = $releases | Where-Object { -not $_.prerelease } | Select-Object -First 1
		if (-not $release) { $release = $releases | Select-Object -First 1 }
		if (-not $release) { throw "netignite: couldn't find a release of $Repo" }
		$Version = $release.tag_name
	}
	$Base = "https://github.com/$Repo/releases/download/$Version"
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("netignite-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
	Write-Host "Downloading $File $Version..."
	$Exe = Join-Path $Tmp $File
	Invoke-WebRequest -UseBasicParsing "$Base/$File" -OutFile $Exe
	Invoke-WebRequest -UseBasicParsing "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS")
	$expected = $null
	foreach ($entry in Get-Content (Join-Path $Tmp "SHA256SUMS")) {
		if ($entry -match ("^([0-9A-Fa-f]{64})\\s+\\*?" + [regex]::Escape($File) + "$")) { $expected = $Matches[1] }
	}
	if (-not $expected) { throw "netignite: SHA256SUMS has no entry for $File" }
	if ((Get-FileHash -Algorithm SHA256 $Exe).Hash -ne $expected) { throw "netignite: the download doesn't match SHA256SUMS" }

	if ($Token) {
		& $Exe pair $Server $Token
		if ($LASTEXITCODE -ne 0) { throw "netignite: pairing failed" }
	}
	& $Exe install
	if ($LASTEXITCODE -ne 0) { throw "netignite: install failed" }
	Write-Host "Done. The agent shows up as online on its page in the NetIgnite dashboard."
} finally {
	Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
`;
	}

	/** The shared head of the sh scripts: settings, \`fail\`, the root check. */
	private static shellHeader(options: AgentInstaller.Options, script: string, os: string) {
		const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
		const server = options.serverURL.replace(/[\r\n]/g, "");
		const header = `#!/bin/sh
# NetIgnite agent installer for ${os}, served by ${server}
#
#   curl -fsSL ${server}/install/${script} | sudo sh -s -- <enrollment-token>
#
# Downloads netignite-agent from https://github.com/${options.repo.replace(/[\r\n]/g, "")}/releases,
# checks it against SHA256SUMS, pairs it with this server and installs the service.
# Without a token it only installs or updates the agent.
set -eu

SERVER=${quote(options.serverURL)}
REPO=${quote(options.repo)}
VERSION="\${NETIGNITE_AGENT_VERSION:-${options.version ?? ""}}"
TOKEN="\${1:-}"

fail() {
	echo "netignite: $*" >&2
	exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run as root: curl -fsSL $SERVER/install/${script} | sudo sh -s -- <token>"
command -v curl >/dev/null 2>&1 || fail "curl is required"`;
		return header;
	}

	/** Finds the release and downloads $FILE and SHA256SUMS into $TMP. */
	private static shellDownload() {
		return `
# NETIGNITE_AGENT_BASE_URL: a mirror with the release files (netignite-agent-*, SHA256SUMS).
BASE="\${NETIGNITE_AGENT_BASE_URL:-}"
if [ -z "$BASE" ]; then
	if [ -z "$VERSION" ]; then
		# The newest stable release (GitHub's "latest" skips pre-releases); the newest pre-release
		# only while the repository has no stable release.
		tag_name() { sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -n 1; }
		VERSION=$(curl -fsL "https://api.github.com/repos/$REPO/releases/latest" | tag_name)
		[ -n "$VERSION" ] ||
			VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" | tag_name)
		[ -n "$VERSION" ] || fail "couldn't find a release of $REPO"
	fi
	BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $FILE $VERSION..."
curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE" || fail "download of $BASE/$FILE failed"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || fail "download of $BASE/SHA256SUMS failed"`;
	}

	private static shellPairInstall() {
		return `
if [ -n "$TOKEN" ]; then
	"$TMP/$FILE" pair "$SERVER" "$TOKEN"
fi
"$TMP/$FILE" install

echo "Done. The agent shows up as online on its page in the NetIgnite dashboard."
`;
	}
}

export namespace AgentInstaller {
	export type Options = { serverURL: string; repo: string; version: string | null };
}
