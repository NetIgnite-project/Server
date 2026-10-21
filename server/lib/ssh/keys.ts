import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * Ed25519 key pairs in OpenSSH's formats: the private key as `-----BEGIN OPENSSH PRIVATE KEY-----`
 * (unencrypted, what `ssh-keygen -t ed25519 -N ""` writes) and the public key as an
 * `authorized_keys` line. Node can't export these formats itself.
 */
export class SshKeys {
	static generateEd25519(comment: string) {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
		const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");

		const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);

		// Private section: check ints, key type, public key, seed + public key, comment, padding.
		const check = randomBytes(4);
		let section = Buffer.concat([
			check,
			check,
			sshString("ssh-ed25519"),
			sshString(pub),
			sshString(Buffer.concat([seed, pub])),
			sshString(comment),
		]);
		const padding = Buffer.from(
			Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, i) => i + 1),
		);
		section = Buffer.concat([section, padding]);

		const body = Buffer.concat([
			Buffer.from("openssh-key-v1\0", "binary"),
			sshString("none"), // cipher
			sshString("none"), // KDF
			sshString(""), // KDF options
			uint32(1), // number of keys
			sshString(publicBlob),
			sshString(section),
		]);

		const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
		return {
			privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
			publicKey: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`,
			fingerprint: this.fingerprint(publicBlob),
		};
	}

	/** OpenSSH's fingerprint of a key blob: `SHA256:` + unpadded base64 (what `ssh-keygen -l` shows). */
	static fingerprint(blob: Buffer) {
		return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
	}

	/** Whether a string looks like an OpenSSH SHA-256 fingerprint. */
	static isFingerprint(value: string) {
		return /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
	}
}

function uint32(value: number) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value);
	return buffer;
}

function sshString(value: string | Buffer) {
	const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
	return Buffer.concat([uint32(data.length), data]);
}
