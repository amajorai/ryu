import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import {
	type Passport,
	type PassportStamp,
	parseTime,
	type StampShape,
	stableHash,
} from "./passport-model.ts";

/** Spaces and punctuation that should not sit right before an ellipsis. */
const TRAILING_BREAK = /[\s\-–—,.:;/]+$/;

/**
 * Break text into at most `maxLines` lines of `maxChars`, on word boundaries
 * where it can, with an ellipsis when it runs out of room.
 */
export function wrapLines(
	text: string,
	maxChars: number,
	maxLines: number
): string[] {
	const words = text.trim().split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	let index = 0;
	while (index < words.length && lines.length < maxLines) {
		const word = words[index] ?? "";
		const next = current ? `${current} ${word}` : word;
		if (next.length <= maxChars) {
			current = next;
			index += 1;
		} else if (current) {
			lines.push(current);
			current = "";
		} else {
			// One word longer than a line: cut it.
			lines.push(word.slice(0, maxChars));
			words[index] = word.slice(maxChars);
		}
	}
	if (current && lines.length < maxLines) {
		lines.push(current);
		current = "";
	}
	const truncated = index < words.length || current.length > 0;
	if (truncated && lines.length > 0) {
		// Fill the last line with as much of the rest as fits, then mark the cut.
		const rest = [current, ...words.slice(index)].filter(Boolean).join(" ");
		const full = `${lines.at(-1) ?? ""} ${rest}`;
		let room = full.slice(0, maxChars - 1);
		const midWord = /\S/.test(full.charAt(room.length));
		const lastSpace = room.lastIndexOf(" ");
		// Never leave a one- or two-letter stub of a word before the ellipsis.
		if (midWord && lastSpace > 0 && room.length - lastSpace - 1 < 3) {
			room = room.slice(0, lastSpace);
		}
		lines[lines.length - 1] = `${room.replace(TRAILING_BREAK, "")}…`;
	}
	return lines;
}

const MRZ_LENGTH = 44;
const MRZ_WEIGHTS = [7, 3, 1] as const;

function mrzValue(char: string): number {
	if (char >= "0" && char <= "9") {
		return Number(char);
	}
	if (char >= "A" && char <= "Z") {
		return (char.codePointAt(0) ?? 65) - 55;
	}
	return 0;
}

/** ICAO 9303 check digit (weights 7, 3, 1; `<` counts as zero). */
export function mrzCheckDigit(value: string): string {
	let sum = 0;
	[...value].forEach((char, index) => {
		sum += mrzValue(char) * (MRZ_WEIGHTS[index % 3] ?? 1);
	});
	return String(sum % 10);
}

function mrzDate(time: number | null): string {
	if (time === null) {
		return "<<<<<<";
	}
	const date = new Date(time);
	return `${String(date.getFullYear() % 100).padStart(2, "0")}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

/** The two machine-readable lines at the foot of the identity page. */
export function mrzLines(passport: Passport): [string, string] {
	const first = "P<RYUWORKSPACE<<HOLDER".padEnd(MRZ_LENGTH, "<");
	const issued = mrzDate(passport.issuedAt);
	const latest = mrzDate(passport.latestAt);
	const counts = `${String(passport.totals.countries).padStart(2, "0")}${String(passport.totals.stamps).padStart(3, "0")}`;
	const second = [
		passport.number,
		mrzCheckDigit(passport.number),
		"RYU",
		issued,
		mrzCheckDigit(issued),
		"<",
		latest,
		mrzCheckDigit(latest),
		counts,
	]
		.join("")
		.padEnd(MRZ_LENGTH - 1, "<");
	return [first, `${second}${mrzCheckDigit(second)}`];
}

/** Upcoming scheduled runs, soonest first. */
export function upcomingTravel(
	events: readonly InterfaceEvent[] | undefined,
	now: number,
	limit: number
): InterfaceEvent[] {
	return (events ?? [])
		.filter(
			(event) =>
				event.kind === "upcoming" && (parseTime(event.start) ?? 0) >= now
		)
		.sort((a, b) => a.start.localeCompare(b.start))
		.slice(0, limit);
}

/**
 * The entry's record number, as printed on the record and the stamp rims.
 * It comes from the conversation's id alone, so it never changes between
 * renders, browsers, or once the entry date is known.
 */
export function recordSerial(threadId: string): string {
	return String(stableHash(`record:${threadId}`) % 100_000).padStart(5, "0");
}

export function recordNumber(code: string, threadId: string): string {
	return `${code}-${recordSerial(threadId)}`;
}

/** How much paper each stamp shape actually inks, inside its 168 × 140 box. */
const INK_EXTENT: Record<StampShape, { height: number; width: number }> = {
	circle: { height: 132, width: 132 },
	octagon: { height: 138, width: 138 },
	rectangle: { height: 112, width: 160 },
	triangle: { height: 136, width: 164 },
};

/** The axis-aligned size of a shape's ink once it is rotated. */
export function rotatedInk(
	shape: StampShape,
	rotation: number
): { height: number; width: number } {
	const extent = INK_EXTENT[shape];
	const radians = (Math.abs(rotation) * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return {
		height: extent.width * sin + extent.height * cos,
		width: extent.width * cos + extent.height * sin,
	};
}

/**
 * Where stamps land on a page: two columns, rows spread over the whole stamp
 * area, filled in a scattered order (top left, then bottom right, ...) so a
 * page with one or two entries is used top to bottom like a real one.
 */
const SCATTER: Record<number, readonly [number, number][]> = {
	2: [
		[0, 0],
		[1, 1],
		[1, 0],
		[0, 1],
	],
	3: [
		[0, 0],
		[1, 1],
		[0, 2],
		[1, 0],
		[0, 1],
		[1, 2],
	],
};

export interface StampPlacement {
	/** Horizontal centre of the stamp box, in page px from the area's start. */
	centerX: number;
	/** Vertical position as a fraction of the free height (0 top, 1 bottom). */
	fraction: number;
	/** Small vertical nudge in px that never pushes ink past the area. */
	nudgeY: number;
}

/**
 * Place a page's stamps inside an area `areaWidth` wide. The stamp's rotated
 * ink always stays inside the area, whatever its nudge.
 */
export function placeStamps(
	stamps: readonly Pick<PassportStamp, "offset" | "rotation">[],
	shape: StampShape,
	areaWidth: number,
	rows: 2 | 3
): StampPlacement[] {
	const order = SCATTER[rows] ?? SCATTER[3] ?? [];
	return stamps.map((stamp, index) => {
		const [column, row] = order[index % order.length] ?? [0, 0];
		const ink = rotatedInk(shape, stamp.rotation);
		const half = ink.width / 2;
		const base = areaWidth * (column === 0 ? 0.25 : 0.75);
		const centerX = Math.min(
			areaWidth - half,
			Math.max(half, base + stamp.offset.x * 1.5)
		);
		const fraction = rows > 1 ? row / (rows - 1) : 0;
		const lift = Math.abs(stamp.offset.y);
		let nudgeY = stamp.offset.y;
		if (fraction === 0) {
			nudgeY = lift;
		} else if (fraction === 1) {
			nudgeY = -lift;
		}
		return { centerX, fraction, nudgeY };
	});
}
