import {
	ditherAvatarHue,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** The status chips, in the order they sit after "All". */
export const GALLERY_STATUS_FILTERS = [
	"your-turn",
	"working",
	"attention",
] as const satisfies readonly ThreadStatus[];

export type GalleryStatusFilter = (typeof GALLERY_STATUS_FILTERS)[number];

export interface GalleryFilter {
	agentId: string | null;
	query: string;
	status: GalleryStatusFilter | null;
}

export const EMPTY_GALLERY_FILTER: GalleryFilter = {
	agentId: null,
	query: "",
	status: null,
};

export function isGalleryFilterEmpty(filter: GalleryFilter): boolean {
	return (
		filter.agentId === null &&
		filter.status === null &&
		filter.query.trim() === ""
	);
}

/**
 * What a card's cover shows, chosen from the conversation itself:
 * - `quote`: the latest message as a pull quote, framed to its length;
 * - `status`: a live or failed run, with the latest output as a log line;
 * - `poster`: the project or team it belongs to, set as a title card;
 * - `stat`: how long the conversation has run, when there is nothing to quote.
 */
export type GalleryCoverKind = "poster" | "quote" | "stat" | "status";

export const GALLERY_COVER_KINDS: readonly GalleryCoverKind[] = [
	"quote",
	"status",
	"poster",
	"stat",
];

export interface GalleryCoverSpec {
	/** The lead agent's name. */
	author: string | null;
	/** Messages so far, for the stat cover. */
	count: number;
	/** The latest message, when there is one. */
	excerpt: string | null;
	/** The project or team name, for the poster. */
	group: string | null;
	/** Whether `group` is a project or a team. */
	groupKind: "project" | "team" | null;
	/** The lead agent's hue, as its dither avatar draws it (HSL degrees). */
	hue: number;
	kind: GalleryCoverKind;
	/** No agent: the cover is set in greys. */
	neutral: boolean;
	/** Height over width. */
	ratio: number;
	seed: number;
	/** Who said the quoted message: "You", or the lead agent. */
	speaker: string;
	status: ThreadStatus;
}

/** FNV-1a: a small, stable 32-bit hash of an id. */
export function hashId(id: string): number {
	let hash = 2_166_136_261;
	for (const char of id) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** The most lines of text a cover sets before it ellipsizes. */
export const GALLERY_COVER_MAX_LINES = 8;

/**
 * Text covers are framed to fit their text, so a one-line reply makes a short
 * card and a long report a tall one. Sizes are in percent of the cover width
 * (the covers set type in container units): `chars` letters fit a line,
 * `line` is the line height, and `chrome` is everything else in the frame.
 */
export const GALLERY_TEXT_FRAMES = {
	quote: { chars: 27, chrome: 44, line: 10.2 },
	status: { chars: 25, chrome: 48, line: 8.7 },
} as const;

function textRatio(
	kind: keyof typeof GALLERY_TEXT_FRAMES,
	text: string
): number {
	const frame = GALLERY_TEXT_FRAMES[kind];
	const lines = Math.min(
		GALLERY_COVER_MAX_LINES,
		Math.max(2, Math.ceil(text.length / frame.chars))
	);
	return Math.round((frame.chrome + lines * frame.line) / 5) / 20;
}

/**
 * The cover for a thread, chosen from its content: runs worth noticing get a
 * status card, the newest conversation in each project or team is set as
 * that group's poster, and the rest quote their latest message.
 */
export function galleryCover(
	thread: InterfaceThread,
	agents: readonly InterfaceAgent[] = [],
	group: Pick<InterfaceGroup, "kind" | "name"> | null = null,
	leadsGroup = false
): GalleryCoverSpec {
	const seed = hashId(thread.id);
	const status = threadStatus(thread);
	const excerpt = thread.lastMessage?.trim() || null;
	const lead = agents[0] ?? null;
	let kind: GalleryCoverKind = "stat";
	if (status === "working" || status === "attention") {
		kind = "status";
	} else if (group && (!excerpt || leadsGroup)) {
		kind = "poster";
	} else if (excerpt) {
		kind = "quote";
	}
	const ratios: Record<GalleryCoverKind, number> = {
		poster: 5 / 4,
		quote: textRatio("quote", excerpt ?? ""),
		stat: 1,
		status: textRatio("status", excerpt ?? ""),
	};
	return {
		author: lead?.name ?? null,
		count: thread.messageCount,
		excerpt,
		group: group?.name ?? null,
		groupKind: group?.kind ?? null,
		hue: lead ? ditherAvatarHue(ditherAvatarSeed(lead)) : 0,
		kind,
		neutral: lead === null,
		ratio: ratios[kind],
		seed,
		speaker:
			thread.lastMessageRole === "user" ? "You" : (lead?.name ?? "Agent"),
		status,
	};
}

export interface GalleryItem {
	agents: InterfaceAgent[];
	cover: GalleryCoverSpec;
	/** The project or team the thread is filed under, when it has one. */
	groupName: string | null;
	status: ThreadStatus;
	thread: InterfaceThread;
}

function byPinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/** Whether a thread is the first quiet one its project or team shows. */
function leadsGroup(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	groupId: string | null
): boolean {
	if (!groupId) {
		return false;
	}
	const first = snapshot.threads
		.filter((candidate) => {
			const status = threadStatus(candidate);
			return (
				(candidate.projectId ?? candidate.teamId) === groupId &&
				status !== "working" &&
				status !== "attention"
			);
		})
		.sort(byPinnedThenRecent)[0];
	return first?.id === thread.id;
}

export function galleryItem(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): GalleryItem {
	const agents: InterfaceAgent[] = [];
	for (const agentId of thread.agentIds) {
		const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
		if (agent) {
			agents.push(agent);
		}
	}
	const groupId = thread.projectId ?? thread.teamId;
	const group = groupId
		? snapshot.groups.find((candidate) => candidate.id === groupId)
		: undefined;
	return {
		agents,
		cover: galleryCover(
			thread,
			agents,
			group ?? null,
			leadsGroup(snapshot, thread, groupId)
		),
		groupName: group?.name ?? null,
		status: threadStatus(thread),
		thread,
	};
}

function matchesQuery(item: GalleryItem, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	const haystack = [
		item.thread.title,
		item.thread.lastMessage ?? "",
		item.groupName ?? "",
		...item.agents.map((agent) => agent.name),
	]
		.join("\n")
		.toLowerCase();
	return haystack.includes(needle);
}

export function matchesGalleryFilter(
	item: GalleryItem,
	filter: GalleryFilter
): boolean {
	if (filter.status !== null && item.status !== filter.status) {
		return false;
	}
	if (
		filter.agentId !== null &&
		!item.thread.agentIds.includes(filter.agentId)
	) {
		return false;
	}
	return matchesQuery(item, filter.query);
}

/** Every thread as a card, pinned first then most recent, after the filter. */
export function galleryItems(
	snapshot: InterfaceSnapshot,
	filter: GalleryFilter = EMPTY_GALLERY_FILTER
): GalleryItem[] {
	const items: GalleryItem[] = [];
	for (const thread of [...snapshot.threads].sort(byPinnedThenRecent)) {
		const item = galleryItem(snapshot, thread);
		if (matchesGalleryFilter(item, filter)) {
			items.push(item);
		}
	}
	return items;
}

/** Agents worth a chip: the ones that appear on at least one thread. */
export function galleryAgentChips(
	snapshot: InterfaceSnapshot
): InterfaceAgent[] {
	const used = new Set(snapshot.threads.flatMap((thread) => thread.agentIds));
	return snapshot.agents.filter((agent) => used.has(agent.id));
}

/** Gutter between columns and between cards, in px. */
export const GALLERY_GAP = 16;
export const GALLERY_GAP_COMPACT = 12;
/** Columns never get narrower than this on wide screens. */
export const GALLERY_MIN_COLUMN = 232;
/** Below this the grid keeps two narrow columns, like a phone pin board. */
const GALLERY_MIN_COLUMN_COMPACT = 150;
const GALLERY_MAX_COLUMNS = 7;

/** How many columns fit a content box of `width` px with `gap` gutters. */
export function galleryColumnCount(width: number, gap: number): number {
	const fit = Math.floor((width + gap) / (GALLERY_MIN_COLUMN + gap));
	if (fit >= 2) {
		return Math.min(fit, GALLERY_MAX_COLUMNS);
	}
	return width >= GALLERY_MIN_COLUMN_COMPACT * 2 + gap ? 2 : 1;
}

/** Card chrome below the cover: gap, two-line title budget and the meta row. */
const CARD_TEXT_LINE = 20;
const CARD_META = 20;
const CARD_SPACING = 10 + 6;
/** Average glyph width of the 15px title, for a line-count estimate. */
const TITLE_GLYPH = 8;

/** Rendered card height estimate, used only to balance the columns. */
export function galleryCardHeight(item: GalleryItem, width: number): number {
	const titleLines = Math.min(
		2,
		Math.max(1, Math.ceil((item.thread.title.length * TITLE_GLYPH) / width))
	);
	return (
		width * item.cover.ratio +
		CARD_SPACING +
		titleLines * CARD_TEXT_LINE +
		CARD_META
	);
}

/**
 * Masonry: drop each card, in order, into the currently shortest column so
 * the reading order stays roughly left to right, top to bottom.
 */
export function galleryColumns<T extends GalleryItem>(
	items: readonly T[],
	columnCount: number,
	columnWidth: number,
	gap: number = GALLERY_GAP
): T[][] {
	const count = Math.max(1, columnCount);
	const columns: T[][] = Array.from({ length: count }, () => []);
	const heights: number[] = Array.from({ length: count }, () => 0);
	for (const item of items) {
		let shortest = 0;
		for (let index = 1; index < count; index += 1) {
			if ((heights[index] ?? 0) < (heights[shortest] ?? 0) - 1) {
				shortest = index;
			}
		}
		columns[shortest]?.push(item);
		heights[shortest] =
			(heights[shortest] ?? 0) + galleryCardHeight(item, columnWidth) + gap;
	}
	return columns;
}

function relatedScore(open: GalleryItem, other: GalleryItem): number {
	let score = 0;
	if (other.thread.agentIds.some((id) => open.thread.agentIds.includes(id))) {
		score += 3;
	}
	if (
		open.thread.projectId &&
		other.thread.projectId === open.thread.projectId
	) {
		score += 2;
	}
	if (open.thread.teamId && other.thread.teamId === open.thread.teamId) {
		score += 2;
	}
	if (other.status === open.status) {
		score += 1;
	}
	return score;
}

/**
 * "More like this": threads sharing an agent, project or team first, then the
 * same status, then whatever is most recent, so the shelf is never empty while
 * other threads exist.
 */
export function galleryRelated(
	snapshot: InterfaceSnapshot,
	threadId: string,
	limit = 6
): GalleryItem[] {
	const all = galleryItems(snapshot);
	const open = all.find((item) => item.thread.id === threadId);
	if (!open) {
		return all.slice(0, limit);
	}
	return all
		.filter((item) => item.thread.id !== threadId)
		.map((item, order) => ({ item, order, score: relatedScore(open, item) }))
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, limit)
		.map((entry) => entry.item);
}

/** "Forge", "Atlas +2", or "No agent", for the card's byline. */
export function galleryByline(agents: readonly InterfaceAgent[]): string {
	const [first] = agents;
	if (!first) {
		return "No agent";
	}
	return agents.length > 1 ? `${first.name} +${agents.length - 1}` : first.name;
}

/** Sentence for the "nothing matches" state. */
export function galleryNoMatchText(
	filter: GalleryFilter,
	agentName: string | undefined
): string {
	const query = filter.query.trim();
	if (query) {
		return `Nothing matches “${query}”. Try another word or clear the filters.`;
	}
	if (agentName) {
		return `${agentName} has no conversations in this view.`;
	}
	return "No conversations in this view.";
}
