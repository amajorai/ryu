// The seasonal calendar: which holiday is showing, its particles and colours.
// Split from SeasonalEffects.tsx so the settings hook can resolve the active
// season without pulling the particle layer into the shell bundle; TitleBar
// lazy-loads the particles only when a season is actually on.

export type SeasonalTheme =
	| "christmas"
	| "cny"
	| "valentine"
	| "easter"
	| "halloween"
	| "new_year"
	| "st_patrick";

export interface SeasonConfig {
	/** CSS color for the particle (for text glyphs like the snowflake "*"). */
	color?: string;
	/** Emoji shown in the settings dropdown (falls back to the first emoji). */
	displayEmoji?: string;
	/** Single emoji, or an array — each particle then picks one at random. */
	emoji: string | string[];
	id: SeasonalTheme;
	isActive: (date: Date) => boolean;
	label: string;
	/** Max particle size in px (defaults to 30). */
	maxSize?: number;
	/** Min particle size in px (defaults to 1). */
	minSize?: number;
}

const DECEMBER = 11;
const JANUARY = 0;
const FEBRUARY = 1;
const MARCH = 2;
const APRIL = 3;
const OCTOBER = 9;

/**
 * Ordered — the FIRST match wins, so a narrow window (New Year's Eve) must come
 * before the month it sits inside (Christmas covers all of December).
 */
export const SEASONS: SeasonConfig[] = [
	{
		id: "new_year",
		label: "New Year's",
		emoji: ["🥳", "🍾", "🎉", "🎊", "🪅"],
		minSize: 8,
		maxSize: 18,
		isActive: (d) => {
			const m = d.getMonth();
			const day = d.getDate();
			return (m === DECEMBER && day === 31) || (m === JANUARY && day <= 2);
		},
	},
	{
		id: "cny",
		label: "Chinese New Year",
		emoji: "🧧",
		minSize: 8,
		maxSize: 18,
		isActive: (d) => {
			const m = d.getMonth();
			const day = d.getDate();
			return (m === JANUARY && day >= 20) || (m === FEBRUARY && day <= 18);
		},
	},
	{
		id: "valentine",
		label: "Valentine's Day",
		emoji: "❤️",
		minSize: 8,
		maxSize: 18,
		isActive: (d) => d.getMonth() === FEBRUARY && d.getDate() <= 14,
	},
	{
		id: "st_patrick",
		label: "St. Patrick's Day",
		emoji: "🍀",
		minSize: 8,
		maxSize: 18,
		isActive: (d) => d.getMonth() === MARCH && d.getDate() === 17,
	},
	{
		id: "easter",
		label: "Easter",
		emoji: "🐰",
		minSize: 8,
		maxSize: 18,
		isActive: (d) => {
			const m = d.getMonth();
			return (
				(m === MARCH && d.getDate() >= 15) || (m === APRIL && d.getDate() <= 25)
			);
		},
	},
	{
		id: "halloween",
		label: "Halloween",
		emoji: "🎃",
		minSize: 8,
		maxSize: 18,
		isActive: (d) => d.getMonth() === OCTOBER,
	},
	{
		id: "christmas",
		label: "Christmas",
		emoji: "*",
		// Theme-aware on purpose — see the tokens in index.css. White snow on a
		// light theme is a blank titlebar.
		color: "var(--ryu-seasonal-snow)",
		displayEmoji: "❄️",
		isActive: (d) => d.getMonth() === DECEMBER,
	},
];

/** The season whose window contains `date`, or null outside every window. */
export function getCurrentSeason(date = new Date()): SeasonConfig | null {
	return SEASONS.find((s) => s.isActive(date)) ?? null;
}

/** The emoji to show in menus — `displayEmoji` if set, else the first emoji. */
export function getSeasonDisplayEmoji(season: SeasonConfig): string {
	if (season.displayEmoji) {
		return season.displayEmoji;
	}
	return Array.isArray(season.emoji) ? season.emoji[0] : season.emoji;
}

/** The season with this id, or null. */
export function getSeasonById(id: SeasonalTheme): SeasonConfig | null {
	return SEASONS.find((s) => s.id === id) ?? null;
}
