import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectContacts,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** Key of the synthetic row that holds threads nobody is assigned to. */
export const UNASSIGNED_KEY = "other:unassigned";

/**
 * One row in the Messenger contact list: an agent (from `projectContacts`),
 * a team, which reads as a group chat, or the synthetic "Unassigned" row for
 * threads no agent or team owns. Everything here is derived from the
 * snapshot; nothing is invented for display.
 */
export interface MessengerEntry {
	/** Threads whose last run failed or was interrupted. */
	attention: number;
	description: string;
	id: string;
	/** `agent:<id>`, `team:<id>`, or {@link UNASSIGNED_KEY}; unique. */
	key: string;
	kind: "agent" | "other" | "team";
	lastActivityAt: string | null;
	lastMessage: string | null;
	lastMessageRole: InterfaceThread["lastMessageRole"];
	lastThreadId: string | null;
	/** The agent itself, or the team's members, in snapshot order. */
	members: InterfaceAgent[];
	name: string;
	/** True when one of this contact's own threads is pinned; sorts first. */
	pinned: boolean;
	/** True while one of this contact's own threads has a live run. */
	running: boolean;
	/** Newest first. Team threads live only in the team's group chat. */
	threadIds: string[];
	/** Titles of `threadIds`, in the same order, for search. */
	threadTitles: string[];
	/** Threads where the agent replied last and is waiting on you. */
	unread: number;
	/** Who to name in "is typing": members in this contact's live runs. */
	working: InterfaceAgent[];
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function countStatus(
	threads: readonly InterfaceThread[],
	status: ThreadStatus
): number {
	return threads.filter((thread) => threadStatus(thread) === status).length;
}

/**
 * The members to name as typing in `threads`: those taking part in a live
 * run, preferring the ones the host reports as working. Empty when nothing
 * in `threads` is running or the run names no member; callers then say a
 * plain "typing" rather than guess who.
 */
export function typingMembers(
	members: readonly InterfaceAgent[],
	threads: readonly InterfaceThread[]
): InterfaceAgent[] {
	const live = threads.filter((thread) => thread.running);
	if (live.length === 0) {
		return [];
	}
	const inRun = members.filter((member) =>
		live.some((thread) => thread.agentIds.includes(member.id))
	);
	const busy = inRun.filter((member) => member.status === "working");
	return busy.length > 0 ? busy : inRun;
}

/** The thread-derived half of an entry, from its own threads only. */
function summarize(
	threads: readonly InterfaceThread[],
	members: readonly InterfaceAgent[]
): Pick<
	MessengerEntry,
	| "attention"
	| "lastActivityAt"
	| "lastMessage"
	| "lastMessageRole"
	| "lastThreadId"
	| "pinned"
	| "running"
	| "threadIds"
	| "threadTitles"
	| "unread"
	| "working"
> {
	const sorted = [...threads].sort(byRecency);
	const latest = sorted[0];
	return {
		attention: countStatus(sorted, "attention"),
		lastActivityAt: latest?.updatedAt ?? null,
		lastMessage: latest?.lastMessage ?? null,
		lastMessageRole: latest?.lastMessageRole ?? null,
		lastThreadId: latest?.id ?? null,
		pinned: sorted.some((thread) => thread.pinned),
		running: sorted.some((thread) => thread.running),
		threadIds: sorted.map((thread) => thread.id),
		threadTitles: sorted.map((thread) => thread.title),
		unread: countStatus(sorted, "your-turn"),
		working: typingMembers(members, sorted),
	};
}

/**
 * Agents and teams as contacts, pinned chats first, then most recent
 * conversation first. A team
 * thread belongs only to the team's group chat, never to each member's
 * direct messages; threads no contact owns collect under "Unassigned".
 */
export function projectMessengerEntries(
	snapshot: InterfaceSnapshot
): MessengerEntry[] {
	const threadsById = new Map(
		snapshot.threads.map((thread) => [thread.id, thread])
	);
	const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const teams = snapshot.groups.filter((group) => group.kind === "team");
	const teamIds = new Set(teams.map((team) => team.id));
	const covered = new Set<string>();

	const teamEntries = teams.map((group): MessengerEntry => {
		const members = group.memberAgentIds
			.map((id) => agentsById.get(id))
			.filter((agent): agent is InterfaceAgent => agent !== undefined);
		const threads = snapshot.threads.filter(
			(thread) => thread.teamId === group.id
		);
		for (const thread of threads) {
			covered.add(thread.id);
		}
		return {
			...summarize(threads, members),
			description: members.map((member) => member.name).join(", "),
			id: group.id,
			key: `team:${group.id}`,
			kind: "team",
			members,
			name: group.name,
		};
	});

	const agentEntries = projectContacts(snapshot).map(
		(contact): MessengerEntry => {
			const agent = agentsById.get(contact.agentId);
			const members = agent ? [agent] : [];
			const threads = contact.threadIds
				.map((id) => threadsById.get(id))
				.filter(
					(thread): thread is InterfaceThread =>
						thread !== undefined &&
						!(thread.teamId && teamIds.has(thread.teamId))
				);
			for (const thread of threads) {
				covered.add(thread.id);
			}
			return {
				...summarize(threads, members),
				description: agent?.description ?? "",
				id: contact.agentId,
				key: `agent:${contact.agentId}`,
				kind: "agent",
				members,
				name: contact.name,
			};
		}
	);

	const orphans = snapshot.threads.filter((thread) => !covered.has(thread.id));
	const otherEntries: MessengerEntry[] =
		orphans.length > 0
			? [
					{
						...summarize(orphans, []),
						description: "Conversations without an agent or team",
						id: "unassigned",
						key: UNASSIGNED_KEY,
						kind: "other",
						members: [],
						name: "Unassigned",
					},
				]
			: [];

	return [...agentEntries, ...teamEntries, ...otherEntries].sort(
		(a, b) =>
			Number(b.pinned) - Number(a.pinned) ||
			(b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") ||
			a.name.localeCompare(b.name)
	);
}

/**
 * Case-insensitive match on name, description, the last message, and the
 * titles of the contact's conversations.
 */
export function filterMessengerEntries(
	entries: readonly MessengerEntry[],
	query: string
): MessengerEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [...entries];
	}
	return entries.filter((entry) =>
		[
			entry.name,
			entry.description,
			entry.lastMessage ?? "",
			...entry.threadTitles,
		].some((field) => field.toLowerCase().includes(needle))
	);
}

/**
 * When `query` matches one of the contact's conversation titles but not the
 * contact itself, the newest such conversation, so the row can show why it
 * matched and open that conversation instead of the latest one.
 */
export function searchHit(
	entry: MessengerEntry,
	query: string
): { threadId: string; title: string } | null {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return null;
	}
	const direct = [entry.name, entry.description, entry.lastMessage ?? ""].some(
		(field) => field.toLowerCase().includes(needle)
	);
	if (direct) {
		return null;
	}
	const index = entry.threadTitles.findIndex((title) =>
		title.toLowerCase().includes(needle)
	);
	const threadId = entry.threadIds[index];
	const title = entry.threadTitles[index];
	return index >= 0 && threadId && title !== undefined
		? { threadId, title }
		: null;
}

/**
 * The contact a thread belongs to: the preferred entry when it holds the
 * thread, then the thread's team, then its first agent, then any entry that
 * holds it (the "Unassigned" row for orphans).
 */
export function entryForThread(
	entries: readonly MessengerEntry[],
	thread: InterfaceThread | undefined,
	preferredKey: string | null
): MessengerEntry | undefined {
	if (!thread) {
		return;
	}
	const holds = (entry: MessengerEntry | undefined) =>
		entry?.threadIds.includes(thread.id) ? entry : undefined;
	const byKey = (key: string) => entries.find((entry) => entry.key === key);
	const [firstAgent] = thread.agentIds;
	return (
		holds(preferredKey ? byKey(preferredKey) : undefined) ??
		holds(thread.teamId ? byKey(`team:${thread.teamId}`) : undefined) ??
		holds(firstAgent ? byKey(`agent:${firstAgent}`) : undefined) ??
		entries.find((entry) => entry.threadIds.includes(thread.id))
	);
}

/** "Forge is typing", "Atlas and Echo are typing", "3 members are typing". */
export function typingLabel(working: readonly InterfaceAgent[]): string {
	if (working.length === 0) {
		return "";
	}
	if (working.length === 1) {
		return `${working[0]?.name} is typing`;
	}
	if (working.length === 2) {
		return `${working[0]?.name} and ${working[1]?.name} are typing`;
	}
	return `${working.length} members are typing`;
}

/** Whether new conversations can be started with this contact. */
export function canStartWith(entry: MessengerEntry): boolean {
	return entry.kind !== "other";
}

/** Full, locale-formatted timestamp for tooltips and `<time>` titles. */
export function fullTimestamp(iso: string): string {
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) {
		return "";
	}
	return new Date(parsed).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

/**
 * Recipients for the "To:" field: names that start with the query first,
 * then names or descriptions that contain it, each group in list order.
 */
export function matchRecipients(
	entries: readonly MessengerEntry[],
	query: string
): MessengerEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [...entries];
	}
	const starts: MessengerEntry[] = [];
	const contains: MessengerEntry[] = [];
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		if (name.startsWith(needle)) {
			starts.push(entry);
		} else if (
			name.includes(needle) ||
			entry.description.toLowerCase().includes(needle)
		) {
			contains.push(entry);
		}
	}
	return [...starts, ...contains];
}
