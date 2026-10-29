import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Passport view model. Every agent is a country with its own stamp; every
 * conversation is an entry stamp on that country's visa pages. All of it is
 * pure and deterministic, so the booklet looks the same on every render.
 */

export type StampShape = "circle" | "octagon" | "rectangle" | "triangle";
export type StampBorder = "double" | "dotted" | "solid" | "ticked";
export type StampMarking =
	| "applied"
	| "arrived"
	| "denied"
	| "exited"
	| "processing";

export const STAMP_SHAPES: readonly StampShape[] = [
	"circle",
	"rectangle",
	"octagon",
	"triangle",
];
export const STAMP_BORDERS: readonly StampBorder[] = [
	"double",
	"ticked",
	"solid",
	"dotted",
];
/** How many inks the palette offers (`STAMP_INKS` in passport-palette.ts). */
export const INK_COUNT = 6;

/** Marking order on the notes page: most urgent first, like the protocol's. */
export const MARKING_ORDER: readonly StampMarking[] = [
	"denied",
	"arrived",
	"processing",
	"applied",
	"exited",
];

export const MARKING_LABELS: Record<StampMarking, string> = {
	applied: "APPLIED",
	arrived: "ARRIVED – AWAITING ENTRY",
	denied: "ENTRY DENIED",
	exited: "EXITED",
	processing: "VISA PROCESSING",
};

/** The same markings in plain words, for the notes page and the record. */
export const MARKING_MEANINGS: Record<StampMarking, string> = {
	applied: "Sent; waiting on the agent",
	arrived: "The agent replied; your turn",
	denied: "The last run failed or stopped",
	exited: "Nothing is pending",
	processing: "The agent is working now",
};

const MARKING_BY_STATUS: Record<ThreadStatus, StampMarking> = {
	attention: "denied",
	quiet: "exited",
	waiting: "applied",
	working: "processing",
	"your-turn": "arrived",
};

export function stampMarking(thread: InterfaceThread): StampMarking {
	return MARKING_BY_STATUS[threadStatus(thread)];
}

export interface StampStyle {
	border: StampBorder;
	/** Index into the palette's stamp inks. */
	ink: number;
	shape: StampShape;
}

export interface PassportStamp {
	/** Codes of the other countries on a shared conversation. */
	companions: string[];
	countryId: string | null;
	/** First known activity (ms). */
	entryAt: number;
	/** Which ink-grain filter the stamp prints with (0..2). */
	grain: number;
	/** Latest activity (ms). */
	latestAt: number;
	marking: StampMarking;
	/** Small, stable nudge off the grid, in page px. */
	offset: { x: number; y: number };
	/** Degrees; stamps never land square. */
	rotation: number;
	thread: InterfaceThread;
}

export interface PassportCountry {
	agent: InterfaceAgent;
	code: string;
	id: string;
	/** Latest activity across the country's stamps (ms), or null if unvisited. */
	lastEntryAt: number | null;
	stamps: PassportStamp[];
	style: StampStyle;
}

export type PassportPage =
	| { kind: "blank"; number: number }
	| { kind: "cover" }
	| { kind: "identity"; number: number }
	| { kind: "notes"; number: number }
	| {
			/** Null for the unassigned pages (conversations with no agent). */
			countryId: string | null;
			/** First page of this country: carries the visa block. */
			first: boolean;
			kind: "visa";
			number: number;
			stamps: PassportStamp[];
	  };

/** A two-page opening. The cover spread has no left page. */
export interface PassportSpread {
	left: number | null;
	right: number | null;
}

export interface PassportTotals {
	countries: number;
	stamps: number;
	travelDays: number;
}

export interface Passport {
	countries: PassportCountry[];
	/** Earliest known activity (ms), or null with no stamps. */
	issuedAt: number | null;
	latestAt: number | null;
	number: string;
	pages: PassportPage[];
	totals: PassportTotals;
	unassigned: PassportStamp[];
}

/** Conversations with no agent: one shared section, not a country. */
export const UNASSIGNED_CODE = "GEN";
export const UNASSIGNED_LABEL = "Unassigned";
/** Unassigned entries print the workspace's plain rectangle in page ink. */
export const UNASSIGNED_STYLE: StampStyle = {
	border: "double",
	ink: 0,
	shape: "rectangle",
};

/** Stamps a country's first page holds under its visa block, and later pages. */
export const FIRST_PAGE_STAMPS = 4;
export const PAGE_STAMPS = 6;

/**
 * Inks that read alike on paper (blue and violet, blue and slate, green and
 * slate, oxblood and umber; see STAMP_INKS). Two countries with the same
 * stamp shape never take a pair from this list, so they stay told apart.
 */
const SIMILAR_INKS: readonly (readonly [number, number])[] = [
	[0, 3],
	[0, 4],
	[2, 4],
	[1, 5],
];

function inksAlike(a: number, b: number): boolean {
	return (
		a === b ||
		SIMILAR_INKS.some(
			([first, second]) =>
				(first === a && second === b) || (first === b && second === a)
		)
	);
}

/**
 * Hand out inks to one batch of at most `count` ids, each id trying slots
 * from its own hashed start. Backtracks so no two ids with the same shape
 * share an ink that reads alike; null when no such assignment exists.
 */
function inkBatch(
	ids: readonly string[],
	shapes: ReadonlyMap<string, number>,
	count: number
): number[] | null {
	const chosen: number[] = [];
	const place = (index: number): boolean => {
		const id = ids[index];
		if (id === undefined) {
			return true;
		}
		const start = stableHash(`ink:${id}`) % count;
		for (let step = 0; step < count; step += 1) {
			const slot = (start + step) % count;
			const clash = chosen.some(
				(ink, other) =>
					ink === slot ||
					(shapes.get(ids[other] ?? "") === shapes.get(id) &&
						inksAlike(ink, slot))
			);
			if (!clash) {
				chosen.push(slot);
				if (place(index + 1)) {
					return true;
				}
				chosen.pop();
			}
		}
		return false;
	};
	return place(0) ? chosen : null;
}

/**
 * Inks per agent: every ink once per `count` agents (in sorted id order, so
 * the result depends only on the set of ids), and countries that share a
 * stamp shape never share an ink that reads alike. If that cannot be met,
 * it falls back to plain distinct slots.
 */
export function assignInks(
	ids: readonly string[],
	shapes: ReadonlyMap<string, number>,
	count: number
): Map<string, number> {
	const sorted = [...ids].sort();
	const inks = new Map<string, number>();
	for (let start = 0; start < sorted.length; start += count) {
		const batch = sorted.slice(start, start + count);
		const chosen = inkBatch(batch, shapes, count);
		const fallback = chosen ? null : assignSlots(batch, count, "ink");
		batch.forEach((id, index) => {
			inks.set(id, chosen?.[index] ?? fallback?.get(id) ?? 0);
		});
	}
	return inks;
}

/** FNV-1a: a small, stable string hash. */
export function stableHash(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/**
 * Hand each id a slot in `0..count-1` from its hash, moving to the next free
 * slot on a collision until every slot is used once. Ids are taken in sorted
 * order, so the result depends only on the set of ids.
 */
export function assignSlots(
	ids: readonly string[],
	count: number,
	salt: string
): Map<string, number> {
	const slots = new Map<string, number>();
	let used = new Set<number>();
	for (const id of [...ids].sort()) {
		if (used.size >= count) {
			used = new Set();
		}
		let slot = stableHash(`${salt}:${id}`) % count;
		while (used.has(slot)) {
			slot = (slot + 1) % count;
		}
		used.add(slot);
		slots.set(id, slot);
	}
	return slots;
}

function lettersOf(name: string): string {
	return name.toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * Three-letter country codes from agent names (ATL for Atlas), unique within
 * the passport: on a clash, the first letter plus later consonants, then a
 * counter.
 */
export function countryCodes(
	agents: readonly Pick<InterfaceAgent, "id" | "name">[]
): Map<string, string> {
	const codes = new Map<string, string>();
	const taken = new Set<string>();
	for (const agent of agents) {
		const letters = lettersOf(agent.name) || lettersOf(agent.id) || "XXX";
		const padded = letters.padEnd(3, "X");
		const consonants = letters.slice(1).replace(/[AEIOU]/g, "");
		const candidates = [
			padded.slice(0, 3),
			`${padded[0]}${consonants.slice(0, 2)}`.padEnd(3, "X"),
			`${padded[0]}${consonants[0] ?? "X"}${consonants.at(-1) ?? "X"}`,
		];
		let code = candidates.find((candidate) => !taken.has(candidate));
		for (let index = 2; !code; index += 1) {
			const numbered = `${padded.slice(0, 2)}${index}`;
			code = taken.has(numbered) ? undefined : numbered;
		}
		taken.add(code);
		codes.set(agent.id, code);
	}
	return codes;
}

function parseTime(iso: string): number | null {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : time;
}

function stampFor(
	thread: InterfaceThread,
	countryId: string | null,
	codes: Map<string, string>,
	firstSeen: Readonly<Record<string, string>>
): PassportStamp | null {
	const latestAt = parseTime(thread.updatedAt);
	if (latestAt === null) {
		return null;
	}
	const seen = firstSeen[thread.id];
	const seenAt = seen ? parseTime(seen) : null;
	const hash = stableHash(thread.id);
	return {
		companions: thread.agentIds
			.filter((id) => id !== countryId)
			.map((id) => codes.get(id))
			.filter((code): code is string => Boolean(code)),
		countryId,
		entryAt: seenAt === null ? latestAt : Math.min(seenAt, latestAt),
		grain: hash % 3,
		latestAt,
		marking: stampMarking(thread),
		offset: {
			x: ((hash >>> 4) % 13) - 6,
			y: ((hash >>> 9) % 11) - 5,
		},
		// -8..8 degrees, never exactly square.
		rotation: (((hash >>> 13) % 15) - 7) * 1.1 || 2.5,
		thread,
	};
}

function byEntry(a: PassportStamp, b: PassportStamp): number {
	return a.entryAt - b.entryAt || a.thread.id.localeCompare(b.thread.id);
}

function chunk<T>(items: readonly T[], first: number, rest: number): T[][] {
	const pages: T[][] = [items.slice(0, first)];
	for (let start = first; start < items.length; start += rest) {
		pages.push(items.slice(start, start + rest));
	}
	return pages;
}

function passportNumber(agentIds: readonly string[]): string {
	const hash = stableHash([...agentIds].sort().join("|") || "ryu");
	return `R${String(hash % 100_000_000).padStart(8, "0")}`;
}

/**
 * Build the booklet. `firstSeen` maps thread ids to the earliest time this
 * viewer has seen them, so an entry date can predate the latest activity;
 * without it, a stamp enters on its latest activity.
 */
export function buildPassport(
	snapshot: InterfaceSnapshot,
	firstSeen: Readonly<Record<string, string>> = {}
): Passport {
	const codes = countryCodes(snapshot.agents);
	const agentIds = snapshot.agents.map((agent) => agent.id);
	const shapes = assignSlots(agentIds, STAMP_SHAPES.length, "shape");
	const inks = assignInks(agentIds, shapes, INK_COUNT);
	const knownAgents = new Set(agentIds);

	const stampsByCountry = new Map<string, PassportStamp[]>();
	const unassigned: PassportStamp[] = [];
	for (const thread of snapshot.threads) {
		const countryId = thread.agentIds.find((id) => knownAgents.has(id)) ?? null;
		const stamp = stampFor(thread, countryId, codes, firstSeen);
		if (!stamp) {
			continue;
		}
		if (countryId) {
			const list = stampsByCountry.get(countryId) ?? [];
			list.push(stamp);
			stampsByCountry.set(countryId, list);
		} else {
			unassigned.push(stamp);
		}
	}

	const countries: PassportCountry[] = snapshot.agents.map((agent) => {
		const stamps = (stampsByCountry.get(agent.id) ?? []).sort(byEntry);
		const hash = stableHash(agent.id);
		return {
			agent,
			code: codes.get(agent.id) ?? "XXX",
			id: agent.id,
			lastEntryAt: stamps.length
				? Math.max(...stamps.map((stamp) => stamp.latestAt))
				: null,
			stamps,
			style: {
				border: STAMP_BORDERS[(hash >>> 3) % STAMP_BORDERS.length] ?? "double",
				ink: inks.get(agent.id) ?? 0,
				shape: STAMP_SHAPES[shapes.get(agent.id) ?? 0] ?? "circle",
			},
		};
	});
	// Most recent travel first; unvisited countries after, by name.
	countries.sort(
		(a, b) =>
			(b.lastEntryAt ?? Number.NEGATIVE_INFINITY) -
				(a.lastEntryAt ?? Number.NEGATIVE_INFINITY) ||
			a.agent.name.localeCompare(b.agent.name)
	);
	unassigned.sort(byEntry);

	const allStamps = [
		...countries.flatMap((country) => country.stamps),
		...unassigned,
	];
	const days = new Set<string>();
	for (const stamp of allStamps) {
		days.add(localDayKey(new Date(stamp.entryAt)));
		days.add(localDayKey(new Date(stamp.latestAt)));
	}

	const pages: PassportPage[] = [
		{ kind: "cover" },
		{ kind: "notes", number: 1 },
		{ kind: "identity", number: 2 },
	];
	const push = (countryId: string | null, stamps: readonly PassportStamp[]) => {
		chunk(stamps, FIRST_PAGE_STAMPS, PAGE_STAMPS).forEach((group, index) => {
			pages.push({
				countryId,
				first: index === 0,
				kind: "visa",
				number: pages.length,
				stamps: group,
			});
		});
	};
	for (const country of countries) {
		push(country.id, country.stamps);
	}
	if (unassigned.length > 0) {
		push(null, unassigned);
	}
	// Pages after the cover pair into spreads; close the last one with a blank.
	if ((pages.length - 1) % 2 === 1) {
		pages.push({ kind: "blank", number: pages.length });
	}

	const times = allStamps.flatMap((stamp) => [stamp.entryAt, stamp.latestAt]);
	return {
		countries,
		issuedAt: times.length ? Math.min(...times) : null,
		latestAt: times.length ? Math.max(...times) : null,
		number: passportNumber(agentIds),
		unassigned,
		pages,
		totals: {
			countries: countries.filter((country) => country.stamps.length > 0)
				.length,
			stamps: allStamps.length,
			travelDays: days.size,
		},
	};
}

/** Openings of the booklet: the closed cover, then pages two at a time. */
export function bookletSpreads(pageCount: number): PassportSpread[] {
	const spreads: PassportSpread[] = [{ left: null, right: 0 }];
	for (let page = 1; page < pageCount; page += 2) {
		spreads.push({
			left: page,
			right: page + 1 < pageCount ? page + 1 : null,
		});
	}
	return spreads;
}

/** One page per view, for narrow windows. */
export function singleSpreads(pageCount: number): PassportSpread[] {
	return Array.from({ length: pageCount }, (_, page) => ({
		left: null,
		right: page,
	}));
}

export function spreadOfPage(
	spreads: readonly PassportSpread[],
	page: number
): number {
	const index = spreads.findIndex(
		(spread) => spread.left === page || spread.right === page
	);
	return Math.max(0, index);
}

/** The first page of a country (null: the unassigned pages), or -1. */
export function countryPage(
	pages: readonly PassportPage[],
	countryId: string | null
): number {
	return pages.findIndex(
		(page) => page.kind === "visa" && page.first && page.countryId === countryId
	);
}

/**
 * Where the booklet opens: the first visa page with a stamp on it (the
 * passport is for its stamps), else the first visa page, else the cover.
 */
export function openingPage(pages: readonly PassportPage[]): number {
	const stamped = pages.findIndex(
		(page) => page.kind === "visa" && page.stamps.length > 0
	);
	if (stamped > 0) {
		return stamped;
	}
	const visa = pages.findIndex((page) => page.kind === "visa");
	return Math.max(0, visa);
}

/** The page a thread's stamp is on, or -1. */
export function stampPage(
	pages: readonly PassportPage[],
	threadId: string
): number {
	return pages.findIndex(
		(page) =>
			page.kind === "visa" &&
			page.stamps.some((stamp) => stamp.thread.id === threadId)
	);
}

export function findStamp(
	passport: Passport,
	threadId: string | null
): PassportStamp | null {
	if (!threadId) {
		return null;
	}
	for (const country of passport.countries) {
		const found = country.stamps.find((stamp) => stamp.thread.id === threadId);
		if (found) {
			return found;
		}
	}
	return (
		passport.unassigned.find((stamp) => stamp.thread.id === threadId) ?? null
	);
}

const MONTHS = [
	"JAN",
	"FEB",
	"MAR",
	"APR",
	"MAY",
	"JUN",
	"JUL",
	"AUG",
	"SEP",
	"OCT",
	"NOV",
	"DEC",
] as const;

/** "14 OCT 2026", the way entry stamps print a date. */
export function stampDate(time: number): string {
	const date = new Date(time);
	const day = String(date.getDate()).padStart(2, "0");
	return `${day} ${MONTHS[date.getMonth()] ?? ""} ${date.getFullYear()}`;
}

/** "14 Oct 2026": the stamp's date with a title-case month, for speech. */
export function spokenDate(time: number): string {
	const date = new Date(time);
	const month = MONTHS[date.getMonth()] ?? "";
	const titleMonth = `${month.slice(0, 1)}${month.slice(1).toLowerCase()}`;
	return `${String(date.getDate()).padStart(2, "0")} ${titleMonth} ${date.getFullYear()}`;
}

/** "14 OCT": day and month, for short date lines. */
export function stampDayMonth(time: number): string {
	const date = new Date(time);
	return `${String(date.getDate()).padStart(2, "0")} ${MONTHS[date.getMonth()] ?? ""}`;
}

/** "09:41", 24-hour local time. */
export function stampTime(time: number): string {
	const date = new Date(time);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The stamp's second date line: the time when the latest activity fell on the
 * entry day, otherwise the latest day.
 */
export function latestLine(stamp: Pick<PassportStamp, "entryAt" | "latestAt">) {
	const sameDay =
		localDayKey(new Date(stamp.entryAt)) ===
		localDayKey(new Date(stamp.latestAt));
	return `LAST ${sameDay ? stampTime(stamp.latestAt) : stampDayMonth(stamp.latestAt)}`;
}

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

/** "1 stamp", "3 stamps". */
export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
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

/** A sentence the stamp button reads out. */
export function stampLabel(
	stamp: PassportStamp,
	countryName: string | null
): string {
	const parts = [
		stamp.thread.title || "Untitled conversation",
		countryName ?? "Unassigned",
		MARKING_LABELS[stamp.marking].toLowerCase(),
		`entered ${spokenDate(stamp.entryAt)}`,
	];
	if (stamp.latestAt !== stamp.entryAt) {
		parts.push(`last ${spokenDate(stamp.latestAt)}`);
	}
	return parts.join(", ");
}
