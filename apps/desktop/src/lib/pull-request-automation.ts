// apps/desktop/src/lib/pull-request-automation.ts
//
// Pure decisions for the two opt-in pull request automations (Settings › Git):
//
// - auto-address: when repository collaborators leave new comments, reviews,
//   or inline review comments on a chat's open pull request, start one turn in
//   that chat asking it to address them;
// - auto-archive: archive a chat once every pull request linked to it has been
//   merged or closed.
//
// Both act only on changes observed after a baseline, and turning a setting on
// takes a fresh baseline (`rebaselinePullRequestAutomation`), so enabling one
// never replays a comment backlog or archives chats whose pull requests closed
// earlier. The state is persisted by the caller so changes that happen while
// the app is closed (with the settings still on) are noticed on the next poll.
//
// Trust boundary: feedback text is written by other people on GitHub. Only
// collaborators (`OWNER`, `MEMBER`, `COLLABORATOR`) can wake a chat; bots,
// hidden comments, and the user's own comments never do. The prompt quotes the
// feedback as delimited, untrusted data and does not ask the agent to push.

import { z } from "zod";
import {
	type GitPullRequest,
	type GitPullRequestStatus,
	gitPullRequestStatus,
	type PullRequestFeedback,
} from "@/src/lib/api/pull-requests.ts";
import type { Conversation } from "@/types/chat.ts";

/** Last observed state of one pull request in one chat. */
export interface WatchedPullRequestMemory {
	/** Feedback ids already handled or present at the baseline. Absent until a
	 * feedback baseline is taken. */
	seen?: string[];
	/** Absent until a status baseline is taken. */
	status?: GitPullRequestStatus;
}

/** Keyed by {@link watchedPullRequestKey}. */
export type PullRequestAutomationMemory = Record<
	string,
	WatchedPullRequestMemory
>;

export interface PullRequestAutomationSettings {
	autoAddress: boolean;
	autoArchive: boolean;
}

/** Everything the watcher persists for one Core node. */
export interface PullRequestAutomationState {
	/** Which automations were on when the state was last written. A setting
	 * that is on now but was off here starts from a fresh baseline. */
	enabled: PullRequestAutomationSettings;
	pulls: PullRequestAutomationMemory;
	/** Start times (Unix ms) of recent automated turns, per conversation id. */
	turns: Record<string, number[]>;
}

export interface PullRequestObservation {
	feedback: PullRequestFeedback[];
	/** Null when the pull request could not be read this round. */
	pullRequest: GitPullRequest | null;
	url: string;
}

export interface PullRequestFeedbackBatch {
	feedback: PullRequestFeedback[];
	pullRequest: GitPullRequest;
}

export interface PullRequestAutomationPlan {
	/** Feedback to send to the chat in one turn; empty when nothing is due. */
	address: PullRequestFeedbackBatch[];
	archive: boolean;
	/** Entries to write back into the persisted memory. */
	memory: PullRequestAutomationMemory;
}

/** Bound on remembered feedback ids per pull request. Larger than the most
 * the feedback route returns (50 comments, 50 reviews, 50 threads × 20), so a
 * still-visible item is never forgotten and re-addressed. */
const MAX_SEEN_IDS = 2000;
/** Only chats touched recently are watched, newest first, up to this many. */
const MAX_WATCHED_CHATS = 20;
const MAX_CHAT_AGE_MS = 30 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Automated turns one chat may receive in a rolling hour. */
export const MAX_AUTOMATED_TURNS_PER_HOUR = 3;
/** Minimum gap between two automated turns in one chat, so a turn that was
 * just started is treated as in flight until Core reports it running. */
export const MIN_AUTOMATED_TURN_GAP_MS = 5 * 60_000;

/** Author associations that grant write access to the repository. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
	"COLLABORATOR",
	"MEMBER",
	"OWNER",
]);

export const EMPTY_PULL_REQUEST_AUTOMATION_STATE: PullRequestAutomationState = {
	enabled: { autoAddress: false, autoArchive: false },
	pulls: {},
	turns: {},
};

const statusSchema = z.enum(["closed", "draft", "merged", "open"]);
const stateSchema = z
	.object({
		enabled: z
			.object({
				autoAddress: z.boolean().catch(false),
				autoArchive: z.boolean().catch(false),
			})
			.catch(EMPTY_PULL_REQUEST_AUTOMATION_STATE.enabled),
		pulls: z
			.record(
				z.string(),
				z
					.object({
						seen: z.array(z.string()).optional().catch(undefined),
						status: statusSchema.optional().catch(undefined),
					})
					.catch({})
			)
			.catch({}),
		turns: z
			.record(z.string(), z.array(z.number().finite()).catch([]))
			.catch({}),
	})
	.catch(EMPTY_PULL_REQUEST_AUTOMATION_STATE);

/** Read persisted state; anything malformed starts from an empty baseline. */
export function parsePullRequestAutomationState(
	value: unknown
): PullRequestAutomationState {
	return stateSchema.parse(value);
}

export function watchedPullRequestKey(
	conversationId: string,
	url: string
): string {
	return `${conversationId}|${url}`;
}

const conversationOfKey = (key: string) => key.split("|")[0] ?? "";

const sameSettings = (
	a: PullRequestAutomationSettings,
	b: PullRequestAutomationSettings
) => a.autoAddress === b.autoAddress && a.autoArchive === b.autoArchive;

const isTerminal = (status: GitPullRequestStatus) =>
	status === "merged" || status === "closed";

/** Recent, unarchived chats with a linked pull request or a branch that may
 * own one, newest first. */
export function watchedChats(
	conversations: readonly Conversation[],
	archivedIds: ReadonlySet<string>,
	now: number
): Conversation[] {
	return conversations
		.filter(
			(conversation) =>
				!(conversation.archived || archivedIds.has(conversation.id)) &&
				now - conversation.updatedAt <= MAX_CHAT_AGE_MS &&
				(Boolean(conversation.linkedPullRequests?.length) ||
					Boolean(conversation.folderPath && conversation.branch))
		)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, MAX_WATCHED_CHATS);
}

/**
 * Take a fresh baseline for any automation that is on now but was off when
 * the state was last written: forget seen feedback when auto-address turns on
 * (so the backlog is not replayed) and last statuses when auto-archive turns
 * on (so already-closed pull requests do not archive their chats). Returns
 * `state` itself when nothing changes.
 */
export function rebaselinePullRequestAutomation(
	state: PullRequestAutomationState,
	settings: PullRequestAutomationSettings
): PullRequestAutomationState {
	const addressTurnedOn = settings.autoAddress && !state.enabled.autoAddress;
	const archiveTurnedOn = settings.autoArchive && !state.enabled.autoArchive;
	if (!(addressTurnedOn || archiveTurnedOn)) {
		return sameSettings(state.enabled, settings)
			? state
			: { ...state, enabled: { ...settings } };
	}
	const pulls: PullRequestAutomationMemory = {};
	for (const [key, entry] of Object.entries(state.pulls)) {
		pulls[key] = {
			seen: addressTurnedOn ? undefined : entry.seen,
			status: archiveTurnedOn ? undefined : entry.status,
		};
	}
	return {
		enabled: { ...settings },
		pulls,
		turns: addressTurnedOn ? {} : state.turns,
	};
}

/** Record automations that are off now, so turning one back on rebaselines.
 * Returns `state` itself when nothing changes. */
export function recordDisabledPullRequestAutomation(
	state: PullRequestAutomationState,
	settings: PullRequestAutomationSettings
): PullRequestAutomationState {
	const enabled = {
		autoAddress: state.enabled.autoAddress && settings.autoAddress,
		autoArchive: state.enabled.autoArchive && settings.autoArchive,
	};
	return sameSettings(state.enabled, enabled) ? state : { ...state, enabled };
}

/** Reviews that no longer (or do not yet) stand as feedback. */
const INACTIVE_REVIEW_STATES: ReadonlySet<string> = new Set([
	"DISMISSED",
	"PENDING",
]);

/** Whether a feedback item may start an automated turn: written by a
 * repository collaborator, not by a bot or the user's own account, not hidden
 * on GitHub, and not a dismissed or unsubmitted review. */
export function isAddressableFeedback(entry: PullRequestFeedback): boolean {
	if (entry.viewerDidAuthor || entry.isMinimized || entry.authorIsBot) {
		return false;
	}
	if (
		entry.kind === "review" &&
		INACTIVE_REVIEW_STATES.has(entry.state?.toUpperCase() ?? "")
	) {
		return false;
	}
	return TRUSTED_ASSOCIATIONS.has(entry.authorAssociation ?? "");
}

function recentTurns(turns: readonly number[] | undefined, now: number) {
	return (turns ?? []).filter((at) => at <= now && now - at < HOUR_MS);
}

/** Per-chat budget for automated turns: at most
 * {@link MAX_AUTOMATED_TURNS_PER_HOUR} per rolling hour, spaced at least
 * {@link MIN_AUTOMATED_TURN_GAP_MS} apart. */
export function automatedTurnAllowed(
	turns: readonly number[] | undefined,
	now: number
): boolean {
	const recent = recentTurns(turns, now);
	if (recent.length >= MAX_AUTOMATED_TURNS_PER_HOUR) {
		return false;
	}
	return recent.every((at) => now - at >= MIN_AUTOMATED_TURN_GAP_MS);
}

/** Keep ids still visible on GitHub at the end, so the bound drops only ids
 * that have already left the feedback window. */
function boundedSeen(
	previous: readonly string[],
	observed: readonly string[]
): string[] {
	const visible = new Set(observed);
	return [...previous.filter((id) => !visible.has(id)), ...visible].slice(
		-MAX_SEEN_IDS
	);
}

/**
 * Decide what one chat's automations should do this round.
 *
 * Only {@link isAddressableFeedback} items are addressed; everything else is
 * marked seen. While `deferAddress` is set (the chat is running or its turn
 * budget is spent), addressable items stay unseen and are retried later. A
 * pull request that could not be read blocks archiving and keeps its memory.
 */
export function planPullRequestAutomation(input: {
	autoAddress: boolean;
	autoArchive: boolean;
	conversationId: string;
	deferAddress: boolean;
	memory: PullRequestAutomationMemory;
	observations: readonly PullRequestObservation[];
}): PullRequestAutomationPlan {
	const address: PullRequestFeedbackBatch[] = [];
	const memory: PullRequestAutomationMemory = {};
	let sawOpenBefore = false;
	let allTerminal = input.observations.length > 0;

	for (const observation of input.observations) {
		const { pullRequest } = observation;
		if (!pullRequest) {
			allTerminal = false;
			continue;
		}
		const key = watchedPullRequestKey(input.conversationId, observation.url);
		const previous = input.memory[key];
		const status = gitPullRequestStatus(pullRequest);
		if (!isTerminal(status)) {
			allTerminal = false;
		}
		if (previous?.status && !isTerminal(previous.status)) {
			sawOpenBefore = true;
		}

		const previousSeen = previous?.seen;
		const seen = new Set(previousSeen ?? []);
		const addressable =
			previousSeen !== undefined && input.autoAddress && !isTerminal(status)
				? observation.feedback.filter(
						(entry) => !seen.has(entry.id) && isAddressableFeedback(entry)
					)
				: [];
		const held = new Set(
			input.deferAddress ? addressable.map((entry) => entry.id) : []
		);
		if (addressable.length > 0 && !input.deferAddress) {
			address.push({ feedback: addressable, pullRequest });
		}
		memory[key] = {
			seen: boundedSeen(
				previousSeen ?? [],
				observation.feedback
					.map((entry) => entry.id)
					.filter((id) => !held.has(id))
			),
			status,
		};
	}

	return {
		address,
		archive: input.autoArchive && allTerminal && sawOpenBefore,
		memory,
	};
}

/** Fold one chat's plan into the state; `turnAt` records a turn attempt
 * against the chat's budget. */
export function applyPullRequestAutomationPlan(
	state: PullRequestAutomationState,
	conversationId: string,
	memory: PullRequestAutomationMemory,
	turnAt?: number
): PullRequestAutomationState {
	if (turnAt === undefined) {
		return { ...state, pulls: { ...state.pulls, ...memory } };
	}
	return {
		...state,
		pulls: { ...state.pulls, ...memory },
		turns: {
			...state.turns,
			[conversationId]: [
				...recentTurns(state.turns[conversationId], turnAt),
				turnAt,
			],
		},
	};
}

/** Forget chats that no longer exist on the node and turns older than the
 * budget window. */
export function prunePullRequestAutomationState(
	state: PullRequestAutomationState,
	knownConversationIds: ReadonlySet<string>,
	now: number
): PullRequestAutomationState {
	const pulls = Object.fromEntries(
		Object.entries(state.pulls).filter(([key]) =>
			knownConversationIds.has(conversationOfKey(key))
		)
	);
	const turns: Record<string, number[]> = {};
	for (const [conversationId, times] of Object.entries(state.turns)) {
		const recent = recentTurns(times, now);
		if (knownConversationIds.has(conversationId) && recent.length > 0) {
			turns[conversationId] = recent;
		}
	}
	return { ...state, pulls, turns };
}

export {
	buildPullRequestFeedbackPrompt,
	feedbackBatchId,
	feedbackItemKey,
	type SentPullRequestFeedback,
	sentPullRequestFeedback,
	type TranscriptMessage,
	unsentFeedbackBatches,
} from "./pull-request-automation-feedback-prompt.ts";
