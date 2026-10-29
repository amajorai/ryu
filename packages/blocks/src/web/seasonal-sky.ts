import type { BorderBeamColorVariant } from "@ryu/ui/components/border-beam.tsx";
import type { Season } from "./seasons.ts";

/**
 * Shader Sky palette (`./backgrounds/vendor/23rd/shader-sky.tsx`): zenith,
 * horizon, cloud, and cloud shade.
 */
export type SkyPalette = readonly [string, string, string, string];

interface SkyPair {
	/** Light theme: a morning sky. */
	day: SkyPalette;
	/** Dark theme: the same sky after dark. */
	night: SkyPalette;
}

/** The sky with no season: clear morning blue, or a deep moonlit night. */
const PLAIN_SKY: SkyPair = {
	day: ["#4a93d6", "#8ecbf2", "#f7fbff", "#c5d8ec"],
	night: ["#050a18", "#18264a", "#4a5878", "#101830"],
};

// Morning tints stay light so the header and headline keep the plain sky's
// contrast; night tints stay dark for the dark theme's light text.
const SEASON_SKY: Record<Season, SkyPair> = {
	newyear: {
		day: ["#d9a35a", "#fbe8cc", "#ffffff", "#f0d6b0"],
		night: ["#0a0b1e", "#25203f", "#6b5a7e", "#1a1630"],
	},
	lunarnewyear: {
		day: ["#e07f62", "#fbe0c4", "#fff6e2", "#f2c9a8"],
		night: ["#1a0608", "#4a1414", "#8a3a2a", "#2a0c0e"],
	},
	valentines: {
		day: ["#e58aae", "#fbdde8", "#ffffff", "#f2c4d6"],
		night: ["#140716", "#3a1532", "#7a4466", "#24102a"],
	},
	easter: {
		day: ["#a596e3", "#e4f3dc", "#ffffff", "#d6d0f0"],
		night: ["#0b0a1e", "#232a45", "#5e6a8a", "#171b33"],
	},
	halloween: {
		day: ["#de8549", "#f8dfc8", "#ffffff", "#efc9a8"],
		night: ["#0d0718", "#2a1450", "#6b3a5a", "#1a0d2e"],
	},
	christmas: {
		day: ["#8cb6da", "#eef5fb", "#ffffff", "#d3e2ef"],
		night: ["#060d1c", "#1c2c48", "#5a6b88", "#121c30"],
	},
};

export interface HeroSky {
	colors: SkyPalette;
	/** The dark theme's night sky is showing. */
	night: boolean;
}

/**
 * The hero sky for a season (or none): morning in the light theme, night in
 * the dark theme, so the header's theme-following colors always stay legible.
 */
export function heroSkyFor(
	season: Season | null,
	resolvedTheme: string | undefined
): HeroSky {
	const pair = season ? SEASON_SKY[season] : PLAIN_SKY;
	const night = resolvedTheme === "dark";
	return { colors: night ? pair.night : pair.day, night };
}

/** The download beam tones under each sky, as `[morning, night]`. */
const SEASON_BEAM: Record<
	Season,
	readonly [BorderBeamColorVariant, BorderBeamColorVariant]
> = {
	newyear: ["sunset", "ocean"],
	lunarnewyear: ["sunset", "sunset"],
	valentines: ["colorful", "colorful"],
	easter: ["colorful", "ocean"],
	halloween: ["sunset", "ocean"],
	christmas: ["ocean", "ocean"],
};

/**
 * The hero download beam's tone for a sky: warm under the amber mornings, the
 * blue-violet `ocean` under clear and night skies, so the beam reads as part of
 * the sky rather than a rainbow laid over it.
 */
export function heroBeamFor(
	season: Season | null,
	night: boolean
): BorderBeamColorVariant {
	if (!season) {
		return "ocean";
	}
	const [morning, evening] = SEASON_BEAM[season];
	return night ? evening : morning;
}
