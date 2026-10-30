// ---------------------------------------------------------------------------
// Sky: where the sun or moon sits for the local time of day
// ---------------------------------------------------------------------------

export type SkyPhase = "dawn" | "day" | "dusk" | "night";

export interface SkyState {
	/** Height above the horizon, 0 (on it) to 1 (overhead). */
	altitude: number;
	body: "moon" | "sun";
	phase: SkyPhase;
	/** Position along its arc, 0 (rising, left) to 1 (setting, right). */
	progress: number;
}

const SUNRISE_HOUR = 6;
const SUNSET_HOUR = 19;
const DAY_HOURS = SUNSET_HOUR - SUNRISE_HOUR;
const NIGHT_HOURS = 24 - DAY_HOURS;

function hourOf(date: Date): number {
	return date.getHours() + date.getMinutes() / 60;
}

export function skyPhase(date: Date): SkyPhase {
	const hour = hourOf(date);
	if (hour >= 5 && hour < 8) {
		return "dawn";
	}
	if (hour >= 8 && hour < 17) {
		return "day";
	}
	if (hour >= 17 && hour < 20) {
		return "dusk";
	}
	return "night";
}

/** The sun crosses the sky from 6:00 to 19:00; the moon has the rest. */
export function skyAt(date: Date): SkyState {
	const hour = hourOf(date);
	const daytime = hour >= SUNRISE_HOUR && hour < SUNSET_HOUR;
	const progress = daytime
		? (hour - SUNRISE_HOUR) / DAY_HOURS
		: (((hour - SUNSET_HOUR + 24) % 24) / NIGHT_HOURS) % 1;
	return {
		// A parabola, so the body sits exactly on the drawn (quadratic) arc.
		altitude: 4 * progress * (1 - progress),
		body: daytime ? "sun" : "moon",
		phase: skyPhase(date),
		progress,
	};
}

/**
 * The greeting over the sky. Evening runs to 2 AM, the usual end of a late
 * evening; between then and 5 AM the page says "Good night" instead.
 */
export function panelsGreeting(date: Date): string {
	const hour = date.getHours();
	if (hour >= 2 && hour < 5) {
		return "Good night";
	}
	if (hour >= 5 && hour < 12) {
		return "Good morning";
	}
	if (hour >= 12 && hour < 17) {
		return "Good afternoon";
	}
	return "Good evening";
}
