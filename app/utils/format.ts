/**
 * Shared formatting helpers for timestamps and durations.
 */

export function formatDate(ts: number | null | undefined): string {
	if (!ts) return "-";
	return new Date(ts).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatDateISO(ts: number | null | undefined): string {
	if (!ts) return "";
	const d = new Date(ts);
	d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
	return d.toISOString().slice(0, 16);
}

export function parseDateISO(value: string): number {
	if (!value) return 0;
	return new Date(value).getTime();
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}
