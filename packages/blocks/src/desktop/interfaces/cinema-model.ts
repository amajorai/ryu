import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { agentHue } from "./interface-renderer.ts";

/** How a title is set over its art, the way each show has its own logo. */
export type CinemaTitleType = "caps" | "display" | "serif";

const TITLE_TYPES: readonly CinemaTitleType[] = ["display", "caps", "serif"];

/** Where a title's key light falls; the monogram sits in the opposite shade. */
export type CinemaLight = "upper-left" | "upper-right" | "lower-right";

const LIGHTS: readonly CinemaLight[] = [
	"upper-right",
	"upper-left",
	"lower-right",
];

/**
 * Everything a title's key art needs, derived from the thread and its lead
 * agent so it never changes: every title by one agent shares that agent's
 * colour and monogram, and the thread id varies the lighting and type.
 */
export interface CinemaArtSpec {
	/** The lead agent's hue in degrees (the same hue its avatar uses). */
	hue: number;
	light: CinemaLight;
	/** The letter the art is built around: the agent's initial, else the title's. */
	monogram: string;
	/** No agent: the art is set in greys instead of an agent colour. */
	neutral: boolean;
	seed: number;
	type: CinemaTitleType;
}

/** FNV-1a: a stable 32-bit hash for ids. */
export function hashSeed(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function pick<T>(items: readonly T[], value: number): T {
	return items[value % items.length] as T;
}

function firstLetter(value: string): string {
	const letter = /[\p{L}\p{N}]/u.exec(value)?.[0];
	return letter ? letter.toUpperCase() : "R";
}

/** The art a thread id always gets, coloured by its lead agent when it has one. */
export function cinemaArt(
	id: string,
	agent: InterfaceAgent | null = null,
	title = ""
): CinemaArtSpec {
	const seed = hashSeed(id);
	return {
		hue: agentHue(agent?.id ?? id),
		light: pick(LIGHTS, seed >>> 3),
		monogram: firstLetter(agent?.name ?? title),
		neutral: agent === null,
		seed,
		type: pick(TITLE_TYPES, hashSeed(agent?.id ?? id) >>> 7),
	};
}

/** A thread as the catalogue shows it. */
export interface CinemaTitle {
	agents: InterfaceAgent[];
	art: CinemaArtSpec;
	group: InterfaceGroup | null;
	status: ThreadStatus;
	thread: InterfaceThread;
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function cinemaTitle(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): CinemaTitle {
	const agents: InterfaceAgent[] = [];
	for (const id of thread.agentIds) {
		const agent = snapshot.agents.find((candidate) => candidate.id === id);
		if (agent) {
			agents.push(agent);
		}
	}
	const groupId = thread.projectId ?? thread.teamId;
	const group =
		snapshot.groups.find((candidate) => candidate.id === groupId) ?? null;
	return {
		agents,
		art: cinemaArt(thread.id, agents[0] ?? null, thread.title),
		group,
		status: threadStatus(thread),
		thread,
	};
}

/** Every thread, newest first. */
export function cinemaTitles(snapshot: InterfaceSnapshot): CinemaTitle[] {
	return [...snapshot.threads]
		.sort(byRecency)
		.map((thread) => cinemaTitle(snapshot, thread));
}

/**
 * The billboard's title: the newest live run, else the newest thread that is
 * waiting on you, else whatever moved last.
 */
export function cinemaFeatured(
	titles: readonly CinemaTitle[]
): CinemaTitle | null {
	return (
		titles.find((title) => title.status === "working") ??
		titles.find((title) => title.status === "your-turn") ??
		titles[0] ??
		null
	);
}

/** A row on the home page, and the page "Explore all" leads to. */
export type CinemaCollectionId =
	| "attention"
	| "continue"
	| "list"
	| "live"
	| "recent"
	| "top"
	| `agent:${string}`;

export interface CinemaRow {
	id: CinemaCollectionId;
	/** `top` rows are ranked, with numerals beside tall posters. */
	layout: "boxart" | "top";
	title: string;
	titles: CinemaTitle[];
}

/** The most items a row carries; "Explore all" shows the rest. */
export const CINEMA_ROW_LIMIT = 20;
const TOP_LIMIT = 10;
/** A ranked row needs a few titles to mean anything. */
const TOP_MIN = 4;

function agentRowId(agentId: string): CinemaCollectionId {
	return `agent:${agentId}`;
}

/** Titles in one collection, in the order its page lists them. */
export function cinemaCollection(
	snapshot: InterfaceSnapshot,
	id: CinemaCollectionId,
	titles: readonly CinemaTitle[] = cinemaTitles(snapshot)
): CinemaTitle[] {
	switch (id) {
		case "continue":
			return titles.filter((title) => title.status === "your-turn");
		case "live":
			return titles.filter((title) => title.status === "working");
		case "attention":
			return titles.filter((title) => title.status === "attention");
		case "list":
			return titles.filter((title) => title.thread.pinned);
		case "recent":
			return [...titles];
		case "top":
			return [...titles]
				.sort(
					(a, b) =>
						b.thread.messageCount - a.thread.messageCount ||
						byRecency(a.thread, b.thread)
				)
				.slice(0, TOP_LIMIT);
		default: {
			const agentId = id.slice("agent:".length);
			return titles.filter((title) => title.thread.agentIds.includes(agentId));
		}
	}
}

/** What a collection is called on its row and its page. */
export function cinemaCollectionTitle(
	snapshot: InterfaceSnapshot,
	id: CinemaCollectionId
): string {
	switch (id) {
		case "continue":
			return "Continue";
		case "live":
			return "Live now";
		case "attention":
			return "Needs attention";
		case "list":
			return "Pinned";
		case "recent":
			return "Recently updated";
		case "top":
			return "Most active";
		default: {
			const agent = snapshot.agents.find(
				(candidate) => candidate.id === id.slice("agent:".length)
			);
			return agent ? `With ${agent.name}` : "With an agent";
		}
	}
}

/** True when a collection id still points at something in the snapshot. */
export function isCinemaCollection(
	snapshot: InterfaceSnapshot,
	id: CinemaCollectionId
): boolean {
	if (!id.startsWith("agent:")) {
		return true;
	}
	const agentId = id.slice("agent:".length);
	return snapshot.agents.some((agent) => agent.id === agentId);
}

/** Agents in the order of their latest thread, most recent first. */
function agentsByActivity(
	snapshot: InterfaceSnapshot,
	titles: readonly CinemaTitle[]
): InterfaceAgent[] {
	const order: string[] = [];
	for (const title of titles) {
		for (const id of title.thread.agentIds) {
			if (!order.includes(id)) {
				order.push(id);
			}
		}
	}
	const agents: InterfaceAgent[] = [];
	for (const id of order) {
		const agent = snapshot.agents.find((candidate) => candidate.id === id);
		if (agent) {
			agents.push(agent);
		}
	}
	return agents;
}

/**
 * The home page rows, top to bottom: what is waiting on you, what is live,
 * what failed, everything by recency, the most active threads, the pinned
 * list, then one row per agent. Empty rows are left out.
 */
export function cinemaRows(
	snapshot: InterfaceSnapshot,
	titles: readonly CinemaTitle[] = cinemaTitles(snapshot)
): CinemaRow[] {
	const ids: CinemaCollectionId[] = [
		"continue",
		"live",
		"attention",
		"recent",
		"top",
		"list",
	];
	for (const agent of agentsByActivity(snapshot, titles)) {
		ids.push(agentRowId(agent.id));
	}
	const rows: CinemaRow[] = [];
	for (const id of ids) {
		const items = cinemaCollection(snapshot, id, titles);
		if (items.length === 0 || (id === "top" && titles.length < TOP_MIN)) {
			continue;
		}
		rows.push({
			id,
			layout: id === "top" ? "top" : "boxart",
			title: cinemaCollectionTitle(snapshot, id),
			titles: items.slice(0, CINEMA_ROW_LIMIT),
		});
	}
	return rows;
}

/** The pages in the top navigation, after Home. */
export const CINEMA_NAV: readonly CinemaCollectionId[] = [
	"continue",
	"live",
	"attention",
	"list",
];

/** Titles whose title, latest message, agent, or group matches every word. */
export function cinemaSearch(
	titles: readonly CinemaTitle[],
	query: string
): CinemaTitle[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}
	return titles.filter((title) => {
		const haystack = [
			title.thread.title,
			title.thread.lastMessage ?? "",
			title.group?.name ?? "",
			...title.agents.map((agent) => agent.name),
		]
			.join(" ")
			.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

/**
 * "More like this" for the details modal: threads that share an agent, then
 * the same project or team, newest first.
 */
export function cinemaRelated(
	titles: readonly CinemaTitle[],
	threadId: string,
	limit: number
): CinemaTitle[] {
	const source = titles.find((title) => title.thread.id === threadId);
	if (!source) {
		return [];
	}
	const groupId = source.group?.id ?? null;
	const sharesAgent = (title: CinemaTitle) =>
		title.thread.agentIds.some((id) => source.thread.agentIds.includes(id));
	const sharesGroup = (title: CinemaTitle) =>
		groupId !== null && title.group?.id === groupId;
	const others = titles.filter((title) => title.thread.id !== threadId);
	return [
		...others.filter(sharesAgent),
		...others.filter((title) => !sharesAgent(title) && sharesGroup(title)),
	].slice(0, limit);
}

/** Poster count per row for a content width, the breakpoints the reference uses. */
export function cinemaPerRow(contentWidth: number): number {
	if (contentWidth >= 1300) {
		return 6;
	}
	if (contentWidth >= 1000) {
		return 5;
	}
	if (contentWidth >= 720) {
		return 4;
	}
	if (contentWidth >= 440) {
		return 3;
	}
	return 2;
}

/** Side gutter for a frame width, on the 4px grid. */
export function cinemaGutter(width: number): number {
	if (width >= 1100) {
		return 48;
	}
	if (width >= 640) {
		return 32;
	}
	return 16;
}

/** Space between posters in a row. */
export const CINEMA_GAP = 8;

/** One poster's width when `perRow` fill the content width. */
export function cinemaCardWidth(
	contentWidth: number,
	perRow: number,
	gap = CINEMA_GAP
): number {
	return Math.max(
		96,
		Math.floor((contentWidth - gap * (perRow - 1)) / Math.max(1, perRow))
	);
}

/**
 * How many cards share a row's width. A short row stretches its cards to
 * fill the content width instead of stopping partway across; rows of one or
 * two are laid out as feature cards instead (see `cinemaRowFeatured`).
 */
export function cinemaRowFit(count: number, perRow: number): number {
	return count >= perRow ? perRow : Math.max(1, count);
}

/** Rows this short show feature cards (art beside the latest message) on wide frames. */
export function cinemaRowFeatured(count: number, perRow: number): boolean {
	return count > 0 && count <= 2 && perRow >= 4;
}

/** Which page of a row is showing, and how many there are. */
export function cinemaPages(
	itemCount: number,
	perRow: number,
	scrollLeft: number,
	pageWidth: number
): { count: number; current: number } {
	const count = Math.max(1, Math.ceil(itemCount / Math.max(1, perRow)));
	const current =
		pageWidth > 0
			? Math.min(count - 1, Math.max(0, Math.round(scrollLeft / pageWidth)))
			: 0;
	return { count, current };
}

/** "Forge", "Forge and Brook", "Forge, Brook and Echo". */
export function cinemaNames(agents: readonly InterfaceAgent[]): string {
	const names = agents.map((agent) => agent.name);
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Who spoke last, in the user's terms. */
export function cinemaLastSpeaker(title: CinemaTitle): string {
	if (title.thread.lastMessageRole === "user") {
		return "You";
	}
	return title.agents[0]?.name ?? "Agent";
}

/** "9 messages", "1 message". */
export function cinemaMessages(count: number): string {
	return `${count} ${count === 1 ? "message" : "messages"}`;
}

/** The status line the posters and previews use, in plain words. */
export function cinemaStatusText(title: CinemaTitle): string {
	if (title.status === "attention") {
		return title.thread.runState === "interrupted"
			? "Run interrupted"
			: "Run failed";
	}
	if (title.status === "working") {
		return "Live";
	}
	if (title.status === "your-turn") {
		return "Your turn";
	}
	if (title.status === "waiting") {
		return "Waiting on agent";
	}
	return "Not started";
}

/** "Project", "Team", or nothing for a thread outside any group. */
export function cinemaGroupLabel(group: InterfaceGroup | null): string | null {
	if (!group) {
		return null;
	}
	return `${group.kind === "project" ? "Project" : "Team"} · ${group.name}`;
}

/** "Just now", "5m ago", "2d ago": the age line previews and the modal use. */
export function cinemaAge(age: string): string {
	if (!age) {
		return "";
	}
	return age === "now" ? "Just now" : `${age} ago`;
}
