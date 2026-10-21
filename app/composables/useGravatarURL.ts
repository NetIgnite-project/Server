/**
 * useGravatarURL — Gravatar image URL for an email address (SHA-256 of the trimmed,
 * lower-cased address, as Gravatar requires).
 */
async function sha256(data: string): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function useGravatarURL(email: string): Promise<string> {
	const hash = await sha256(email.trim().toLowerCase());
	return `https://0.gravatar.com/avatar/${hash}`;
}
