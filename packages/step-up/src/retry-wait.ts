/**
 * The wait before the next email, as a count and the unit it is said in:
 * seconds up to 90, minutes up to 90, then hours. A surface picks one whole
 * catalogued sentence per unit (with an ICU plural on `count`), so the wait
 * reads in the user's language instead of the server's English.
 *
 * Kept in step with `emailRetryWait` in packages/email/src/lib/retry-wait.ts,
 * which the server uses for its English fallback sentence; the sibling test
 * compares both. It lives here because every client surface (website,
 * desktop, mobile) already depends on this framework-free package.
 */
export interface EmailRetryWait {
	count: number;
	unit: "hours" | "minutes" | "seconds";
}

export function emailRetryWait(seconds: number): EmailRetryWait {
	const whole = Math.max(1, Math.ceil(seconds));
	if (whole <= 90) {
		return { count: whole, unit: "seconds" };
	}
	const minutes = Math.ceil(whole / 60);
	if (minutes <= 90) {
		return { count: minutes, unit: "minutes" };
	}
	return { count: Math.ceil(whole / 3600), unit: "hours" };
}
