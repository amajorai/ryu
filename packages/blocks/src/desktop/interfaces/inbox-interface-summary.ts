import type { LiteralMessage } from "@ryu/i18n/react";
import { useEffect, useState } from "react";

const MINUTE = 60_000;

/** Wall clock that ticks once a minute so relative times stay honest. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

export function needsYouSummary(
	count: number,
	total: number,
	tl: LiteralMessage
): string {
	if (total === 0) {
		return "No threads yet";
	}
	return count === 0 ? "All caught up" : tl("{count} need you", { count });
}
