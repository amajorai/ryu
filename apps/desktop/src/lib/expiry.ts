// apps/desktop/src/lib/expiry.ts
//
// One convention for rendering "money/credit that lapses on a date".
//
// Two surfaces now show that shape and they must read identically: the composer
// usage bar's Codex banked rate-limit resets (each credit expires on its own
// date) and the agent picker's per-pool Ryu grant balances (a campaign grant
// lapses on its own date). These lived in `usage-bar.tsx` first; they moved here
// the moment the second consumer appeared rather than being copied, because two
// drifting "expires in" formats on the same screen is exactly the sort of thing
// nobody notices until a user asks why one says "6d" and the other "in ~1w".

import { formatDateTime } from "@/src/lib/timezone.ts";

const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = 3600;
const HOURS_IN_WEEK = HOURS_PER_DAY * 7;
const URGENT_EXPIRY_HOURS = 48;

/** "Jul 31 at 5:30 PM" — the exact moment something lapses. */
export function formatExpiryDate(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		return iso;
	}
	return formatDateTime(ms, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** "12d 18h" / "4h" / "23m" — the countdown to `iso`, or "" when unparseable. */
export function formatCountdown(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) {
		return "";
	}
	const minutes = Math.round((ms - Date.now()) / 60_000);
	if (minutes <= 0) {
		return "expired";
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < HOURS_PER_DAY) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / HOURS_PER_DAY);
	return `${days}d ${hours % HOURS_PER_DAY}h`;
}

/**
 * Urgency hue for an expiry, matching CodexBar's convention: calm beyond a week,
 * amber within a week, red within 48 hours. What makes an expiring balance worth
 * acting on is that it's about to be *lost*, so the soonest date drives it.
 */
export function expiryClass(iso: string): string {
	const hours = (Date.parse(iso) - Date.now()) / (1000 * SECONDS_PER_HOUR);
	if (Number.isNaN(hours)) {
		return "bg-muted-foreground/40";
	}
	if (hours <= URGENT_EXPIRY_HOURS) {
		return "bg-destructive";
	}
	if (hours <= HOURS_IN_WEEK) {
		return "bg-warning";
	}
	return "bg-info";
}
