// Per-app cooldown tracking so the engine never spams suggestions for the same
// app, and so user feedback (dismiss/snooze) can extend the quiet window.
//
// Pure aside from the injected `now` clock, so it is unit-testable.

/** Per-app cooldown: suppresses new suggestions until `until`. */
export class AppCooldown {
	private readonly baseMs: number;
	private readonly snoozeMs: number;
	private readonly until = new Map<string, number>();

	constructor(baseMs: number, snoozeMs: number) {
		this.baseMs = baseMs;
		this.snoozeMs = snoozeMs;
	}

	/** True when the app is still cooling down at `now`. */
	isCoolingDown(appKey: string, now: number): boolean {
		const until = this.until.get(appKey);
		return until !== undefined && now < until;
	}

	/** Start the base cooldown for an app after emitting a suggestion. */
	arm(appKey: string, now: number): void {
		this.until.set(appKey, now + this.baseMs);
	}

	/**
	 * Extend the cooldown after negative feedback. A dismiss uses the base
	 * window; a snooze uses the longer snooze window. Positive feedback is a
	 * no-op (the base arm already applied).
	 */
	penalize(appKey: string, kind: "snooze" | "dismiss", now: number): void {
		const extra = kind === "snooze" ? this.snoozeMs : this.baseMs;
		const current = this.until.get(appKey) ?? now;
		this.until.set(appKey, Math.max(current, now + extra));
	}

	/** Clear all cooldowns (engine disabled). */
	clear(): void {
		this.until.clear();
	}
}

/** Normalize an app name into a stable cooldown key. */
export function appKeyOf(appName: string | null): string {
	return (appName ?? "unknown").toLowerCase();
}
