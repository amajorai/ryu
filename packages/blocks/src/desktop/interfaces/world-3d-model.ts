import {
	askBubble,
	compareAsks,
	type InterfaceAgent,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
	type WorldEntity,
	type WorldPoint,
} from "@ryuhq/protocol/interfaces";

/**
 * View-model logic for the 3D world's chrome: which thread of an agent is
 * most urgent, what the quest tracker points at, and what an agent says
 * when the player walks up. Pure, so it is tested without a WebGL canvas.
 */

/** Statuses that ask something of the user; the tracker and plates flag them. */
const URGENT: ReadonlySet<ThreadStatus> = new Set(["attention", "your-turn"]);

/** Short status words for a conversation row, where the full label is too long. */
export const SHORT_STATUS_LABELS: Record<ThreadStatus, string> = {
	attention: "Failed",
	quiet: "Not started",
	waiting: "Waiting",
	working: "Working",
	"your-turn": "Your turn",
};

/** The short status word for one conversation; a stopped run is not a failure. */
export function shortStatusLabel(thread: InterfaceThread): string {
	const status = threadStatus(thread);
	if (status === "attention" && thread.runState === "interrupted") {
		return "Interrupted";
	}
	return SHORT_STATUS_LABELS[status];
}

/**
 * The agent a conversation is had with: the one the player is already
 * talking to when it is in the thread, else the thread's first agent.
 */
export function threadSpeaker(
	agentIds: readonly string[],
	talkingTo: string | null
): string | null {
	if (talkingTo && agentIds.includes(talkingTo)) {
		return talkingTo;
	}
	return agentIds[0] ?? null;
}

export interface AgentUrgency {
	status: ThreadStatus;
	thread: InterfaceThread;
}

function runOutcome(thread: InterfaceThread): string {
	return thread.runState === "interrupted" ? "Run interrupted" : "Run failed";
}

function rank(status: ThreadStatus): number {
	return THREAD_STATUS_ORDER.indexOf(status);
}

function newestFirst(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * Each agent's most urgent conversation (by status, then the newest), for
 * agents with at least one conversation.
 */
export function agentUrgencies(
	threads: readonly InterfaceThread[]
): Map<string, AgentUrgency> {
	const urgencies = new Map<string, AgentUrgency>();
	for (const thread of [...threads].sort(newestFirst)) {
		const status = threadStatus(thread);
		for (const agentId of thread.agentIds) {
			const current = urgencies.get(agentId);
			if (!current || rank(status) < rank(current.status)) {
				urgencies.set(agentId, { status, thread });
			}
		}
	}
	return urgencies;
}

/** Whether a status asks the user to act (a failed run or a reply). */
export function isUrgent(status: ThreadStatus | undefined): boolean {
	return status !== undefined && URGENT.has(status);
}

export interface TrackerGoal {
	/** The agent the tracker leads to, when it leads anywhere. */
	agentId: string | null;
	agentName: string | null;
	/** The ask the tracker names: activating it opens exactly that ask. */
	askId?: string;
	detail: string;
	/** The status mark beside the title, when the goal is a conversation. */
	status: ThreadStatus | null;
	/** Kept whole after the title, which truncates (an ask's wait). */
	suffix?: string;
	title: string;
}

function plural(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** The agent nearest the player, by walking distance on the grid. */
export function nearestEntity(
	entities: readonly WorldEntity[],
	player: WorldPoint
): WorldEntity | null {
	let best: WorldEntity | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const entity of entities) {
		const distance =
			Math.abs(entity.x - player.x) + Math.abs(entity.y - player.y);
		if (distance < bestDistance) {
			best = entity;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * What the quest tracker points at: the agent whose conversation most needs
 * the user (a failed run before a reply), else the nearest agent.
 */
export function trackerGoal({
	entities,
	loading,
	player,
	threads,
}: {
	entities: readonly WorldEntity[];
	loading: boolean;
	player: WorldPoint;
	threads: readonly InterfaceThread[];
}): TrackerGoal {
	if (loading) {
		return {
			agentId: null,
			agentName: null,
			detail: "",
			status: null,
			title: "Loading agents",
		};
	}
	if (entities.length === 0) {
		return {
			agentId: null,
			agentName: null,
			detail: "Agents you create get a house here",
			status: null,
			title: "No agents yet",
		};
	}
	const urgencies = agentUrgencies(threads);
	let goal: { entity: WorldEntity; urgency: AgentUrgency } | null = null;
	for (const entity of entities) {
		const urgency = urgencies.get(entity.agentId);
		if (!(urgency && isUrgent(urgency.status))) {
			continue;
		}
		const better =
			!goal ||
			rank(urgency.status) < rank(goal.urgency.status) ||
			(urgency.status === goal.urgency.status &&
				urgency.thread.updatedAt > goal.urgency.thread.updatedAt);
		if (better) {
			goal = { entity, urgency };
		}
	}
	if (goal) {
		const { entity, urgency } = goal;
		return {
			agentId: entity.agentId,
			agentName: entity.name,
			detail:
				urgency.status === "attention"
					? `${runOutcome(urgency.thread)} · ${urgency.thread.title || "Untitled"}`
					: urgency.thread.title || "Untitled",
			status: urgency.status,
			title:
				urgency.status === "attention"
					? `${entity.name} needs you`
					: `${entity.name} replied`,
		};
	}
	const working = entities.filter(
		(entity) => entity.status === "working"
	).length;
	const nearest = nearestEntity(entities, player);
	return {
		agentId: nearest?.agentId ?? null,
		agentName: nearest?.name ?? null,
		detail: `${plural(entities.length, "agent")} · ${working} working`,
		status: null,
		title: nearest ? `Talk to ${nearest.name}` : "Explore",
	};
}

/**
 * What the agent says when you walk up: the last thing it said in its
 * latest conversation, or a plain line that offers to pick that
 * conversation up (or to start one), so the band reads as dialogue.
 */
export function spokenLine(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[]
): string {
	const [latest] = threads;
	if (!latest) {
		return agent.status === "working"
			? "Working on something right now."
			: "What should we work on?";
	}
	const title = latest.title || "our last conversation";
	if (latest.running) {
		return `Working on “${title}”.`;
	}
	if (latest.lastMessage && latest.lastMessageRole === "assistant") {
		return latest.lastMessage;
	}
	return `Pick up “${title}”?`;
}

/**
 * What an agent says when the player walks up, with the act layer: the
 * step it is on, its answer's summary (a template when redacted), or a
 * template; never a message's text.
 */
export function actLine(
	act: InterfaceAgentAct,
	threads: readonly InterfaceThread[],
	privacy: "full" | "redacted"
): string {
	switch (act.act) {
		case "working":
			return privacy === "full" && act.bubble?.text
				? `${act.bubble.text}.`
				: "Working on something right now.";
		case "delivering": {
			const thread = threads.find((item) => item.id === act.threadId);
			const summary = privacy === "full" ? thread?.outcome?.summary : null;
			return summary ?? "I have an answer for you.";
		}
		case "asking":
			return "I need you to decide something.";
		case "blocked":
			return act.blockers[0]?.kind === "interrupted"
				? "My run was interrupted."
				: "My run stopped. Can you take a look?";
		case "limited":
			return "I've hit my limit for now.";
		default:
			return "What should we work on?";
	}
}

/**
 * The tracker with the act layer: the first blocking ask (in
 * `compareAsks` order), "Bo asks: Which DB to use? · ≤ 7m", leading to its
 * agent; else the summary of what is going on.
 */
export function askTrackerGoal(
	asks: readonly InterfaceAsk[],
	agents: readonly InterfaceAgent[],
	privacy: "full" | "redacted",
	waitOf: (ask: InterfaceAsk, name: string) => string,
	/** Agents with a cottage: the tracker can only walk to them. */
	placed?: ReadonlySet<string>
): TrackerGoal | null {
	const [first] = asks
		.filter(
			(ask) =>
				ask.blocking &&
				ask.agentId &&
				(placed === undefined || placed.has(ask.agentId))
		)
		.sort(compareAsks);
	const agent = first
		? agents.find((item) => item.id === first.agentId)
		: undefined;
	if (!(first && agent)) {
		return null;
	}
	const wait = waitOf(first, agent.name);
	return {
		agentId: agent.id,
		agentName: agent.name,
		askId: first.id,
		detail: "",
		status: null,
		suffix: wait.trim() || undefined,
		title: `${agent.name} asks: ${askBubble(first, privacy)}`,
	};
}
