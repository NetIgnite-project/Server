import { createHash } from "node:crypto";

/**
 * The agents' SSH public keys. Every agent that logs in over SSH creates two Ed25519 key pairs of
 * its own, one for shutdown and one for reboot, and keeps the private keys. The server only ever
 * sees the public keys (in HELLO), as `ssh-ed25519 <base64>`.
 */
export class SshKeys {
	/** `ssh-ed25519` + the 51-byte key blob in base64 (68 characters, no padding needed). */
	static readonly PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/;

	/** Whether `line` is an Ed25519 public key whose blob says so too. */
	static isPublicKey(line: string) {
		if (!SshKeys.PUBLIC_KEY_PATTERN.test(line)) return false;
		const blob = Buffer.from(line.slice("ssh-ed25519 ".length), "base64");
		return (
			blob.length === 51 &&
			blob.readUInt32BE(0) === 11 &&
			blob.subarray(4, 15).toString("latin1") === "ssh-ed25519" &&
			blob.readUInt32BE(15) === 32
		);
	}

	/** OpenSSH's fingerprint of a public key line: `SHA256:` + unpadded base64 (`ssh-keygen -l`). */
	static fingerprint(line: string) {
		const blob = Buffer.from(line.split(" ")[1] ?? "", "base64");
		return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
	}

	/** Whether a string looks like an OpenSSH SHA-256 fingerprint. */
	static isFingerprint(value: string) {
		return /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
	}
}
