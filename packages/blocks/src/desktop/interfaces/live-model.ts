import {
	ditherAvatarHue,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Live's view model, after Twitch: every agent is a channel, the thread it is
 * running (or touched last) is its stream, its other threads are its videos,
 * and teams and projects are the categories streams are filed under. Pure, so
 * the renderer and the tests read the same ordering and wording.
 */

export interface LiveCategory {
	id: string;
	kind: InterfaceGroup["kind"];
	name: string;
}

export interface LiveChannel {
	agent: InterfaceAgent;
	/** The category of the current stream, when it is filed under one. */
	category: LiveCategory | null;
	/** The running thread, else the most recent one; null for a new agent. */
	current: InterfaceThread | null;
	/** True while the agent works or any of its threads has a live run. */
	live: boolean;
	/** How many of the agent's threads have a live run right now. */
	liveCount: number;
	/** Every thread the agent is on: running first, then most recent. */
	threads: InterfaceThread[];
}

export interface LiveCategoryEntry {
	category: LiveCategory;
	/** Agents with a thread in the category, live channels first. */
	channelIds: string[];
	liveCount: number;
	/** Threads filed under the category: running first, then most recent. */
	threads: InterfaceThread[];
}

export type LiveArtKind =
	| "board"
	| "canvas"
	| "chart"
	| "code"
	| "doc"
	| "terminal";

export const LIVE_ART_KINDS: readonly LiveArtKind[] = [
	"code",
	"doc",
	"terminal",
	"chart",
	"canvas",
	"board",
];

export interface LiveArtSpec {
	/** The latest message, shown on the stream's slide. */
	excerpt: string | null;
	/** The channel's hue: the one its dither avatar is drawn in (HSL degrees). */
	hue: number;
	kind: LiveArtKind;
	/** No agent: the stage is set in greys. */
	neutral: boolean;
	/** Stable seed for the scene. */
	seed: string;
	/** Who said the latest message: "You" or the agent. */
	speaker: string;
	title: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Running threads first, then the most recent. */
export function liveThreadOrder(
	a: InterfaceThread,
	b: InterfaceThread
): number {
	return Number(b.running) - Number(a.running) || byRecency(a, b);
}

/** The team or project a thread is filed under (a project wins). */
export function liveCategoryOf(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread | null | undefined
): LiveCategory | null {
	if (!thread) {
		return null;
	}
	const groupId = thread.projectId ?? thread.teamId;
	const group = groupId
		? snapshot.groups.find((candidate) => candidate.id === groupId)
		: undefined;
	return group ? { id: group.id, kind: group.kind, name: group.name } : null;
}

/** One channel per agent: live channels first, then by latest activity. */
export function liveChannels(snapshot: InterfaceSnapshot): LiveChannel[] {
	const channels = snapshot.agents.map((agent): LiveChannel => {
		const threads = snapshot.threads
			.filter((thread) => thread.agentIds.includes(agent.id))
			.sort(liveThreadOrder);
		const liveCount = threads.filter((thread) => thread.running).length;
		const current = threads[0] ?? null;
		return {
			agent,
			category: liveCategoryOf(snapshot, current),
			current,
			live: liveCount > 0 || agent.status === "working",
			liveCount,
			threads,
		};
	});
	return channels.sort(
		(a, b) =>
			Number(b.live) - Number(a.live) ||
			(b.current?.updatedAt ?? "").localeCompare(a.current?.updatedAt ?? "") ||
			a.agent.name.localeCompare(b.agent.name)
	);
}

/** The thread a channel shows: the open one when it is the channel's, else its stream. */
export function liveFeatured(
	channel: LiveChannel,
	activeThreadId: string | null
): InterfaceThread | null {
	return (
		channel.threads.find((thread) => thread.id === activeThreadId) ??
		channel.current
	);
}

/** Threads with no agent, which no channel owns. */
export function liveUnassigned(snapshot: InterfaceSnapshot): InterfaceThread[] {
	return snapshot.threads
		.filter((thread) => thread.agentIds.length === 0)
		.sort(liveThreadOrder);
}

/** Teams and projects as categories, the busiest first. */
export function liveCategories(
	snapshot: InterfaceSnapshot,
	channels: readonly LiveChannel[]
): LiveCategoryEntry[] {
	const entries = snapshot.groups.map((group): LiveCategoryEntry => {
		const threads = snapshot.threads
			.filter((thread) => (thread.projectId ?? thread.teamId) === group.id)
			.sort(liveThreadOrder);
		const agentIds = new Set(threads.flatMap((thread) => thread.agentIds));
		const channelIds = channels
			.filter((channel) => agentIds.has(channel.agent.id))
			.map((channel) => channel.agent.id);
		return {
			category: { id: group.id, kind: group.kind, name: group.name },
			channelIds,
			liveCount: threads.filter((thread) => thread.running).length,
			threads,
		};
	});
	return entries.sort(
		(a, b) =>
			b.liveCount - a.liveCount ||
			b.threads.length - a.threads.length ||
			a.category.name.localeCompare(b.category.name)
	);
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Channels whose agent, stream title, or category mention the query. */
export function liveSearchChannels(
	channels: readonly LiveChannel[],
	query: string
): LiveChannel[] {
	const needle = normalize(query);
	if (!needle) {
		return [...channels];
	}
	return channels.filter((channel) =>
		[
			channel.agent.name,
			channel.agent.description,
			channel.current?.title ?? "",
			channel.category?.name ?? "",
		].some((field) => normalize(field).includes(needle))
	);
}

/** Categories whose name mentions the query. */
export function liveSearchCategories(
	entries: readonly LiveCategoryEntry[],
	query: string
): LiveCategoryEntry[] {
	const needle = normalize(query);
	return needle
		? entries.filter((entry) => normalize(entry.category.name).includes(needle))
		: [...entries];
}

function pad(value: number): string {
	return value.toString().padStart(2, "0");
}

/** Stream uptime the way the reference shows it: `1:04:09`. */
export function liveUptime(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "0:00:00";
	}
	const total = Math.max(0, Math.floor((now - then) / SECOND));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	return `${hours.toString()}:${pad(minutes)}:${pad(total % 60)}`;
}

function plural(count: number, unit: string): string {
	return `${count.toString()} ${unit}${count === 1 ? "" : "s"}`;
}

/** "Just now", "12 minutes ago", "Yesterday", "3 days ago". */
export function liveAgo(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const elapsed = Math.max(0, now - then);
	if (elapsed < MINUTE) {
		return "Just now";
	}
	if (elapsed < HOUR) {
		return `${plural(Math.floor(elapsed / MINUTE), "minute")} ago`;
	}
	if (elapsed < DAY) {
		return `${plural(Math.floor(elapsed / HOUR), "hour")} ago`;
	}
	const days = Math.floor(elapsed / DAY);
	if (days === 1) {
		return "Yesterday";
	}
	if (days < 30) {
		return `${plural(days, "day")} ago`;
	}
	return `${plural(Math.floor(days / 30), "month")} ago`;
}

/** "1 message", "14 messages". */
export function liveMessages(count: number): string {
	return plural(count, "message");
}

/** The tag a thread wears beside its category; none while live (the badge says it). */
export function liveStatusTag(thread: InterfaceThread): string | null {
	const status: ThreadStatus = threadStatus(thread);
	if (status === "working") {
		return null;
	}
	if (status === "attention") {
		return thread.runState === "interrupted" ? "Interrupted" : "Run failed";
	}
	return THREAD_STATUS_LABELS[status];
}

/** Who said the latest line, for the caption's speaker label. */
export function liveSpeaker(
	thread: InterfaceThread,
	agent: InterfaceAgent | null | undefined
): string {
	if (thread.lastMessageRole === "user") {
		return "You";
	}
	return agent?.name ?? "Agent";
}

/** Splits a message into caption lines of whole words, at most `limit` characters each. */
export function liveCaptionLines(text: string, limit = 64): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const next = line ? `${line} ${word}` : word;
		if (line && next.length > limit) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line) {
		lines.push(line);
	}
	return lines;
}

/** Upcoming scheduled runs for an agent, soonest first, then recent past runs. */
export function liveSchedule(
	snapshot: InterfaceSnapshot,
	agentId: string
): { past: InterfaceEvent[]; upcoming: InterfaceEvent[] } {
	const events = (snapshot.events ?? []).filter(
		(event) => event.agentId === agentId
	);
	return {
		past: events
			.filter((event) => event.kind === "past")
			.sort((a, b) => b.start.localeCompare(a.start))
			.slice(0, 5),
		upcoming: events
			.filter((event) => event.kind === "upcoming")
			.sort((a, b) => a.start.localeCompare(b.start)),
	};
}

/** FNV-1a, so a seed string always lands on the same scene. */
export function liveHash(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** A small deterministic random source (mulberry32). */
export function liveRandom(seed: string): () => number {
	let state = liveHash(seed);
	return () => {
		state = (state + 0x6d_2b_79_f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const ART_RULES: readonly [LiveArtKind, RegExp][] = [
	[
		"canvas",
		/\b(design|visual|palette|brand|logo|mockup|figma|illustrat|colou?r|typograph)/i,
	],
	[
		"chart",
		/\b(deploy|roll ?out|canary|metric|alert|on-call|latency|dashboard|traffic|gateway|monitor|benchmark)/i,
	],
	[
		"terminal",
		/\b(audit|security|lockfile|advisor|cve|dependenc|vulnerab|shell|cli|script|backup|migrat)/i,
	],
	["board", /\b(plan|roadmap|launch|sprint|kanban|milestone|backlog)/i],
	[
		"doc",
		/\b(draft|write|writing|notes|docs?|changelog|paper|research|survey|guide|post|announce|copy|summar)/i,
	],
	[
		"code",
		/\b(build|rebuild|engineer|code|api|refactor|fix|bug|stack|hero|component|test|frontend|backend)/i,
	],
];

function artKindFor(text: string): LiveArtKind | null {
	for (const [kind, pattern] of ART_RULES) {
		if (pattern.test(text)) {
			return kind;
		}
	}
	return null;
}

/**
 * What a stream shows: the segment it is in (design, ops, a terminal session,
 * planning, writing, or code, read from the title and then the agent's
 * description), the latest message, and the channel's colour.
 */
export function liveArt(
	thread: InterfaceThread | null,
	agent: InterfaceAgent | null | undefined
): LiveArtSpec {
	const seed = thread?.id ?? agent?.id ?? "live";
	const kind =
		artKindFor(thread?.title ?? "") ??
		artKindFor(agent?.description ?? "") ??
		LIVE_ART_KINDS[liveHash(seed) % LIVE_ART_KINDS.length] ??
		"code";
	return {
		excerpt: thread?.lastMessage?.trim() || null,
		hue: agent ? ditherAvatarHue(ditherAvatarSeed(agent)) : 0,
		kind,
		neutral: !agent,
		seed,
		speaker: thread ? liveSpeaker(thread, agent) : (agent?.name ?? "Agent"),
		title: thread?.title ?? `${agent?.name ?? "This channel"} is offline`,
	};
}

/** People in a stream: its agents and you. */
export function liveParticipants(thread: InterfaceThread): number {
	return thread.agentIds.length + 1;
}

/** Clamps a long title for places that cannot wrap. */
export function liveClamp(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
