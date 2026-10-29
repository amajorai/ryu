import { isHalloweenSeason } from "./halloween-season.ts";

// Seasonal themes for the landing page, after jiaweing/portfolio-dex: each
// season runs on the visitor's local calendar and dresses the hero sky and a
// particle layer for its window.

export const SEASONS = [
	"newyear",
	"lunarnewyear",
	"valentines",
	"easter",
	"halloween",
	"christmas",
] as const;

export type Season = (typeof SEASONS)[number];

export function isSeasonId(value: unknown): value is Season {
	return SEASONS.includes(value as Season);
}

const DAY_MS = 86_400_000;

const startOfDay = (date: Date) =>
	new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const daysBetween = (from: Date, to: Date) =>
	Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);

/** Easter Sunday by the anonymous Gregorian computus. */
export function easterSunday(year: number): Date {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return new Date(year, month - 1, day);
}

// First day of Lunar New Year as [monthIndex, day]. Lunar dates follow no
// simple formula, so extend this table as the years go by.
const LUNAR_NEW_YEAR: Record<number, readonly [number, number]> = {
	2026: [1, 17],
	2027: [1, 6],
	2028: [0, 26],
	2029: [1, 13],
	2030: [1, 3],
	2031: [0, 23],
	2032: [1, 11],
	2033: [0, 31],
	2034: [1, 19],
	2035: [1, 8],
};

export function lunarNewYear(year: number): Date | null {
	const entry = LUNAR_NEW_YEAR[year];
	return entry ? new Date(year, entry[0], entry[1]) : null;
}

export function isSeason(season: Season, now: Date): boolean {
	const month = now.getMonth();
	const date = now.getDate();
	switch (season) {
		case "newyear":
			return (month === 11 && date === 31) || (month === 0 && date === 1);
		case "lunarnewyear": {
			// A few days of build-up through Chap Goh Meh on the 15th day.
			const start = lunarNewYear(now.getFullYear());
			if (!start) {
				return false;
			}
			const offset = daysBetween(start, now);
			return offset >= -3 && offset <= 14;
		}
		case "valentines":
			return month === 1 && date >= 12 && date <= 14;
		case "easter": {
			// Good Friday through Easter Monday.
			const offset = daysBetween(easterSunday(now.getFullYear()), now);
			return offset >= -2 && offset <= 1;
		}
		case "halloween":
			// Shares its window with the Witching Hour announcement.
			return isHalloweenSeason(now);
		case "christmas":
			return month === 11 && date <= 30;
		default:
			return false;
	}
}

// Order decides who wins when windows overlap, e.g. Valentine's during Lunar New Year.
const PRIORITY: readonly Season[] = [
	"newyear",
	"valentines",
	"lunarnewyear",
	"easter",
	"halloween",
	"christmas",
];

export function currentSeason(now: Date): Season | null {
	return PRIORITY.find((season) => isSeason(season, now)) ?? null;
}
