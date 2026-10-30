import type { CSSProperties } from "react";
import styles from "./contributions-graph.module.css";
import type {
	ContributionDay,
	ContributionsGraphColorSchema,
	ContributionsGraphCorners,
} from "./contributions-graph.tsx";

const WEEKS = 53;
const DAYS_IN_WEEK = 7;
const TOTAL_CELLS = WEEKS * DAYS_IN_WEEK;
export const DEFAULT_LEVELS = 4;
const MS_PER_DAY = 86_400_000;
const SATURDAY = 6;
export const GLOW_INTENSITY = 5;

export interface ContributionsGraphGeometry extends CSSProperties {
	"--contribution-cell-shadow"?: string;
	"--contribution-tooltip-left"?: string;
	"--contribution-tooltip-top"?: string;
}

export interface Cell {
	active: boolean;
	bucket: number;
	count: number;
	date: Date;
	filler: boolean;
	key: string;
}

interface LevelClasses {
	level0: string;
	level1: string;
	level2: string;
	level3: string;
	level4: string;
}

const colorSchemas = {
	gray: {
		level0: styles.emptyCell,
		level1: styles.grayLow,
		level2: styles.grayMedium,
		level3: styles.grayHigh,
		level4: styles.grayPeak,
	},
	green: {
		level0: styles.emptyCell,
		level1: styles.greenLow,
		level2: styles.greenMedium,
		level3: styles.greenHigh,
		level4: styles.greenPeak,
	},
	blue: {
		level0: styles.emptyCell,
		level1: styles.blueLow,
		level2: styles.blueMedium,
		level3: styles.blueHigh,
		level4: styles.bluePeak,
	},
	purple: {
		level0: styles.emptyCell,
		level1: styles.purpleLow,
		level2: styles.purpleMedium,
		level3: styles.purpleHigh,
		level4: styles.purplePeak,
	},
	orange: {
		level0: styles.emptyCell,
		level1: styles.orangeLow,
		level2: styles.orangeMedium,
		level3: styles.orangeHigh,
		level4: styles.orangePeak,
	},
} satisfies Record<ContributionsGraphColorSchema, LevelClasses>;

const pad2 = (value: number): string => value.toString().padStart(2, "0");

const toKey = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

const parseDay = (day: string): Date => new Date(`${day}T00:00:00Z`);

const addDays = (date: Date, days: number): Date =>
	new Date(date.getTime() + days * MS_PER_DAY);

const startOfUtcDay = (date: Date): Date =>
	new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
	);

const resolveEndDate = (data: ContributionDay[]): Date => {
	let latest: string | null = null;
	for (const entry of data) {
		if (latest === null || entry.day > latest) {
			latest = entry.day;
		}
	}
	return latest === null ? startOfUtcDay(new Date()) : parseDay(latest);
};

const bucketForCount = (
	count: number,
	maxCount: number,
	levels: number
): number => {
	if (count <= 0 || maxCount <= 0) {
		return 0;
	}
	const scaled = Math.ceil((count / maxCount) * levels);
	return Math.min(Math.max(scaled, 1), levels);
};

/** An active day with no count still shows as the lowest filled level. */
const bucketForDay = (
	count: number,
	active: boolean,
	maxCount: number,
	levels: number
): number => {
	if (count > 0) {
		return bucketForCount(count, maxCount, levels);
	}
	return active ? 1 : 0;
};

export const buildWeeks = (
	data: ContributionDay[],
	levels: number
): Cell[][] => {
	const counts = new Map<string, number>();
	const activeKeys = new Set<string>();
	let maxCount = 0;
	for (const entry of data) {
		if (entry.active === true) {
			activeKeys.add(entry.day);
		}
		const next = (counts.get(entry.day) ?? 0) + entry.count;
		counts.set(entry.day, next);
		if (next > maxCount) {
			maxCount = next;
		}
	}

	const endDate = resolveEndDate(data);
	const lastCell = addDays(endDate, SATURDAY - endDate.getUTCDay());
	const firstCell = addDays(lastCell, -(TOTAL_CELLS - 1));

	const weeks: Cell[][] = [];
	for (let week = 0; week < WEEKS; week += 1) {
		const days: Cell[] = [];
		for (let weekday = 0; weekday < DAYS_IN_WEEK; weekday += 1) {
			const date = addDays(firstCell, week * DAYS_IN_WEEK + weekday);
			const key = toKey(date);
			const count = counts.get(key) ?? 0;
			const active = count > 0 || activeKeys.has(key);
			days.push({
				active,
				date,
				key,
				count,
				bucket: bucketForDay(count, active, maxCount, levels),
				filler: date.getTime() > endDate.getTime(),
			});
		}
		weeks.push(days);
	}
	return weeks;
};

export const levelClassFor = (
	bucket: number,
	schema: ContributionsGraphColorSchema
): string => {
	const levels = colorSchemas[schema];
	if (bucket <= 0) {
		return levels.level0;
	}
	if (bucket === 1) {
		return levels.level1;
	}
	if (bucket === 2) {
		return levels.level2;
	}
	if (bucket === 3) {
		return levels.level3;
	}
	return levels.level4;
};

export const cornersClassFor = (corners: ContributionsGraphCorners): string => {
	if (corners === "circle") {
		return "rounded-full";
	}
	if (corners === "square") {
		return "rounded-none";
	}
	if (corners === "squircle") {
		return "rounded-sm";
	}
	return styles.roundedCell;
};

export const glowColorFor = (schema: ContributionsGraphColorSchema): string => {
	if (schema === "blue") {
		return "#3b82f6";
	}
	if (schema === "purple") {
		return "#a855f7";
	}
	if (schema === "orange") {
		return "#f97316";
	}
	return "#10b981";
};

export const GitHubIcon = (
	<svg
		aria-hidden="true"
		className="fill-current text-muted-foreground"
		data-view-component="true"
		height="16"
		viewBox="0 0 16 16"
		width="16"
	>
		<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
	</svg>
);
