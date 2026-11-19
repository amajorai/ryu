// Durations typed into vault forms: `90`, `90s`, `15m`, `1h` or `7d`, sent to
// Core as whole seconds, and lease times shown back as relative text.

const UNIT_SECS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
const DURATION = /^(\d+)\s*([smhd]?)$/i;

/** Seconds for a typed duration; `undefined` when blank, `null` when unreadable. */
export function parseTtl(text: string): number | null | undefined {
	const trimmed = text.trim();
	if (trimmed === "") {
		return;
	}
	const match = DURATION.exec(trimmed);
	if (!match) {
		return null;
	}
	const unit = (match[2] ?? "").toLowerCase() || "s";
	const secs = Number(match[1]) * (UNIT_SECS[unit] ?? 1);
	return Number.isSafeInteger(secs) && secs > 0 ? secs : null;
}

/** The shortest exact form of `secs` (`3600` → `1h`, `90` → `90s`). */
export function formatTtl(secs: number | null | undefined): string {
	if (secs == null || secs <= 0) {
		return "";
	}
	for (const unit of ["d", "h", "m"] as const) {
		const size = UNIT_SECS[unit] ?? 1;
		if (secs % size === 0) {
			return `${secs / size}${unit}`;
		}
	}
	return `${secs}s`;
}

/** Milliseconds since the epoch for a Core timestamp (millis or ISO text). */
export function timestampMillis(value: string | number | null): number | null {
	if (value === null) {
		return null;
	}
	const millis = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(millis) ? millis : null;
}
