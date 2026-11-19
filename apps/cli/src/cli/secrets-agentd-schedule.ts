// Renewal timing for `ryu secrets agent`.
//
// The vault token and every lease are renewed once two thirds of their
// remaining lifetime has passed (Vault Agent uses the same rule), never sooner
// than `MIN_DELAY_MS` so an expiry in the past cannot cause a renewal storm.
// The clock is injected, so tests drive time by hand.

/** Core reports expiry as epoch milliseconds; older fixtures use RFC 3339. */
export function timestampMs(value: string | number | null): number | null {
	if (value === null) {
		return null;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

export const MIN_DELAY_MS = 1000;

/** How long to wait before renewing something that expires at `expiresAtMs`. */
export function renewDelay(nowMs: number, expiresAtMs: number): number {
	const remaining = expiresAtMs - nowMs;
	return Math.max(MIN_DELAY_MS, Math.floor((remaining * 2) / 3));
}

export interface Clock {
	clearTimer: (handle: unknown) => void;
	now: () => number;
	setTimer: (callback: () => void, ms: number) => unknown;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimer: (callback, ms) => setTimeout(callback, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One pending timer per key; scheduling a key again replaces its timer. */
export class Timers {
	private readonly handles = new Map<string, unknown>();

	constructor(private readonly clock: Clock) {}

	at(key: string, delayMs: number, callback: () => void): void {
		this.cancel(key);
		const handle = this.clock.setTimer(() => {
			this.handles.delete(key);
			callback();
		}, delayMs);
		this.handles.set(key, handle);
	}

	cancel(key: string): void {
		const handle = this.handles.get(key);
		if (handle !== undefined) {
			this.clock.clearTimer(handle);
			this.handles.delete(key);
		}
	}

	cancelAll(): void {
		for (const key of [...this.handles.keys()]) {
			this.cancel(key);
		}
	}

	pending(): string[] {
		return [...this.handles.keys()].sort();
	}
}
