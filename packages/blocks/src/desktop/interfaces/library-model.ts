import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * The Library's read model. Every agent is a book, every project and team is
 * a collection, and every conversation is a chapter in each book it belongs
 * to. A chapter is "finished" once its agent has replied and nothing is
 * running or broken (`your-turn`); everything else is still open.
 */

export type LibraryBookKind = "agent" | "project" | "team" | "unassigned";

export interface LibraryChapter {
	/** Whether the agent has finished writing it (it is the user's turn). */
	finished: boolean;
	/** 1-based position in reading order (oldest activity first). */
	number: number;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export interface LibraryBook {
	/** The agent a new chapter goes to by default. */
	agentId: string | null;
	/** Who writes this book: the agent, or the collection's members. */
	authors: InterfaceAgent[];
	/** Reading order: chapter 1 is the oldest. */
	chapters: LibraryChapter[];
	/** What the book is about, in plain words. */
	description: string;
	finishedCount: number;
	groupId: string | null;
	id: string;
	kind: LibraryBookKind;
	title: string;
	/** Newest activity across its chapters, or null without chapters. */
	updatedAt: string | null;
	/** Chapters that need the user, most urgent first. */
	waiting: LibraryChapter[];
	/** True while any chapter has a live run. */
	working: boolean;
}

export type LibrarySort = "recent" | "title";
export const LIBRARY_SORTS: readonly LibrarySort[] = ["recent", "title"];
export const LIBRARY_SORT_LABELS: Record<LibrarySort, string> = {
	recent: "Recent",
	title: "Title",
};

export type LibraryView = "all" | "continue" | "finished" | "home";
export const LIBRARY_VIEW_LABELS: Record<LibraryView, string> = {
	all: "All Books",
	continue: "Continue Reading",
	finished: "Finished",
	home: "Home",
};

/** Statuses that put a book on the Continue Reading shelf. */
const WAITING_STATUSES: ReadonlySet<ThreadStatus> = new Set([
	"attention",
	"your-turn",
]);

export const UNASSIGNED_BOOK_ID = "unassigned";

export function agentBookId(agentId: string): string {
	return `agent:${agentId}`;
}

export function groupBookId(group: Pick<InterfaceGroup, "id" | "kind">) {
	return `${group.kind}:${group.id}`;
}

function byOldest(a: InterfaceThread, b: InterfaceThread): number {
	return a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}

function urgency(a: LibraryChapter, b: LibraryChapter): number {
	return (
		THREAD_STATUS_ORDER.indexOf(a.status) -
			THREAD_STATUS_ORDER.indexOf(b.status) ||
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

function toChapters(threads: InterfaceThread[]): LibraryChapter[] {
	return [...threads].sort(byOldest).map((thread, index) => {
		const status = threadStatus(thread);
		return {
			finished: status === "your-turn",
			number: index + 1,
			status,
			thread,
		};
	});
}

function makeBook(input: {
	agentId: string | null;
	authors: InterfaceAgent[];
	description: string;
	groupId: string | null;
	id: string;
	kind: LibraryBookKind;
	threads: InterfaceThread[];
	title: string;
}): LibraryBook {
	const chapters = toChapters(input.threads);
	const latest = chapters.at(-1)?.thread.updatedAt ?? null;
	return {
		agentId: input.agentId,
		authors: input.authors,
		chapters,
		description: input.description,
		finishedCount: chapters.filter((chapter) => chapter.finished).length,
		groupId: input.groupId,
		id: input.id,
		kind: input.kind,
		title: input.title,
		updatedAt: latest,
		waiting: chapters
			.filter((chapter) => WAITING_STATUSES.has(chapter.status))
			.sort(urgency),
		working: chapters.some((chapter) => chapter.status === "working"),
	};
}

function groupDescription(group: InterfaceGroup): string {
	return group.kind === "project"
		? `Every conversation filed under the ${group.name} project.`
		: `Conversations with the ${group.name} team.`;
}

/** One book per agent, in snapshot order. */
export function agentBooks(snapshot: InterfaceSnapshot): LibraryBook[] {
	return snapshot.agents.map((agent) =>
		makeBook({
			agentId: agent.id,
			authors: [agent],
			description: agent.description.trim(),
			groupId: null,
			id: agentBookId(agent.id),
			kind: "agent",
			threads: snapshot.threads.filter((thread) =>
				thread.agentIds.includes(agent.id)
			),
			title: agent.name,
		})
	);
}

/**
 * Projects and teams as collections, plus an "Unassigned" collection for
 * conversations no agent, project, or team owns (so none is unreachable).
 */
export function collectionBooks(snapshot: InterfaceSnapshot): LibraryBook[] {
	const books = snapshot.groups.map((group) => {
		const authors = group.memberAgentIds
			.map((id) => snapshot.agents.find((agent) => agent.id === id))
			.filter((agent): agent is InterfaceAgent => agent !== undefined);
		return makeBook({
			agentId: authors[0]?.id ?? null,
			authors,
			description: groupDescription(group),
			groupId: group.id,
			id: groupBookId(group),
			kind: group.kind,
			threads: snapshot.threads.filter((thread) =>
				group.kind === "project"
					? thread.projectId === group.id
					: thread.teamId === group.id
			),
			title: group.name,
		});
	});
	const loose = snapshot.threads.filter(
		(thread) =>
			thread.agentIds.length === 0 && !thread.projectId && !thread.teamId
	);
	if (loose.length > 0) {
		books.push(
			makeBook({
				agentId: null,
				authors: [],
				description: "Conversations that no agent, project, or team owns yet.",
				groupId: null,
				id: UNASSIGNED_BOOK_ID,
				kind: "unassigned",
				threads: loose,
				title: "Unassigned",
			})
		);
	}
	return books;
}

export interface LibraryShelves {
	/** Agent books, in snapshot order. */
	books: LibraryBook[];
	collections: LibraryBook[];
}

export function libraryShelves(snapshot: InterfaceSnapshot): LibraryShelves {
	return {
		books: agentBooks(snapshot),
		collections: collectionBooks(snapshot),
	};
}

export function findBook(
	shelves: LibraryShelves,
	bookId: string | null
): LibraryBook | undefined {
	if (!bookId) {
		return undefined;
	}
	return (
		shelves.books.find((book) => book.id === bookId) ??
		shelves.collections.find((book) => book.id === bookId)
	);
}

/**
 * The one book a conversation is shelved under when it is shown once: its
 * team, then its single agent, then its project, then its first agent.
 */
export function primaryBookId(thread: InterfaceThread): string {
	if (thread.teamId) {
		return groupBookId({ id: thread.teamId, kind: "team" });
	}
	const [first] = thread.agentIds;
	if (first && thread.agentIds.length === 1) {
		return agentBookId(first);
	}
	if (thread.projectId) {
		return groupBookId({ id: thread.projectId, kind: "project" });
	}
	return first ? agentBookId(first) : UNASSIGNED_BOOK_ID;
}

/** The book to read a thread in: the one in hand when it holds the thread. */
export function readingBook(
	shelves: LibraryShelves,
	contextBookId: string | null,
	threadId: string | null
): LibraryBook | undefined {
	const context = findBook(shelves, contextBookId);
	if (!threadId) {
		return context;
	}
	if (context?.chapters.some((chapter) => chapter.thread.id === threadId)) {
		return context;
	}
	for (const book of [...shelves.books, ...shelves.collections]) {
		const chapter = book.chapters.find((item) => item.thread.id === threadId);
		if (chapter && book.id === primaryBookId(chapter.thread)) {
			return book;
		}
	}
	return (
		[...shelves.books, ...shelves.collections].find((book) =>
			book.chapters.some((chapter) => chapter.thread.id === threadId)
		) ?? context
	);
}

export interface ContinueItem {
	book: LibraryBook;
	/** The chapter to resume: the most urgent one waiting on the user. */
	chapter: LibraryChapter;
	/** How many other chapters in this book wait on the user. */
	more: number;
}

/**
 * Continue Reading: one entry per book with chapters waiting on the user.
 * Each conversation counts once, under its primary book, so a team thread
 * does not repeat under every member. Failures first, then most recent.
 */
export function continueReading(shelves: LibraryShelves): ContinueItem[] {
	const items: ContinueItem[] = [];
	for (const book of [...shelves.books, ...shelves.collections]) {
		const own = book.waiting.filter(
			(chapter) => primaryBookId(chapter.thread) === book.id
		);
		const [chapter] = own;
		if (chapter) {
			items.push({ book, chapter, more: own.length - 1 });
		}
	}
	return items.sort((a, b) => urgency(a.chapter, b.chapter));
}

/** Lowercased text a search matches against. */
function haystack(book: LibraryBook): string {
	return [
		book.title,
		book.description,
		...book.authors.map((author) => author.name),
		...book.chapters.map((chapter) => chapter.thread.title),
	]
		.join("\n")
		.toLowerCase();
}

export function matchesQuery(book: LibraryBook, query: string): boolean {
	const needle = query.trim().toLowerCase();
	return needle === "" || haystack(book).includes(needle);
}

export function sortBooks(
	books: LibraryBook[],
	sort: LibrarySort
): LibraryBook[] {
	const byTitle = (a: LibraryBook, b: LibraryBook) =>
		a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
		a.id.localeCompare(b.id);
	if (sort === "title") {
		return [...books].sort(byTitle);
	}
	return [...books].sort((a, b) => {
		if (a.updatedAt && b.updatedAt) {
			return b.updatedAt.localeCompare(a.updatedAt) || byTitle(a, b);
		}
		if (a.updatedAt || b.updatedAt) {
			return a.updatedAt ? -1 : 1;
		}
		return byTitle(a, b);
	});
}

export function isFinishedBook(book: LibraryBook): boolean {
	return (
		book.chapters.length > 0 && book.finishedCount === book.chapters.length
	);
}

/** The books a sidebar view lists (Home lists every agent book). */
export function viewBooks(
	shelves: LibraryShelves,
	view: LibraryView
): LibraryBook[] {
	const all = [...shelves.books, ...shelves.collections];
	if (view === "continue") {
		const ids = new Set(continueReading(shelves).map((item) => item.book.id));
		return all.filter((book) => ids.has(book.id));
	}
	if (view === "finished") {
		return all.filter(isFinishedBook);
	}
	if (view === "all") {
		return all;
	}
	return shelves.books;
}

/** Whole-number share of finished chapters (0 without chapters). */
export function progressPercent(book: LibraryBook): number {
	if (book.chapters.length === 0) {
		return 0;
	}
	return Math.round((book.finishedCount / book.chapters.length) * 100);
}

export function chapterCountLabel(count: number): string {
	if (count === 0) {
		return "No chapters";
	}
	return count === 1 ? "1 chapter" : `${count.toString()} chapters`;
}

export function progressLabel(book: LibraryBook): string {
	if (book.chapters.length === 0) {
		return "No chapters yet";
	}
	return `${book.finishedCount.toString()} of ${book.chapters.length.toString()} chapters finished`;
}

const KIND_LABELS: Record<LibraryBookKind, string> = {
	agent: "Agent",
	project: "Project",
	team: "Team",
	unassigned: "Collection",
};

export function bookKindLabel(kind: LibraryBookKind): string {
	return KIND_LABELS[kind];
}

/** "Atlas", "Atlas and Echo", "Atlas, Echo and Forge", "+n more" past four. */
export function authorList(authors: InterfaceAgent[]): string {
	const names = authors.map((author) => author.name);
	if (names.length === 0) {
		return "No agent yet";
	}
	if (names.length === 1) {
		return names[0] ?? "";
	}
	const shown = names.length > 4 ? names.slice(0, 3) : names;
	const rest = names.length - shown.length;
	if (rest > 0) {
		return `${shown.join(", ")} and ${rest.toString()} more`;
	}
	return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`;
}

/** The chapter "Continue" or "Read" opens: the most urgent, else the newest. */
export function resumeChapter(book: LibraryBook): LibraryChapter | undefined {
	return book.waiting[0] ?? book.chapters.at(-1);
}

/** The chapters either side of `threadId` in reading order. */
export function neighbours(
	book: LibraryBook | undefined,
	threadId: string | null
): {
	current: LibraryChapter | undefined;
	next: LibraryChapter | undefined;
	previous: LibraryChapter | undefined;
} {
	const chapters = book?.chapters ?? [];
	const index = chapters.findIndex((chapter) => chapter.thread.id === threadId);
	if (index < 0) {
		return { current: undefined, next: undefined, previous: undefined };
	}
	return {
		current: chapters[index],
		next: chapters[index + 1],
		previous: chapters[index - 1],
	};
}

/** Age as words for chapter meta ("Just now", "18 min ago", "2 days ago"). */
export function readableAge(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const minutes = Math.max(0, Math.floor((now - then) / 60_000));
	if (minutes < 1) {
		return "Just now";
	}
	if (minutes < 60) {
		return `${minutes.toString()} min ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return hours === 1 ? "1 hr ago" : `${hours.toString()} hr ago`;
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return days === 1 ? "Yesterday" : `${days.toString()} days ago`;
	}
	const weeks = Math.floor(days / 7);
	return weeks === 1 ? "1 week ago" : `${weeks.toString()} weeks ago`;
}

export type { CoverLayout, CoverSpec } from "./library-model-covers.ts";
export {
	COVER_LAYOUTS,
	coverSpec,
	hashString,
} from "./library-model-covers.ts";
