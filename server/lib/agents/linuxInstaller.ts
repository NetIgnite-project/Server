/**
 * The Linux agent's install script, served at `/install/linux.sh`:
 *
 *   curl -fsSL https://<server>/install/linux.sh | sudo sh -s -- <enrollment-token>
 *
 * Downloads the agent binary for the machine's CPU from the Agent-Linux GitHub releases, checks
 * it against the release's SHA256SUMS, pairs it with this server (if a token is given) and
 * installs the systemd service.
 */
export class LinuxInstaller {
	static script(options: { serverURL: string; repo: string; version: string | null }) {
		const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

		return `#!/bin/sh
# NetIgnite Linux agent installer, served by ${options.serverURL.replace(/[\r\n]/g, "")}
#
#   curl -fsSL ${options.serverURL.replace(/[\r\n]/g, "")}/install/linux.sh | sudo sh -s -- <enrollment-token>
#
# Downloads netignite-agent from https://github.com/${options.repo.replace(/[\r\n]/g, "")}/releases,
# checks it against SHA256SUMS, pairs it with this server and installs the systemd service.
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

[ "$(uname -s)" = "Linux" ] || fail "the agent runs on Linux only"
[ "$(id -u)" -eq 0 ] || fail "run as root: curl -fsSL $SERVER/install/linux.sh | sudo sh -s -- <token>"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v systemctl >/dev/null 2>&1 || fail "the agent needs systemd"

case "$(uname -m)" in
	x86_64 | amd64)
		# The default build needs AVX2; older CPUs get the baseline build.
		if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then ARCH=x64; else ARCH=x64-baseline; fi
		;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) fail "unsupported CPU: $(uname -m) (supported: x86-64, 64-bit ARM)" ;;
esac

# NETIGNITE_AGENT_BASE_URL: a mirror with the release files (netignite-agent-linux-*, SHA256SUMS).
BASE="\${NETIGNITE_AGENT_BASE_URL:-}"
if [ -z "$BASE" ]; then
	if [ -z "$VERSION" ]; then
		# The newest release, pre-releases included (GitHub's "latest" skips them).
		VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" |
			sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -n 1)
		[ -n "$VERSION" ] || fail "couldn't find a release of $REPO"
	fi
	BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

FILE="netignite-agent-linux-$ARCH"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $FILE $VERSION..."
curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE" || fail "download of $BASE/$FILE failed"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || fail "download of $BASE/SHA256SUMS failed"
(
	cd "$TMP"
	grep -E "[ *]$FILE\\$" SHA256SUMS | sed "s/[ *]*$FILE\\$/  $FILE/" >"$FILE.sha256"
	[ -s "$FILE.sha256" ] || fail "SHA256SUMS has no entry for $FILE"
	sha256sum -c "$FILE.sha256" >/dev/null
) || fail "the download doesn't match SHA256SUMS"
chmod 755 "$TMP/$FILE"

if [ -n "$TOKEN" ]; then
	"$TMP/$FILE" pair "$SERVER" "$TOKEN"
fi
"$TMP/$FILE" install

echo "Done. The agent shows up as online on its page in the NetIgnite dashboard."
`;
	}
}
