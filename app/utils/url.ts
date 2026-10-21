/**
 * decodeURIComponent that never throws. A malformed escape (e.g. a literal "%")
 * in a route param would otherwise raise a URIError during page setup and surface
 * as an SSR 500 instead of a clean 404. Falls back to the raw value.
 */
export function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
