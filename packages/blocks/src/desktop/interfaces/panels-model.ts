import {
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import type { PanelsTarget } from "./panels-model-actions.ts";
import {
	activityItems,
	agentThreadFor,
	buildAgentRows,
	upcomingRuns,
	workingThreads,
} from "./panels-model-panels.ts";
import { trimSentence } from "./panels-model-threads.ts";

export type {
	PanelsAction,
	PanelsActionKind,
	PanelsTarget,
} from "./panels-model-actions.ts";
export { buildPanelsActions } from "./panels-model-actions.ts";
export type {
	PanelsActivity,
	PanelsActivityKind,
	PanelsAgentRow,
	PanelsSummary,
} from "./panels-model-panels.ts";
export {
	activityItems,
	agentThreadFor,
	buildAgentRows,
	lastRun,
	panelsSummary,
	runTarget,
	summarySentence,
	upcomingRuns,
	workingThreads,
} from "./panels-model-panels.ts";
export type { SkyPhase, SkyState } from "./panels-model-sky.ts";
export { panelsGreeting, skyAt, skyPhase } from "./panels-model-sky.ts";
export {
	byRecency,
	firstSentence,
	groupById,
	latestThreadFor,
	lowerFirst,
	recentThreads,
	threadAgents,
	threadCounterpart,
	threadExcerpt,
} from "./panels-model-threads.ts";
export {
	longDate,
	runWhen,
	runWhenParts,
	shortClock,
} from "./panels-model-time.ts";
export type { PanelsTopic } from "./panels-model-topics.ts";
export { buildTopics } from "./panels-model-topics.ts";

/** The three places Panels can show: Home, the persistent Chat, Projects. */
export type PanelsView = "chat" | "home" | "projects";

export const PANELS_VIEWS: readonly PanelsView[] = ["home", "chat", "projects"];

export const PANELS_VIEW_LABELS: Record<PanelsView, string> = {
	chat: "Chat",
	home: "Home",
	projects: "Projects",
};

export function isPanelsView(value: unknown): value is PanelsView {
	return PANELS_VIEWS.some((view) => view === value);
}

// ---------------------------------------------------------------------------
// Panel header actions: one quiet link per panel, each to a different thread
// ---------------------------------------------------------------------------

/** A panel's header link: short visible text and a full accessible name. */
export interface PanelsHeaderAction {
	label: string;
	target: PanelsTarget;
	text: string;
}

export interface PanelsHeaderActions {
	activity: PanelsHeaderAction | null;
	agents: PanelsHeaderAction | null;
	upcoming: PanelsHeaderAction | null;
	working: PanelsHeaderAction | null;
}

function needsYou(
	thread: InterfaceThread | undefined
): thread is InterfaceThread {
	if (!thread) {
		return false;
	}
	const status = threadStatus(thread);
	return status === "attention" || status === "your-turn";
}

/** "Reply in <title>", or "Retry <title>" for a failed run. */
function replyIn(thread: InterfaceThread): PanelsHeaderAction {
	const title = trimSentence(thread.title);
	const text =
		threadStatus(thread) === "attention"
			? `Retry ${title}`
			: `Reply in ${title}`;
	return { label: text, target: { kind: "open", threadId: thread.id }, text };
}

/**
 * Each panel's header link, named by the thread it opens. Working now watches
 * its newest run; the others reply where a thread is waiting on you, and no
 * two panels point at the same thread. A panel with nothing waiting on you
 * shows no link rather than a reply to an agent that is busy or idle.
 */
export function panelHeaderActions(
	snapshot: InterfaceSnapshot,
	now: number
): PanelsHeaderActions {
	const used = new Set<string>();
	const claim = (
		thread: InterfaceThread | undefined
	): PanelsHeaderAction | null => {
		if (!needsYou(thread) || used.has(thread.id)) {
			return null;
		}
		used.add(thread.id);
		return replyIn(thread);
	};
	const firstClaim = (
		threads: Iterable<InterfaceThread | undefined>
	): PanelsHeaderAction | null => {
		for (const thread of threads) {
			const action = claim(thread);
			if (action) {
				return action;
			}
		}
		return null;
	};
	const live = workingThreads(snapshot)[0];
	const working: PanelsHeaderAction | null = live
		? {
				label: `Watch ${trimSentence(live.title)}`,
				target: { kind: "open", threadId: live.id },
				text: "Watch",
			}
		: null;
	const agents = firstClaim(buildAgentRows(snapshot).map((row) => row.thread));
	const replied: InterfaceThread[] = [];
	for (const item of activityItems(snapshot, now)) {
		const target = item.target;
		if (item.kind !== "replied" || target?.kind !== "open") {
			continue;
		}
		const thread = snapshot.threads.find(
			(candidate) => candidate.id === target.threadId
		);
		if (thread) {
			replied.push(thread);
		}
	}
	const activity = firstClaim(replied);
	const upcoming = firstClaim(
		upcomingRuns(snapshot, now).map((event) =>
			event.agentId ? agentThreadFor(snapshot, event.agentId) : undefined
		)
	);
	return { activity, agents, upcoming, working };
}
