"use client";

import { useEffect, useState } from "react";

/** Halloween season on the visitor's local calendar: October 20 through November 1. */
export function isHalloweenSeason(now: Date): boolean {
	const month = now.getMonth();
	const day = now.getDate();
	return (month === 9 && day >= 20) || (month === 10 && day <= 1);
}

/**
 * Whether the Halloween landing announcement is on. (The hero's seasonal sky
 * follows `useLandingSeason`, which shares this window.)
 * Resolved after mount from the visitor's clock, so prerendered HTML stays
 * deterministic and the season follows the visitor's own date.
 */
export function useHalloweenSeason(): boolean {
	const [active, setActive] = useState(false);
	useEffect(() => {
		setActive(isHalloweenSeason(new Date()));
	}, []);
	return active;
}
