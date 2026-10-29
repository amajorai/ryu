// User settings + resolution for the seasonal titlebar effects.
//
// Three inputs decide what falls:
//   1. "Seasonal effects" — the on/off switch (persisted, default ON).
//   2. "Season" — "auto" (whatever the calendar says today, the default) or a
//      pinned season, for anyone who wants confetti in July (persisted).
//   3. Preview — a transient override the Appearance tab sets for a few
//      seconds so you can see a season without waiting for the date. Not
//      persisted, and it deliberately bypasses (1) so the preview button still
//      demonstrates the effect while the switch is off.
//
// All three are then gated on motion: the Appearance "Enable animations" master
// switch, and the OS reduce-motion preference, which overrides everything.

import { useEffect, useState, useSyncExternalStore } from "react";
import {
	getCurrentSeason,
	getSeasonById,
	SEASONS,
	type SeasonalTheme,
	type SeasonConfig,
} from "@/src/components/layout/SeasonalEffects.tsx";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { usePrefersReducedMotion } from "@/src/hooks/usePrefersReducedMotion.ts";

export const SEASONAL_EFFECTS_KEY = "ryu:seasonal-effects";
export const SEASONAL_THEME_KEY = "ryu:seasonal-theme";

/** Which season to show — "auto" follows the calendar. */
export type SeasonalThemeSetting = "auto" | SeasonalTheme;

export const DEFAULT_SEASONAL_EFFECTS = true;
export const DEFAULT_SEASONAL_THEME: SeasonalThemeSetting = "auto";

/** How long a preview runs before it releases back to the real setting. */
export const SEASON_PREVIEW_MS = 5000;

/**
 * The calendar is only re-read every half hour — the app can sit open across
 * midnight into December and should start snowing without a restart, but a
 * per-second clock for a decoration is waste.
 */
const SEASON_RECHECK_MS = 30 * 60 * 1000;

// The animations master switch is owned by lib/appearance-settings.ts
// (APPEARANCE_KEYS.animationsEnabled). It is spelled out here rather than
// imported to keep this hook free of that module's theme-preset import graph —
// same as ChatDisplayPrefsProvider does. Keep the two strings in step.
const ANIMATIONS_ENABLED_KEY = "ryu:animations-enabled";

// --- persisted season choice -------------------------------------------------

const themeListeners = new Set<() => void>();

function isSeasonalThemeSetting(v: string | null): v is SeasonalThemeSetting {
	return (
		v === "auto" || (v !== null && SEASONS.some((season) => season.id === v))
	);
}

function readTheme(): SeasonalThemeSetting {
	try {
		const raw = localStorage.getItem(SEASONAL_THEME_KEY);
		return isSeasonalThemeSetting(raw) ? raw : DEFAULT_SEASONAL_THEME;
	} catch {
		return DEFAULT_SEASONAL_THEME;
	}
}

function subscribeTheme(cb: () => void): () => void {
	themeListeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === SEASONAL_THEME_KEY) {
			cb();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		themeListeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

/** Write the season choice and notify every consumer (and every window). */
export function setSeasonalThemeSetting(next: SeasonalThemeSetting): void {
	try {
		localStorage.setItem(SEASONAL_THEME_KEY, next);
	} catch {
		// Persistence is best-effort.
	}
	for (const cb of themeListeners) {
		cb();
	}
}

/** The persisted season choice ("auto" by default). */
export function useSeasonalThemeSetting(): SeasonalThemeSetting {
	return useSyncExternalStore(
		subscribeTheme,
		readTheme,
		() => DEFAULT_SEASONAL_THEME
	);
}

// --- transient preview -------------------------------------------------------

const previewListeners = new Set<() => void>();
let previewSeason: SeasonalTheme | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function emitPreview() {
	for (const cb of previewListeners) {
		cb();
	}
}

/**
 * Show `theme` everywhere for `durationMs`, then release. Passing null clears an
 * in-flight preview immediately — call it on unmount so closing Settings
 * mid-preview does not leave the titlebar stuck on the wrong season.
 */
export function previewSeasonalTheme(
	theme: SeasonalTheme | null,
	durationMs = SEASON_PREVIEW_MS
): void {
	if (previewTimer) {
		clearTimeout(previewTimer);
		previewTimer = null;
	}
	previewSeason = theme;
	emitPreview();
	if (!theme) {
		return;
	}
	previewTimer = setTimeout(() => {
		previewTimer = null;
		previewSeason = null;
		emitPreview();
	}, durationMs);
}

function subscribePreview(cb: () => void): () => void {
	previewListeners.add(cb);
	return () => {
		previewListeners.delete(cb);
	};
}

/** The season currently being previewed, if any. */
export function usePreviewSeasonalTheme(): SeasonalTheme | null {
	return useSyncExternalStore(
		subscribePreview,
		() => previewSeason,
		() => null
	);
}

// --- resolution --------------------------------------------------------------

/** "Now", re-read every `SEASON_RECHECK_MS` so the app can cross midnight. */
function useSeasonClock(): Date {
	const [now, setNow] = useState(() => new Date());

	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), SEASON_RECHECK_MS);
		return () => clearInterval(id);
	}, []);

	return now;
}

/** Whether animated decoration is allowed at all right now. */
export function useMotionAllowed(): boolean {
	const [animationsEnabled] = usePersistedToggle(ANIMATIONS_ENABLED_KEY, true);
	const prefersReducedMotion = usePrefersReducedMotion();
	return animationsEnabled && !prefersReducedMotion;
}

/**
 * The season to render right now, or null for none. This is the only thing the
 * titlebar needs to know.
 */
export function useActiveSeason(): SeasonConfig | null {
	const [enabled] = usePersistedToggle(
		SEASONAL_EFFECTS_KEY,
		DEFAULT_SEASONAL_EFFECTS
	);
	const setting = useSeasonalThemeSetting();
	const preview = usePreviewSeasonalTheme();
	const motionAllowed = useMotionAllowed();
	const now = useSeasonClock();

	if (!motionAllowed) {
		return null;
	}
	if (preview) {
		return getSeasonById(preview);
	}
	if (!enabled) {
		return null;
	}
	if (setting !== "auto") {
		return getSeasonById(setting);
	}
	return getCurrentSeason(now);
}
