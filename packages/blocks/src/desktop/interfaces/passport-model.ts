import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { assignInks } from "./passport-model-inks.ts";

export {
	latestLine,
	spokenDate,
	stampDate,
	stampDayMonth,
	stampTime,
} from "./passport-model-dates.ts";
export { assignInks } from "./passport-model-inks.ts";
export {
	bookletSpreads,
	countryPage,
	findStamp,
	openingPage,
	singleSpreads,
	spreadOfPage,
	stampPage,
} from "./passport-model-pages.ts";
export {
	mrzCheckDigit,
	mrzLines,
	placeStamps,
	recordNumber,
	recordSerial,
	rotatedInk,
	type StampPlacement,
	upcomingTravel,
	wrapLines,
} from "./passport-model-print.ts";
export {
	markingLabel,
	markingMeaning,
	markingName,
	stampLabel,
	unassignedLabel,
} from "./passport-model-words.ts";

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
	get applied() {
		return tr("APPLIED");
	},
	get arrived() {
		return tr("ARRIVED – AWAITING ENTRY");
	},
	get denied() {
		return tr("ENTRY DENIED");
	},
	get exited() {
		return tr("EXITED");
	},
	get processing() {
		return tr("VISA PROCESSING");
	},
};

/** The same markings in plain words, for the notes page and the record. */
export const MARKING_MEANINGS: Record<StampMarking, string> = {
	get applied() {
		return tr("Sent; waiting on the agent");
	},
	get arrived() {
		return tr("The agent replied; your turn");
	},
	get denied() {
		return tr("The last run failed or stopped");
	},
	get exited() {
		return tr("Nothing is pending");
	},
	get processing() {
		return tr("The agent is working now");
	},
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

export function parseTime(iso: string): number | null {
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
