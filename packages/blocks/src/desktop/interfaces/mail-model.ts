import {
	activeLocale,
	dateFormatter,
	formatRelativeTime,
	translate as tr,
} from "@ryu/i18n/lite";
import {
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Mail's view model. Gmail's mental model maps onto threads directly: a
 * conversation is a mail thread, the agent is the sender, the title is the
 * subject, the latest message is the snippet, teams and projects are labels,
 * and pinned threads are starred. "Unread" is the user's turn: the agent
 * replied (or the run failed) and nothing is running.
 */

export type MailFolderId = "all" | "inbox" | "sent" | "starred" | "working";

export interface MailFolder {
	/** One line for the folder's empty state. */
	empty: string;
	id: MailFolderId;
	label: string;
}

const INBOX_FOLDER: MailFolder = {
	empty: "No conversations need your reply.",
	id: "inbox",
	label: "Inbox",
};

export const MAIL_FOLDERS: readonly MailFolder[] = [
	INBOX_FOLDER,
	{
		empty: "No starred conversations. Pin a conversation to star it.",
		id: "starred",
		label: "Starred",
	},
	{
		empty: "No agents are working right now.",
		id: "working",
		label: "Working",
	},
	{
		empty: "No conversations are waiting on an agent.",
		id: "sent",
		label: "Sent",
	},
	{ empty: "No conversations yet.", id: "all", label: "All mail" },
];

/** The list the user is looking at: a system folder or a label. */
export type MailView =
	| { id: MailFolderId; kind: "folder" }
	| { id: string; kind: "label" };

export const MAIL_INBOX_VIEW: MailView = { id: "inbox", kind: "folder" };

/** Gmail's default page size. */
export const MAIL_PAGE_SIZE = 50;

/** Your turn or a failed run: the conversations Mail shows in bold. */
export function mailIsUnread(thread: InterfaceThread): boolean {
	const status = threadStatus(thread);
	return status === "your-turn" || status === "attention";
}

export function mailFolderMatches(
	folder: MailFolderId,
	thread: InterfaceThread
): boolean {
	switch (folder) {
		case "inbox":
			return mailIsUnread(thread);
		case "starred":
			return thread.pinned;
		case "working":
			return threadStatus(thread) === "working";
		case "sent":
			return threadStatus(thread) === "waiting";
		default:
			return true;
	}
}

export function mailViewsEqual(a: MailView, b: MailView): boolean {
	return a.kind === b.kind && a.id === b.id;
}

export function findMailFolder(id: MailFolderId): MailFolder {
	return MAIL_FOLDERS.find((folder) => folder.id === id) ?? INBOX_FOLDER;
}

/** The labels Mail shows in the sidebar: teams first, then projects. */
export function mailLabels(snapshot: InterfaceSnapshot): InterfaceGroup[] {
	return [...snapshot.groups].sort(
		(a, b) =>
			Number(a.kind === "project") - Number(b.kind === "project") ||
			a.name.localeCompare(b.name)
	);
}

/** A thread's labels: its team, then its project, when they still exist. */
export function mailThreadLabels(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceGroup[] {
	const labels: InterfaceGroup[] = [];
	for (const groupId of [thread.teamId, thread.projectId]) {
		const group = groupId
			? snapshot.groups.find((item) => item.id === groupId)
			: undefined;
		if (group) {
			labels.push(group);
		}
	}
	return labels;
}

function viewMatches(view: MailView, thread: InterfaceThread): boolean {
	if (view.kind === "folder") {
		return mailFolderMatches(view.id, thread);
	}
	return thread.teamId === view.id || thread.projectId === view.id;
}

/** Gmail's search, simplified: every word must appear somewhere. */
export function mailMatchesQuery(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	query: string
): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return true;
	}
	const agentNames = thread.agentIds.map(
		(agentId) =>
			snapshot.agents.find((agent) => agent.id === agentId)?.name ?? ""
	);
	const haystack = [
		thread.title,
		thread.lastMessage ?? "",
		...agentNames,
		...mailThreadLabels(snapshot, thread).map((group) => group.name),
	]
		.join(" ")
		.toLowerCase();
	return words.every((word) => haystack.includes(word));
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** The conversations in a view, newest first, narrowed by a search. */
export function mailViewThreads(
	snapshot: InterfaceSnapshot,
	view: MailView,
	query = ""
): InterfaceThread[] {
	// A search runs across all mail, the way Gmail's search box does.
	const searching = query.trim().length > 0;
	return snapshot.threads
		.filter(
			(thread) =>
				(searching || viewMatches(view, thread)) &&
				mailMatchesQuery(snapshot, thread, query)
		)
		.sort(byRecency);
}

export type MailFolderCounts = Record<MailFolderId, number>;

export function mailFolderCounts(
	snapshot: InterfaceSnapshot
): MailFolderCounts {
	const counts: MailFolderCounts = {
		all: 0,
		inbox: 0,
		sent: 0,
		starred: 0,
		working: 0,
	};
	for (const thread of snapshot.threads) {
		for (const folder of MAIL_FOLDERS) {
			if (mailFolderMatches(folder.id, thread)) {
				counts[folder.id] += 1;
			}
		}
	}
	return counts;
}

/** Unread conversations per label id, the bold count beside a label. */
export function mailLabelUnread(
	snapshot: InterfaceSnapshot
): Map<string, number> {
	const unread = new Map<string, number>();
	for (const thread of snapshot.threads) {
		if (!mailIsUnread(thread)) {
			continue;
		}
		for (const group of mailThreadLabels(snapshot, thread)) {
			unread.set(group.id, (unread.get(group.id) ?? 0) + 1);
		}
	}
	return unread;
}

export function mailViewLabel(
	snapshot: InterfaceSnapshot,
	view: MailView
): string {
	if (view.kind === "folder") {
		return findMailFolder(view.id).label;
	}
	return (
		snapshot.groups.find((group) => group.id === view.id)?.name ?? tr("Label")
	);
}

const MAX_SENDER_NAMES = 3;

/**
 * Gmail's sender cell: the participants, "me" last when the user wrote the
 * latest message, and "To: …" in Sent where the user is the author.
 */
export function mailSenders(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	folder: MailFolderId | null
): string {
	const names = thread.agentIds
		.map(
			(agentId) => snapshot.agents.find((agent) => agent.id === agentId)?.name
		)
		.filter((name): name is string => Boolean(name));
	if (folder === "sent") {
		return names.length > 0
			? tr("To: {names}", { names: names.join(", ") })
			: tr("To: (no agent)");
	}
	if (names.length === 0) {
		return tr("me");
	}
	const shown =
		names.length > MAX_SENDER_NAMES
			? [names[0], "..", names.at(-1)]
			: [...names];
	if (thread.lastMessageRole === "user") {
		shown.push(tr("me"));
	}
	return shown.join(", ");
}

export function mailSubject(thread: InterfaceThread): string {
	return thread.title.trim() || tr("(no subject)");
}

export function mailSnippet(thread: InterfaceThread): string {
	return thread.lastMessage?.trim() || tr("No messages yet");
}

/** The system chip a row carries: only for states the user must notice. */
export interface MailStatusChip {
	label: string;
	tone: "destructive" | "success";
}

export function mailStatusChip(thread: InterfaceThread): MailStatusChip | null {
	const status: ThreadStatus = threadStatus(thread);
	if (status === "working") {
		return { label: tr("Working"), tone: "success" };
	}
	if (status === "attention") {
		return {
			label:
				thread.runState === "interrupted"
					? tr("Interrupted")
					: tr("Run failed"),
			tone: "destructive",
		};
	}
	return null;
}

/**
 * Gmail's list date: the time today, "Oct 12" this year, "10/12/25" before,
 * in the UI locale (`locale` is for tests).
 */
export function mailListDate(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const then = new Date(iso);
	if (Number.isNaN(then.getTime())) {
		return "";
	}
	const today = new Date(now);
	if (then.toDateString() === today.toDateString()) {
		return dateFormatter(locale, {
			hour: "numeric",
			minute: "2-digit",
		}).format(then);
	}
	if (then.getFullYear() === today.getFullYear()) {
		return dateFormatter(locale, { day: "numeric", month: "short" }).format(
			then
		);
	}
	return dateFormatter(locale, {
		day: "numeric",
		month: "numeric",
		year: "2-digit",
	}).format(then);
}

/**
 * Gmail's message header date: "Oct 14, 2026, 2:31 PM (18 minutes ago)",
 * in the UI locale.
 */
export function mailLongDate(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const date = dateFormatter(locale, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		year: "numeric",
	}).format(new Date(then));
	return tr("{date} ({age})", {
		age: formatRelativeTime(locale, Math.min(then, now), { now }),
		date,
	});
}

/** "1–10 of 24" for a page of the list; "0 of 0" when empty. */
export function mailPageRange(
	total: number,
	page: number,
	size: number = MAIL_PAGE_SIZE
): string {
	if (total === 0) {
		return tr("0 of 0");
	}
	const first = page * size + 1;
	const last = Math.min(total, (page + 1) * size);
	return tr("{first}–{last} of {total}", { first, last, total });
}

export function mailPageCount(
	total: number,
	size: number = MAIL_PAGE_SIZE
): number {
	return Math.max(1, Math.ceil(total / size));
}

/**
 * The prompt a composed message sends: the subject as the first line, the
 * body after a blank line. Either may be empty, not both.
 */
export function mailComposePrompt(subject: string, body: string): string {
	return [subject.trim(), body.trim()].filter(Boolean).join("\n\n");
}

export interface MailStartInput {
	agentId?: string;
	projectId?: string;
	prompt: string;
	teamId?: string;
}

/** What Send passes to `port.startThread`, or null when there is nothing. */
export function mailStartInput(
	snapshot: InterfaceSnapshot,
	draft: {
		agentId: string | null;
		body: string;
		labelId: string | null;
		subject: string;
	}
): MailStartInput | null {
	const prompt = mailComposePrompt(draft.subject, draft.body);
	if (!prompt) {
		return null;
	}
	const input: MailStartInput = { prompt };
	if (draft.agentId) {
		input.agentId = draft.agentId;
	}
	const label = draft.labelId
		? snapshot.groups.find((group) => group.id === draft.labelId)
		: undefined;
	if (label?.kind === "team") {
		input.teamId = label.id;
	} else if (label?.kind === "project") {
		input.projectId = label.id;
	}
	return input;
}

/** Agents whose name or description matches what the user typed in To. */
export function mailRecipientMatches(
	snapshot: InterfaceSnapshot,
	query: string
): InterfaceSnapshot["agents"] {
	const needle = query.trim().replace(/^@/, "").toLowerCase();
	if (!needle) {
		return snapshot.agents;
	}
	return snapshot.agents.filter(
		(agent) =>
			agent.name.toLowerCase().includes(needle) ||
			agent.description.toLowerCase().includes(needle)
	);
}

/** Gmail's list keys, mapped to a step through the list. */
export function mailCursorStep(key: string): "next" | "previous" | null {
	if (key === "j" || key === "ArrowDown") {
		return "next";
	}
	if (key === "k" || key === "ArrowUp") {
		return "previous";
	}
	return null;
}
