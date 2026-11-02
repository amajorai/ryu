// The data half of `github-activity.tsx`: the contribution model, the
// calendar fetch, and the locale-aware labels the grid and tooltip print.

import { dateFormatter } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { isNativeText } from "../../lib/native-primitive-observation.ts";

export type ContributionLevel = 0 | 1 | 2 | 3 | 4;

export interface Contribution {
	count: number;
	date: string;
	level: ContributionLevel;
}

export interface RepoContribution {
	count: number;
	href?: string;
	logo?: ReactNode;
	name: string;
}

const WEEKS_PER_MONTH = 365.25 / 12 / 7;
const MIN_LABEL_WEEKS = 3;

export interface ContributionUnit {
	plural: string;
	singular: string;
}

export const DEFAULT_UNIT = {
	plural: "contributions",
	singular: "contribution",
} as const satisfies ContributionUnit;

export const gapFor = (cellSize: number) =>
	Math.max(2, Math.round(cellSize / 4));
// never zero: weeks.slice(-0) would hand back the whole history instead of nothing
export const weeksFor = (months: number) =>
	Math.max(1, Math.ceil(months * WEEKS_PER_MONTH));

const LEVELS = [0, 1, 2, 3, 4] as const;

const LEVEL_OPACITY = {
	0: 0,
	1: 0.3,
	2: 0.52,
	3: 0.76,
	4: 1,
} satisfies Record<ContributionLevel, number>;

export interface LevelStyle {
	backgroundColor: string;
	opacity: number;
}

/** The short month name in `locale`, for a `01`-`12` month. */
function monthName(month: number, locale: string): string | null {
	if (!(month >= 1 && month <= 12)) {
		return null;
	}
	return dateFormatter(locale, { month: "short", timeZone: "UTC" }).format(
		Date.UTC(2000, month - 1, 1)
	);
}

/** One label per week column: the month name where a month's run starts. */
export function toMonthLabels(
	weeks: Contribution[][],
	locale: string
): (string | null)[] {
	const labels: (string | null)[] = weeks.map(() => null);
	const monthAt = (index: number) => weeks[index]?.[0]?.date.slice(5, 7);

	let start = 0;
	for (let i = 1; i <= weeks.length; i++) {
		if (i < weeks.length && monthAt(i) === monthAt(start)) {
			continue;
		}
		// a shorter run is narrower than the label itself, so it would sit under the next month
		if (i - start >= MIN_LABEL_WEEKS) {
			labels[start] = monthName(Number(monthAt(start)), locale);
		}
		start = i;
	}

	return labels;
}

/** The tooltip line: "3 contributions on Oct 30, 2026", in `locale`. */
export function describeDay(
	{ count, date }: Contribution,
	unit: ContributionUnit,
	tl: LiteralMessage,
	locale: string
): string {
	const day = dateFormatter(locale, {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(new Date(`${date}T00:00:00`));
	if (unit === DEFAULT_UNIT) {
		return tl(
			"{count, plural, one {# contribution on {date}} other {# contributions on {date}}}",
			{ count, date: day }
		);
	}
	return tl(
		"{count, plural, one {# {singular} on {date}} other {# {plural} on {date}}}",
		{ count, date: day, plural: unit.plural, singular: unit.singular }
	);
}

/** The card heading: "1,234 contributions in 2026". */
export function contributionHeading(
	total: number,
	unit: ContributionUnit,
	year: number | null,
	tl: LiteralMessage
): string {
	const values = {
		plural: unit.plural,
		singular: unit.singular,
		total,
		year: String(year ?? ""),
	};
	if (unit === DEFAULT_UNIT) {
		return year
			? tl(
					"{total, plural, one {# contribution in {year}} other {# contributions in {year}}}",
					values
				)
			: tl(
					"{total, plural, one {# contribution} other {# contributions}}",
					values
				);
	}
	return year
		? tl(
				"{total, plural, one {# {singular} in {year}} other {# {plural} in {year}}}",
				values
			)
		: tl("{total, plural, one {# {singular}} other {# {plural}}}", values);
}

const CALENDAR_API = "https://github-contributions-api.jogruber.de/v4";

interface ApiDay {
	count: number;
	date: string;
	level: number;
}

/** Decode the closed display domain; invalid levels already use level-zero paint. */
function normalizedContributionLevel(
	value: ApiDay["level"]
): ContributionLevel {
	const bounded = Math.min(4, Math.max(0, value));
	return LEVELS.find((level) => level === bounded) ?? 0;
}

export async function fetchCalendar(login: string) {
	const res = await fetch(`${CALENDAR_API}/${login}?y=last`);
	if (!res.ok) {
		return null;
	}

	const days: ApiDay[] = (await res.json())?.contributions ?? [];
	if (!days.length) {
		return null;
	}

	// columns are weeks, so the first day has to be a sunday or every column shears
	const start = days.findIndex(
		(day) => new Date(`${day.date}T00:00:00Z`).getUTCDay() === 0
	);

	return days.slice(start < 0 ? 0 : start).map<Contribution>((day) => ({
		date: day.date,
		count: day.count,
		level: normalizedContributionLevel(day.level),
	}));
}

export function emptyDays(weeks: number): Contribution[] {
	const today = new Date();
	return Array.from({ length: weeks * 7 }, (_, i) => {
		const date = new Date(today);
		date.setDate(date.getDate() - (weeks * 7 - 1 - i));
		return {
			date: date.toISOString().slice(0, 10),
			count: 0,
			level: 0,
		} satisfies Contribution;
	});
}

export function toScale(accent: string | string[]): LevelStyle[] {
	if (isNativeText(accent)) {
		return LEVELS.map((level) => ({
			backgroundColor: accent,
			opacity: LEVEL_OPACITY[level],
		}));
	}

	const colors = accent.length > 4 ? accent : ["transparent", ...accent];
	return LEVELS.map((level) => {
		const color = colors[level] ?? colors.at(-1) ?? "transparent";
		return { backgroundColor: color, opacity: color === "transparent" ? 0 : 1 };
	});
}

export function toWeeks(contributions: Contribution[]) {
	const weeks: Contribution[][] = [];
	for (let i = 0; i < contributions.length; i += 7) {
		weeks.push(contributions.slice(i, i + 7));
	}
	return weeks;
}
