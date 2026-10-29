import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Pure view-model for the Hub (after a smart display's ambient screen and
 * glanceable cards). Everything here is deterministic for a given snapshot
 * and clock so the renderer and the tests agree.
 */

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export const HUB_CARDS = [
	"waiting",
	"working",
	"attention",
	"upcoming",
	"agents",
	"compose",
] as const;

export type HubCard = (typeof HUB_CARDS)[number];

export const HUB_CARD_LABELS: Record<HubCard, string> = {
	agents: "Agents",
	attention: "Needs attention",
	compose: "Start a conversation",
	upcoming: "Upcoming runs",
	waiting: "Waiting on you",
	working: "Working now",
};

/** Next card index; the carousel stops at both ends, like the reference. */
export function stepHubCard(index: number, delta: number): number {
	return Math.min(HUB_CARDS.length - 1, Math.max(0, index + delta));
}

/** How long the cards stay up without input before the display dims. */
export const HUB_IDLE_MS = 45_000;

/** Rows a list card shows before it summarizes the rest: the top three. */
export const HUB_CARD_ROWS = 3;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type HubKeyAction =
	| "close"
	| "first"
	| "last"
	| "next"
	| "prev"
	| "wake";

interface KeyLike {
	altKey: boolean;
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
}

export function hubKeyAction(event: KeyLike): HubKeyAction | null {
	if (event.altKey || event.ctrlKey || event.metaKey) {
		return null;
	}
	switch (event.key) {
		case "Escape":
			return "close";
		case "ArrowRight":
			return "next";
		case "ArrowLeft":
			return "prev";
		case "Home":
			return "first";
		case "End":
			return "last";
		case "Enter":
		case " ":
			return "wake";
		default:
			return null;
	}
}

/** Text fields keep their own keys (arrows move the caret, Enter sends). */
export function isHubTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false;
	}
	return (
		target.closest(
			"input, textarea, select, [contenteditable=''], [contenteditable='true']"
		) !== null
	);
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface HubClock {
	/** "AM"/"PM" in 12-hour locales, empty in 24-hour ones. */
	dayPeriod: string;
	/** "10:42" without the day period, like the reference's ambient clock. */
	time: string;
}

/** "22:42", the machine-readable form for a `<time>` element. */
export function hubClockDateTime(now: number): string {
	const date = new Date(now);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function hubClock(now: number, locale?: string): HubClock {
	const parts = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).formatToParts(new Date(now));
	let time = "";
	let dayPeriod = "";
	for (const part of parts) {
		if (part.type === "dayPeriod") {
			dayPeriod = part.value;
		} else {
			time += part.value;
		}
	}
	return { dayPeriod, time: time.trim() };
}

/** "Wednesday, October 14". */
export function hubDate(now: number, locale?: string): string {
	return new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "long",
		weekday: "long",
	}).format(new Date(now));
}

export function hubGreeting(now: number): string {
	const hour = new Date(now).getHours();
	if (hour < 5) {
		return "Good evening";
	}
	if (hour < 12) {
		return "Good morning";
	}
	if (hour < 18) {
		return "Good afternoon";
	}
	return "Good evening";
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export type HubCounts = Record<ThreadStatus, number>;

export function hubCounts(snapshot: InterfaceSnapshot): HubCounts {
	const counts: HubCounts = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of snapshot.threads) {
		counts[threadStatus(thread)] += 1;
	}
	return counts;
}

const STATUS_PARTS: {
	phrase: (count: number) => string;
	status: "attention" | "working" | "your-turn";
}[] = [
	{
		phrase: (count) => `${count} ${count === 1 ? "needs" : "need"} attention`,
		status: "attention",
	},
	{ phrase: (count) => `${count} working`, status: "working" },
	{ phrase: (count) => `${count} waiting on you`, status: "your-turn" },
];

/**
 * The status line: only what asks something of the user, in the order it
 * matters ("1 needs attention · 2 working · 5 waiting on you"). The ambient
 * screen passes `omit` so the line carries the facts its glyph does not.
 */
export function hubStatusLine(
	counts: HubCounts,
	snapshot: InterfaceSnapshot,
	omit?: HubGlyph
): string {
	return hubStatusParts(counts, snapshot, omit).join(" · ");
}

/**
 * The status line as separate facts, so a narrow screen can wrap between
 * them rather than in the middle of one.
 */
export function hubStatusParts(
	counts: HubCounts,
	snapshot: InterfaceSnapshot,
	omit?: HubGlyph
): string[] {
	if (snapshot.threads.length === 0 && counts.attention === 0) {
		return [
			snapshot.agents.length === 0 ? "No agents yet" : "No conversations yet",
		];
	}
	const parts: string[] = [];
	for (const part of STATUS_PARTS) {
		const count = counts[part.status];
		if (count > 0 && part.status !== omit) {
			parts.push(part.phrase(count));
		}
	}
	if (parts.length > 0) {
		return parts;
	}
	return [omit && omit !== "clear" ? "Nothing else waiting" : "All caught up"];
}

/**
 * Counts with failed scheduled runs folded into "needs attention", so the
 * status line, the ambient glyph, and the Needs attention card agree.
 */
export function hubWithFailedRuns(
	counts: HubCounts,
	failedRuns: InterfaceEvent[]
): HubCounts {
	return { ...counts, attention: counts.attention + failedRuns.length };
}

/** Which mark stands in the clock's weather slot: the most urgent state. */
export type HubGlyph = "attention" | "clear" | "working" | "your-turn";

export function hubGlyph(counts: HubCounts): HubGlyph {
	if (counts.attention > 0) {
		return "attention";
	}
	if (counts["your-turn"] > 0) {
		return "your-turn";
	}
	if (counts.working > 0) {
		return "working";
	}
	return "clear";
}

/** The number next to the glyph, like a temperature next to the weather. */
export function hubGlyphCount(glyph: HubGlyph, counts: HubCounts): number {
	if (glyph === "clear") {
		return 0;
	}
	return counts[glyph];
}

/** "1 needs attention", "3 working", "All caught up": the glyph's spoken name. */
export function hubGlyphLabel(glyph: HubGlyph, count: number): string {
	if (glyph === "clear") {
		return "All caught up";
	}
	const part = STATUS_PARTS.find((candidate) => candidate.status === glyph);
	return part ? part.phrase(count) : `${count}`;
}

function pinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

function recent(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function hubThreads(
	snapshot: InterfaceSnapshot,
	status: ThreadStatus
): InterfaceThread[] {
	const matches = snapshot.threads.filter(
		(thread) => threadStatus(thread) === status
	);
	return matches.sort(status === "your-turn" ? pinnedThenRecent : recent);
}

export function hubThreadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled conversation";
}

export function hubThreadAgents(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	const agents: InterfaceAgent[] = [];
	for (const id of thread.agentIds) {
		const agent = snapshot.agents.find((candidate) => candidate.id === id);
		if (agent) {
			agents.push(agent);
		}
	}
	return agents;
}

/** "Forge" / "Atlas, Echo +1" / "No agent". */
export function hubAgentNames(agents: InterfaceAgent[]): string {
	if (agents.length === 0) {
		return "No agent";
	}
	const shown = agents
		.slice(0, 2)
		.map((agent) => agent.name)
		.join(", ");
	return agents.length > 2 ? `${shown} +${agents.length - 2}` : shown;
}

/**
 * Names as a sentence subject: "Forge", "Forge and Delta",
 * "Forge, Delta and Echo", "Forge, Delta and 2 more".
 */
export function hubNameList(agents: InterfaceAgent[]): string {
	const names = agents.map((agent) => agent.name);
	if (names.length <= 2) {
		return names.join(" and ");
	}
	if (names.length === 3) {
		return `${names[0]}, ${names[1]} and ${names[2]}`;
	}
	return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** Live work per agent: how many of its threads are running. */
export function hubAgentRuns(snapshot: InterfaceSnapshot): Map<string, number> {
	const runs = new Map<string, number>();
	for (const thread of snapshot.threads) {
		if (!thread.running) {
			continue;
		}
		for (const id of thread.agentIds) {
			runs.set(id, (runs.get(id) ?? 0) + 1);
		}
	}
	return runs;
}

/**
 * Whether an agent is live: its own status, or any running thread it is on.
 * Every count on the screen uses this so the header line, the Working card
 * and the Agents card never disagree about who is working.
 */
export function hubAgentLive(
	agent: InterfaceAgent,
	runs: Map<string, number>
): boolean {
	return agent.status === "working" || (runs.get(agent.id) ?? 0) > 0;
}

/**
 * Idle agents first, then by name: the composer's recipients, so the default
 * pick is someone free to start now.
 */
export function hubComposeAgents(
	snapshot: InterfaceSnapshot,
	runs: Map<string, number> = hubAgentRuns(snapshot)
): InterfaceAgent[] {
	return [...snapshot.agents].sort(
		(a, b) =>
			Number(hubAgentLive(a, runs)) - Number(hubAgentLive(b, runs)) ||
			a.name.localeCompare(b.name)
	);
}

/** Working agents first, then by name, so the grid leads with live work. */
export function hubAgents(
	snapshot: InterfaceSnapshot,
	runs: Map<string, number> = hubAgentRuns(snapshot)
): InterfaceAgent[] {
	return [...snapshot.agents].sort(
		(a, b) =>
			Number(hubAgentLive(b, runs)) - Number(hubAgentLive(a, runs)) ||
			a.name.localeCompare(b.name)
	);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "now", "4 min ago", "3 hr ago", "Yesterday", "Oct 5". */
export function hubAgo(iso: string, now: number, locale?: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const elapsed = Math.max(0, now - then);
	if (elapsed < MINUTE_MS) {
		return "now";
	}
	if (elapsed < HOUR_MS) {
		return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
	}
	if (elapsed < DAY_MS) {
		return `${Math.floor(elapsed / HOUR_MS)} hr ago`;
	}
	if (elapsed < 2 * DAY_MS) {
		return "Yesterday";
	}
	return new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
	}).format(new Date(then));
}

function startOfDay(time: number): number {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * When a scheduled run starts, in the reference's words: "In 40 min",
 * "In 3 hr", "Tomorrow, 9:00 AM", "Fri, 5:00 PM", "Oct 23, 9:00 AM". Every
 * dated form carries its time, so rows in one list read alike.
 */
export function hubRunWhen(iso: string, now: number, locale?: string): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const until = start - now;
	if (until < MINUTE_MS) {
		return "Now";
	}
	const minutes = Math.round(until / MINUTE_MS);
	if (minutes < 60) {
		return `In ${minutes} min`;
	}
	// Within a few hours a countdown reads faster than a clock time, even
	// across midnight.
	if (minutes < 6 * 60) {
		return `In ${Math.round(minutes / 60)} hr`;
	}
	const days = Math.round((startOfDay(start) - startOfDay(now)) / DAY_MS);
	const time = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(start));
	if (days === 0) {
		return `Today, ${time}`;
	}
	if (days === 1) {
		return `Tomorrow, ${time}`;
	}
	if (days < 7) {
		const weekday = new Intl.DateTimeFormat(locale, {
			weekday: "short",
		}).format(new Date(start));
		return `${weekday}, ${time}`;
	}
	const day = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
	}).format(new Date(start));
	return `${day}, ${time}`;
}

/**
 * The Upcoming card's headline from `hubRunWhen`: "Next run in 40 min",
 * "Next run tomorrow at 9:00 AM", "Next run Fri at 5:00 PM". The day period
 * stays with its time when the headline wraps.
 */
export function hubNextRunHeadline(when: string): string {
	if (!when) {
		return "Next run soon";
	}
	if (when === "Now") {
		return "A run is starting now";
	}
	const unbroken = when.replace(/\s(?=[AP]M\b)/, "\u00a0");
	const relative = /^(In|Today|Tomorrow)\b/.test(unbroken);
	const phrase = relative
		? unbroken.charAt(0).toLowerCase() + unbroken.slice(1)
		: unbroken;
	// "tomorrow, 9:00 AM" reads as "tomorrow at 9:00 AM"; "today" drops out.
	const spoken = phrase.replace(/^today, /, "at ").replace(/, (?=\d)/, " at ");
	return `Next run ${spoken}`;
}

export function hubUpcoming(
	events: InterfaceEvent[] | undefined,
	now: number
): InterfaceEvent[] {
	return (events ?? [])
		.filter(
			(event) =>
				event.kind === "upcoming" && Date.parse(event.start) >= now - MINUTE_MS
		)
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Past runs that failed in the last day, shown under failed threads. */
export function hubFailedRuns(
	events: InterfaceEvent[] | undefined,
	now: number
): InterfaceEvent[] {
	return (events ?? [])
		.filter(
			(event) =>
				event.kind === "past" &&
				event.outcome === "failure" &&
				now - Date.parse(event.start) < 2 * DAY_MS
		)
		.sort((a, b) => b.start.localeCompare(a.start));
}

// ---------------------------------------------------------------------------
// Ambient art
// ---------------------------------------------------------------------------

/** A small seeded PRNG (mulberry32) so the scene is stable for a day. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d_2b_79_f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export function hubSeed(text: string): number {
	let hash = 2_166_136_261;
	for (const char of text) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

export interface HubArt {
	/**
	 * A soft light low over the hills: its center sits on the farthest ridge
	 * line, in the same 1600x900 box, so it reads as a sky glow, not a disc.
	 */
	bloom: { cx: number; cy: number; r: number };
	/** Rolling ridge lines, back to front, as SVG paths in a 1600x900 box. */
	ridges: string[];
}

export const HUB_ART_WIDTH = 1600;
export const HUB_ART_HEIGHT = 900;
const RIDGE_COUNT = 4;
const RIDGE_STEPS = 32;

/**
 * Layered hills at dusk, seeded by the day: a calm landscape that reads like
 * a photo at a distance and leaves the lower left quiet for the clock.
 */
export function hubArt(seed: number): HubArt {
	const random = seeded(seed);
	const ridges: string[] = [];
	const horizon: number[] = [];
	for (let layer = 0; layer < RIDGE_COUNT; layer += 1) {
		const base = HUB_ART_HEIGHT * (0.5 + layer * 0.11);
		const amplitude = HUB_ART_HEIGHT * (0.07 - layer * 0.01);
		const frequency = 1.2 + random() * 1.4;
		const phase = random() * Math.PI * 2;
		const detail = 2.6 + random() * 2.2;
		const detailPhase = random() * Math.PI * 2;
		const points: string[] = [];
		for (let step = 0; step <= RIDGE_STEPS; step += 1) {
			const t = step / RIDGE_STEPS;
			const y = Math.round(
				base -
					amplitude *
						(Math.sin(t * Math.PI * frequency + phase) * 0.75 +
							Math.sin(t * Math.PI * detail + detailPhase) * 0.25)
			);
			if (layer === 0) {
				horizon.push(y);
			}
			points.push(`${Math.round(t * HUB_ART_WIDTH)},${y}`);
		}
		ridges.push(
			`M0,${HUB_ART_HEIGHT} L${points.join(" L")} L${HUB_ART_WIDTH},${HUB_ART_HEIGHT} Z`
		);
	}
	const across = 0.58 + random() * 0.24;
	const step = Math.round(across * RIDGE_STEPS);
	return {
		bloom: {
			cx: Math.round(HUB_ART_WIDTH * across),
			cy: horizon[step] ?? Math.round(HUB_ART_HEIGHT * 0.5),
			r: Math.round(HUB_ART_HEIGHT * 0.55),
		},
		ridges,
	};
}

/**
 * The prompt a composer sends: what the user typed, prefixed with the run it
 * was opened about, so the agent knows which run the question concerns.
 */
export function hubTopicPrompt(
	topic: string | undefined,
	typed: string
): string {
	return topic ? `About the run "${topic}": ${typed}` : typed;
}
