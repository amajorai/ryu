import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Moments' view model, after MercuryOS: conversations gather into flows (what
 * needs you, each project or team, each agent), and flows sit on a timeline
 * under the day of their latest activity. Pure, so it is tested directly.
 */

export type MomentsFlowKind =
	| "agent"
	| "needs-you"
	| "project"
	| "team"
	| "unassigned";

/** One conversation inside a flow. */
export interface MomentsModule {
	/** Every agent on the thread, in thread order. */
	agents: InterfaceAgent[];
	/** The agent the module is shown as coming from. */
	lead: InterfaceAgent | undefined;
	status: ThreadStatus;
	thread: InterfaceThread;
}

/** What a flow's "New thread" action files the new thread under. */
export interface MomentsStartInput {
	agentId?: string;
	projectId?: string;
	teamId?: string;
}

export interface MomentsFlow {
	/** Distinct agents across the flow, most recently active first. */
	agents: InterfaceAgent[];
	id: string;
	kind: MomentsFlowKind;
	/** RFC 3339 time of the newest module. */
	latestAt: string;
	modules: MomentsModule[];
	name: string;
	start: MomentsStartInput;
}

/** A flow as the timeline shows it: the whole flow plus its stack's order. */
export interface MomentsSegment extends MomentsFlow {
	/** The flow this card opens. */
	flowId: string;
	/** The stack's cards, front first. */
	preview: MomentsModule[];
}

export interface MomentsDay {
	flows: MomentsSegment[];
	key: string;
	label: string;
}

const NEEDS_YOU = new Set<ThreadStatus>(["attention", "your-turn"]);

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function moduleFor(
	agents: Map<string, InterfaceAgent>,
	thread: InterfaceThread
): MomentsModule {
	const threadAgents: InterfaceAgent[] = [];
	for (const id of thread.agentIds) {
		const agent = agents.get(id);
		if (agent) {
			threadAgents.push(agent);
		}
	}
	return {
		agents: threadAgents,
		lead: threadAgents[0],
		status: threadStatus(thread),
		thread,
	};
}

function distinctAgents(modules: MomentsModule[]): InterfaceAgent[] {
	const seen = new Map<string, InterfaceAgent>();
	for (const item of modules) {
		for (const agent of item.agents) {
			if (!seen.has(agent.id)) {
				seen.set(agent.id, agent);
			}
		}
	}
	return [...seen.values()];
}

function makeFlow(
	input: Omit<MomentsFlow, "agents" | "latestAt">
): MomentsFlow {
	return {
		...input,
		agents: distinctAgents(input.modules),
		latestAt: input.modules[0]?.thread.updatedAt ?? "",
	};
}

/** Where a thread lives on the timeline: its project, team, or lead agent. */
function homeKey(thread: InterfaceThread): string {
	if (thread.projectId) {
		return `project:${thread.projectId}`;
	}
	if (thread.teamId) {
		return `team:${thread.teamId}`;
	}
	const lead = thread.agentIds[0];
	return lead ? `agent:${lead}` : "unassigned";
}

/**
 * Every flow, newest first. "Review what needs you" gathers failed runs and
 * replies waiting on the user (urgent first); every thread also lives in its
 * home flow: its project, else its team, else its lead agent.
 */
export function buildMomentsFlows(snapshot: InterfaceSnapshot): MomentsFlow[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
	const modules = [...snapshot.threads]
		.sort(byRecency)
		.map((thread) => moduleFor(agents, thread));

	const flows: MomentsFlow[] = [];
	const needsYou = modules
		.filter((item) => NEEDS_YOU.has(item.status))
		.sort(
			(a, b) =>
				THREAD_STATUS_ORDER.indexOf(a.status) -
					THREAD_STATUS_ORDER.indexOf(b.status) || byRecency(a.thread, b.thread)
		);
	if (needsYou.length > 0) {
		const latest = [...needsYou].sort((a, b) => byRecency(a.thread, b.thread));
		flows.push({
			...makeFlow({
				id: "needs-you",
				kind: "needs-you",
				modules: needsYou,
				name: "Review what needs you",
				start: {},
			}),
			latestAt: latest[0]?.thread.updatedAt ?? "",
		});
	}

	const homes = new Map<string, MomentsModule[]>();
	for (const item of modules) {
		const key = homeKey(item.thread);
		const list = homes.get(key);
		if (list) {
			list.push(item);
		} else {
			homes.set(key, [item]);
		}
	}
	for (const [key, list] of homes) {
		const [kind, id = ""] = key.split(":") as [string, string?];
		if (kind === "project" || kind === "team") {
			const group = groups.get(id);
			flows.push(
				makeFlow({
					id: key,
					kind,
					modules: list,
					name: group?.name ?? (kind === "project" ? "Project" : "Team"),
					start: kind === "project" ? { projectId: id } : { teamId: id },
				})
			);
		} else if (kind === "agent") {
			const agent = agents.get(id);
			flows.push(
				makeFlow({
					id: key,
					kind: "agent",
					modules: list,
					name: `Work with ${agent?.name ?? "an agent"}`,
					start: { agentId: id },
				})
			);
		} else {
			flows.push(
				makeFlow({
					id: "unassigned",
					kind: "unassigned",
					modules: list,
					name: "Unassigned threads",
					start: {},
				})
			);
		}
	}
	return flows.sort(
		(a, b) =>
			b.latestAt.localeCompare(a.latestAt) ||
			Number(b.kind === "needs-you") - Number(a.kind === "needs-you") ||
			a.id.localeCompare(b.id)
	);
}

const DAY_MS = 86_400_000;

/** "Today", "Yesterday", a weekday within the week, then "October 5". */
export function momentsDayLabel(key: string, now: number): string {
	const today = localDayKey(new Date(now));
	if (key === today) {
		return "Today";
	}
	if (key === localDayKey(new Date(now - DAY_MS))) {
		return "Yesterday";
	}
	const [year, month, day] = key.split("-").map(Number);
	const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
	if (now - date.getTime() < 6 * DAY_MS) {
		return date.toLocaleDateString("en-US", { weekday: "long" });
	}
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return date.toLocaleDateString("en-US", {
		day: "numeric",
		month: "long",
		...(sameYear ? {} : { year: "numeric" }),
	});
}

function dayKeyOf(iso: string, now: number): string {
	const at = Date.parse(iso);
	return localDayKey(new Date(Number.isNaN(at) ? now : at));
}

/**
 * The order a stack shows its modules in, front first. Cards do not front a
 * conversation another card already fronts: a flow's own single module is
 * pinned to it, and every other card picks the newest module still free, so
 * "Review what needs you" never opens on the same sheet as "Work with Cipher".
 */
function assignPreviews(cards: MomentsSegment[]) {
	const pinned = new Set<string>();
	for (const card of cards) {
		const only = card.modules.length === 1 ? card.modules[0] : undefined;
		if (only) {
			pinned.add(only.thread.id);
		}
	}
	const fronted = new Set<string>();
	for (const card of cards) {
		if (card.modules.length === 1) {
			continue;
		}
		const free = card.modules.find(
			(item) => !(pinned.has(item.thread.id) || fronted.has(item.thread.id))
		);
		if (!free) {
			continue;
		}
		fronted.add(free.thread.id);
		card.preview = [free, ...card.modules.filter((item) => item !== free)];
	}
}

/**
 * Flows under the day they last moved, newest day first; each flow appears
 * once, whole. Within a day, "Review what needs you" leads, then the rest by
 * recency.
 */
export function groupMomentsDays(
	flows: MomentsFlow[],
	now: number
): MomentsDay[] {
	const days = new Map<string, MomentsSegment[]>();
	for (const flow of flows) {
		const key = dayKeyOf(flow.latestAt, now);
		const card: MomentsSegment = {
			...flow,
			flowId: flow.id,
			preview: flow.modules,
		};
		const list = days.get(key);
		if (list) {
			list.push(card);
		} else {
			days.set(key, [card]);
		}
	}
	const grouped = [...days.entries()]
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([key, list]) => ({
			flows: [...list].sort(
				(a, b) =>
					Number(b.kind === "needs-you") - Number(a.kind === "needs-you") ||
					b.latestAt.localeCompare(a.latestAt) ||
					a.id.localeCompare(b.id)
			),
			key,
			label: momentsDayLabel(key, now),
		}));
	assignPreviews(grouped.flatMap((day) => day.flows));
	return grouped;
}

function clockTime(date: Date): string {
	return date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * The flow subtitle, as MercuryOS words it: "Updated just now" for today's
 * activity, else "Yesterday, 9:48 PM" or "Oct 5, 9:48 PM".
 */
export function momentsUpdatedLabel(iso: string, now: number): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) {
		return "";
	}
	const date = new Date(at);
	const key = localDayKey(date);
	if (key === localDayKey(new Date(now))) {
		const minutes = Math.max(0, Math.floor((now - at) / 60_000));
		if (minutes < 1) {
			return "Updated just now";
		}
		if (minutes < 60) {
			return `Updated ${minutes} min ago`;
		}
		const hours = Math.floor(minutes / 60);
		return `Updated ${hours} hr ago`;
	}
	if (key === localDayKey(new Date(now - DAY_MS))) {
		return `Yesterday, ${clockTime(date)}`;
	}
	const day = date.toLocaleDateString("en-US", {
		day: "numeric",
		month: "short",
	});
	return `${day}, ${clockTime(date)}`;
}

/** A short relative age for a module ("now", "18m", "3h", "2d"). */
export function momentsAge(iso: string, now: number): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) {
		return "";
	}
	const minutes = Math.max(0, Math.floor((now - at) / 60_000));
	if (minutes < 1) {
		return "now";
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	return `${Math.floor(hours / 24)}d`;
}

/** "Atlas", "Atlas and Brook", "Atlas, Brook, and Cipher", "Atlas, Brook, and 3 others". */
export function momentsNameList(names: string[]): string {
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	if (names.length === 2) {
		return `${names[0]} and ${names[1]}`;
	}
	if (names.length === 3) {
		return `${names[0]}, ${names[1]}, and ${names[2]}`;
	}
	return `${names[0]}, ${names[1]}, and ${names.length - 2} others`;
}

/**
 * "6 items from Atlas, Brook, and Cipher". One conversation shared by several
 * agents reads "1 item with Atlas, Echo, and Forge": they are on it together.
 */
export function momentsFlowSummary(flow: MomentsFlow): string {
	const count = flow.modules.length;
	const items = `${count} ${count === 1 ? "item" : "items"}`;
	if (flow.agents.length === 0) {
		return `${items} with no agent assigned`;
	}
	const names = momentsNameList(flow.agents.map((agent) => agent.name));
	const joiner = count === 1 && flow.agents.length > 1 ? "with" : "from";
	return `${items} ${joiner} ${names}`;
}

/**
 * The flow that shows a thread when it is opened: "Review what needs you"
 * while it waits on the user (that is where the timeline surfaces it), else
 * its home flow, among its neighbours.
 */
export function momentsFlowForThread(
	flows: MomentsFlow[],
	threadId: string | null
): MomentsFlow | undefined {
	if (!threadId) {
		return undefined;
	}
	const contains = (flow: MomentsFlow) =>
		flow.modules.some((item) => item.thread.id === threadId);
	// A thread that needs you opens where the timeline showed it first.
	return (
		flows.find((flow) => flow.kind === "needs-you" && contains(flow)) ??
		flows.find(contains)
	);
}

export type { MomentsRect } from "./moments-model-grid.ts";
export { momentsGridStep, momentsStep } from "./moments-model-grid.ts";
export type { MomentsIntent } from "./moments-model-intent.ts";
export {
	momentsMentionHandle,
	momentsMentionMatches,
	momentsMentionQuery,
	parseMomentsIntent,
} from "./moments-model-intent.ts";
