"use client";

import { useEffect, useState } from "react";
import { currentSeason, isSeasonId, type Season } from "./seasons.ts";

const SEASON_EVENT = "ryu:landing-season";
// A visitor's pick (another season to preview, or none) lasts for the tab
// session; a new visit goes back to the calendar.
const STORAGE_KEY = "ryu.landing-season";
const NO_SEASON = "none";

function storedChoice(): Season | null | undefined {
	try {
		const value = window.sessionStorage.getItem(STORAGE_KEY);
		if (value === NO_SEASON) {
			return null;
		}
		return isSeasonId(value) ? value : undefined;
	} catch {
		return;
	}
}

/**
 * The season the landing page is dressed for: the visitor's pick from the
 * season picker, else the one on their own calendar. Resolved after mount, so
 * prerendered HTML stays season-free and deterministic.
 */
export function useLandingSeason(): Season | null {
	const [season, setSeason] = useState<Season | null>(null);

	useEffect(() => {
		const chosen = storedChoice();
		setSeason(chosen === undefined ? currentSeason(new Date()) : chosen);

		const onChoose = (event: Event) => {
			const { detail } = event as CustomEvent<Season | null>;
			setSeason(isSeasonId(detail) ? detail : null);
		};
		window.addEventListener(SEASON_EVENT, onChoose);
		return () => window.removeEventListener(SEASON_EVENT, onChoose);
	}, []);

	return season;
}

/** Switch the landing to a season (or to none) for the rest of the tab session. */
export function chooseLandingSeason(season: Season | null): void {
	try {
		window.sessionStorage.setItem(STORAGE_KEY, season ?? NO_SEASON);
	} catch {
		// Storage can be blocked; the pick still applies to this page view.
	}
	window.dispatchEvent(new CustomEvent(SEASON_EVENT, { detail: season }));
}
