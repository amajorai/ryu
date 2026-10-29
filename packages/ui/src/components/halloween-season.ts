"use client";

import { useEffect, useState } from "react";

/* The Halloween season check, kept apart from the costume renderer so a page
   can decide whether to load the costumes at all without downloading them. */

/** 1 October through 2 November, in the viewer's local time. */
export function isHalloweenSeason(date: Date) {
	const month = date.getMonth();
	return month === 9 || (month === 10 && date.getDate() <= 2);
}

/* A second past midnight, so a timer that fires a little early still lands
   on the new day. */
const MIDNIGHT_SLACK_MS = 1000;

/** Milliseconds from `date` until just after the next local midnight. */
export function msUntilNextLocalMidnight(date: Date) {
	const midnight = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() + 1
	);
	return midnight.getTime() - date.getTime() + MIDNIGHT_SLACK_MS;
}

/**
 * Whether it is Halloween season, re-checked at each local midnight while
 * mounted. Reads the clock after mount, so server and client render agree
 * (false) on the first pass. `now` pins the clock for stories and tests.
 */
export function useHalloweenSeason(now?: Date) {
	const [inSeason, setInSeason] = useState(false);
	const pinned = now?.getTime();

	useEffect(() => {
		if (pinned !== undefined) {
			setInSeason(isHalloweenSeason(new Date(pinned)));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const check = () => {
			const current = new Date();
			setInSeason(isHalloweenSeason(current));
			timer = setTimeout(check, msUntilNextLocalMidnight(current));
		};
		check();
		return () => clearTimeout(timer);
	}, [pinned]);

	return inSeason;
}
