// apps/desktop/src/hooks/usePullRequestAutomation.ts
//
// Background watcher for the opt-in pull request automations in Settings › Git
// ("Auto-address pull request comments", "Archive chat when pull requests
// close"). It polls the pull requests linked to recent, unarchived chats through
// the Pull Requests app and applies `planPullRequestAutomation`'s decisions.
//
// It runs while the desktop app is open, from one component mounted once per
// main window (`PullRequestAutomationWatcher`); a per-node Web Lock keeps a
// second window or tab on the same origin from polling at the same time.
// Nothing polls GitHub when both settings are off or the Pull Requests app is
// disabled.
//
// Clients on other devices keep their own state. Each automated turn lists a
// content-free key for every feedback item it carries; before sending, a
// client re-reads the chat's transcript, drops items another client already
// sent, and counts every client's automated turns against the chat's budget.
// That narrows (but cannot fully close) the window in which two clients could
// both send the same feedback.

import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { z } from "zod";
import {
	DEFAULT_GIT_SETTINGS,
	resolveGitSetting,
} from "@/src/components/gateway/developer-settings.ts";
import { sendChatBroadcastTurn } from "@/src/lib/api/chat-broadcast.ts";
import { type ApiTarget, request, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayGovernance,
	type GatewayGovernanceSnapshot,
} from "@/src/lib/api/governance.ts";
import {
	fetchPullRequestForBranch,
	type GitPullRequestStatus,
	parsePullRequestUrl,
} from "@/src/lib/api/pull-requests.ts";
import {
	applyPullRequestAutomationPlan,
	automatedTurnAllowed,
	buildPullRequestFeedbackPrompt,
	EMPTY_PULL_REQUEST_AUTOMATION_STATE,
	feedbackBatchId,
	type PullRequestAutomationMemory,
	type PullRequestAutomationSettings,
	type PullRequestAutomationState,
	type PullRequestFeedbackBatch,
	type PullRequestObservation,
	parsePullRequestAutomationState,
	planPullRequestAutomation,
	prunePullRequestAutomationState,
	rebaselinePullRequestAutomation,
	recordDisabledPullRequestAutomation,
	sentPullRequestFeedback,
	type TranscriptMessage,
	unsentFeedbackBatches,
	watchedChats,
	watchedPullRequestKey,
} from "@/src/lib/pull-request-automation.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import { recordChatBranchPullRequest } from "@/src/store/useChatPullRequestIndex.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { useActiveNode } from "./useActiveNode.ts";
import {
	LINKED_STATUS_FAILURE_INTERVAL_MS,
	linkedPullRequestFeedbackQuery,
} from "./useGitPullRequest.ts";
import { canonicalCwd } from "./useGitStatus.ts";

const POLL_INTERVAL_MS = 60_000;
/** A branch's pull request rarely changes; look it up again after this. */
const BRANCH_LOOKUP_FRESH_MS = 5 * 60_000;
/** Merged is final and closed rarely reopens, so re-read them less often. */
const MERGED_FRESH_MS = 30 * 60_000;
const CLOSED_FRESH_MS = 10 * 60_000;
const WATCHER_CACHE_MS = 60 * 60_000;
const STATE_KEY_PREFIX = "ryu:pull-request-automation:";

/** Nodes with a tick in flight in this window, across every watcher. */
const ticking = new Set<string>();

function loadState(nodeUrl: string): PullRequestAutomationState {
	try {
		const raw = localStorage.getItem(`${STATE_KEY_PREFIX}${nodeUrl}`);
		return parsePullRequestAutomationState(raw ? JSON.parse(raw) : null);
	} catch {
		return EMPTY_PULL_REQUEST_AUTOMATION_STATE;
	}
}

/** Read-modify-write against the latest stored state, so nothing written by
 * another watcher since this tick started is overwritten with a stale copy. */
function updateState(
	nodeUrl: string,
	update: (state: PullRequestAutomationState) => PullRequestAutomationState
): void {
	const current = loadState(nodeUrl);
	const next = update(current);
	if (next === current) {
		return;
	}
	try {
		localStorage.setItem(`${STATE_KEY_PREFIX}${nodeUrl}`, JSON.stringify(next));
	} catch {
		// best-effort: a lost state only re-baselines on the next poll
	}
}

/** Run `task` while holding this node's watcher lock. Another window of the
 * same app that already holds it makes this round a no-op. */
async function withNodeLock(
	nodeUrl: string,
	task: () => Promise<void>
): Promise<void> {
	if (ticking.has(nodeUrl)) {
		return;
	}
	ticking.add(nodeUrl);
	try {
		const locks =
			typeof navigator === "undefined" ? undefined : navigator.locks;
		if (!locks) {
			await task();
			return;
		}
		await locks.request(
			`${STATE_KEY_PREFIX}${nodeUrl}`,
			{ ifAvailable: true },
			async (lock) => {
				if (lock) {
					await task();
				}
			}
		);
	} finally {
		ticking.delete(nodeUrl);
	}
}

/** Whether this lookup failed within the failure back-off window (by this
 * watcher or a row icon sharing the cache entry). The watcher then treats the
 * pull request as unreadable without asking GitHub again every poll. */
function failedRecently(queryKey: readonly unknown[]): boolean {
	const state = queryClient.getQueryState(queryKey);
	return (
		state?.status === "error" &&
		Date.now() - state.errorUpdatedAt < LINKED_STATUS_FAILURE_INTERVAL_MS
	);
}

function freshMsFor(status: GitPullRequestStatus | undefined) {
	if (status === "merged") {
		return MERGED_FRESH_MS;
	}
	return status === "closed" ? CLOSED_FRESH_MS : undefined;
}

async function observeChat(
	target: ApiTarget,
	conversation: Conversation,
	memory: PullRequestAutomationMemory
): Promise<PullRequestObservation[]> {
	const observations: PullRequestObservation[] = [];
	const urls = [...(conversation.linkedPullRequests ?? [])];
	if (conversation.folderPath && conversation.branch) {
		const cwd = canonicalCwd(conversation.folderPath);
		const { branch } = conversation;
		const queryKey = [
			"pull-request-automation",
			"branch",
			cwd,
			branch,
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		];
		try {
			if (failedRecently(queryKey)) {
				throw new Error("branch lookup failed recently");
			}
			const branchPull = await queryClient.fetchQuery({
				gcTime: WATCHER_CACHE_MS,
				queryFn: ({ signal }) =>
					fetchPullRequestForBranch(target, cwd, branch, signal, "all"),
				queryKey,
				retry: false,
				staleTime: BRANCH_LOOKUP_FRESH_MS,
			});
			const branchUrl = branchPull
				? parsePullRequestUrl(branchPull.url)?.url
				: null;
			if (branchUrl) {
				recordChatBranchPullRequest(conversation.id, branchUrl);
			}
			if (branchUrl && !urls.includes(branchUrl)) {
				urls.push(branchUrl);
			}
		} catch {
			// A failed lookup is not "no pull request": record an unreadable
			// observation so this round cannot archive the chat.
			observations.push({
				feedback: [],
				pullRequest: null,
				url: `branch:${cwd}#${branch}`,
			});
		}
	}
	for (const url of urls) {
		const query = linkedPullRequestFeedbackQuery(target, url);
		const remembered =
			memory[watchedPullRequestKey(conversation.id, url)]?.status;
		const snapshot = failedRecently(query.queryKey)
			? null
			: await queryClient
					.fetchQuery({
						...query,
						gcTime: WATCHER_CACHE_MS,
						retry: false,
						staleTime: freshMsFor(remembered) ?? query.staleTime,
					})
					.catch(() => null);
		observations.push(
			snapshot ? { ...snapshot, url } : { feedback: [], pullRequest: null, url }
		);
	}
	return observations;
}

const transcriptSchema = z
	.object({
		messages: z
			.array(
				z
					.object({
						content: z.string().catch(""),
						created_at: z.number().finite().nullable().catch(null),
						role: z.string().catch(""),
					})
					.transform(
						(message): TranscriptMessage => ({
							content: message.content,
							createdAt: message.created_at,
							role: message.role,
						})
					)
			)
			.catch([]),
	})
	.catch({ messages: [] });

/**
 * Send one automated turn with the feedback the chat's transcript does not
 * already hold. The transcript is the record every client shares: items
 * another client already sent are dropped ("duplicate" when nothing is left),
 * and automated turns any client sent count against the chat's turn budget
 * ("deferred" while it is spent).
 */
async function sendFeedbackTurn(
	target: ApiTarget,
	conversationId: string,
	batches: readonly PullRequestFeedbackBatch[],
	watchInstructions: string
): Promise<"deferred" | "duplicate" | "failed" | "sent"> {
	try {
		const transcript = await request(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}`,
			undefined,
			transcriptSchema
		);
		const sent = sentPullRequestFeedback(transcript.messages);
		const unsent = unsentFeedbackBatches(batches, sent.keys);
		if (unsent.length === 0) {
			return "duplicate";
		}
		if (!automatedTurnAllowed(sent.turns, Date.now())) {
			return "deferred";
		}
		const batchId = feedbackBatchId(conversationId, unsent);
		await sendChatBroadcastTurn(target, {
			conversationId,
			text: buildPullRequestFeedbackPrompt(batchId, unsent, watchInstructions),
		});
		return "sent";
	} catch {
		return "failed";
	}
}

export function usePullRequestAutomation({
	conversations,
	pullRequestsEnabled,
}: {
	conversations: readonly Conversation[];
	pullRequestsEnabled: boolean;
}): void {
	const { url, token, userJwt } = useActiveNode();
	const target = useMemo(
		() => toTarget({ url, token, userJwt }),
		[url, token, userJwt]
	);
	// Same key as Settings › Git, so a toggle there refreshes this watcher.
	const { data: governance } = useQuery({
		enabled: pullRequestsEnabled,
		queryFn: ({ signal }) => fetchGatewayGovernance(target, signal),
		queryKey: ["gateway-governance", target.url, target.token],
		refetchInterval: 5 * 60_000,
	});
	const settings = useMemo(() => {
		const snapshot: GatewayGovernanceSnapshot = governance ?? {
			layers: [],
			schemaVersion: 1,
		};
		const value = <
			Key extends
				| "autoAddressPullRequestComments"
				| "autoArchiveClosedPullRequestChats"
				| "watchInstructions",
		>(
			key: Key
		) => resolveGitSetting(snapshot, key)?.value ?? DEFAULT_GIT_SETTINGS[key];
		return {
			autoAddress: Boolean(value("autoAddressPullRequestComments")),
			autoArchive: Boolean(value("autoArchiveClosedPullRequestChats")),
			watchInstructions: String(value("watchInstructions") ?? ""),
		};
	}, [governance]);

	const conversationsRef = useRef(conversations);
	conversationsRef.current = conversations;
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	const active =
		pullRequestsEnabled &&
		Boolean(governance) &&
		(settings.autoAddress || settings.autoArchive);

	// Remember a setting being off, so turning it back on takes a fresh
	// baseline instead of replaying what happened in between.
	useEffect(() => {
		if (!governance) {
			return;
		}
		const current: PullRequestAutomationSettings = {
			autoAddress: settings.autoAddress,
			autoArchive: settings.autoArchive,
		};
		updateState(target.url, (state) =>
			recordDisabledPullRequestAutomation(state, current)
		);
	}, [governance, settings.autoAddress, settings.autoArchive, target.url]);

	useEffect(() => {
		if (!active) {
			return;
		}
		const controller = new AbortController();
		const { signal } = controller;
		const nodeUrl = target.url;

		const enabledNow = (): PullRequestAutomationSettings => ({
			autoAddress: settingsRef.current.autoAddress,
			autoArchive: settingsRef.current.autoArchive,
		});

		const observeAndAct = async (conversation: Conversation) => {
			const observations = await observeChat(
				target,
				conversation,
				loadState(nodeUrl).pulls
			);
			// Decide on the chat as it is now, not as it was when the tick began.
			const latest =
				conversationsRef.current.find((c) => c.id === conversation.id) ??
				conversation;
			if (
				signal.aborted ||
				useConversationFlagsStore.getState().archivedIds.has(latest.id)
			) {
				return;
			}
			const { autoAddress, autoArchive } = enabledNow();
			const state = loadState(nodeUrl);
			const now = Date.now();
			const plan = planPullRequestAutomation({
				autoAddress,
				autoArchive,
				conversationId: conversation.id,
				deferAddress:
					latest.runStatus === "running" ||
					!automatedTurnAllowed(state.turns[conversation.id], now),
				memory: state.pulls,
				observations,
			});
			if (plan.address.length > 0) {
				const outcome = await sendFeedbackTurn(
					target,
					conversation.id,
					plan.address,
					settingsRef.current.watchInstructions
				);
				if (outcome === "deferred") {
					// Another client used the chat's budget; leave the feedback
					// unseen and try again on a later poll.
					return;
				}
				if (outcome === "failed") {
					// Keep the feedback unseen for a retry, and count the attempt
					// against the chat's turn budget so retries back off.
					updateState(nodeUrl, (stored) =>
						applyPullRequestAutomationPlan(stored, conversation.id, {}, now)
					);
					return;
				}
				updateState(nodeUrl, (stored) =>
					applyPullRequestAutomationPlan(
						stored,
						conversation.id,
						plan.memory,
						outcome === "sent" ? now : undefined
					)
				);
			} else {
				updateState(nodeUrl, (stored) =>
					applyPullRequestAutomationPlan(stored, conversation.id, plan.memory)
				);
			}
			const flags = useConversationFlagsStore.getState();
			if (plan.archive && !flags.archivedIds.has(conversation.id)) {
				flags.toggleArchive(conversation.id);
				toast.info(`Archived “${conversation.title}”`, {
					description: "Its pull requests were merged or closed.",
				});
			}
		};

		const tick = () =>
			withNodeLock(nodeUrl, async () => {
				if (signal.aborted) {
					return;
				}
				updateState(nodeUrl, (state) =>
					rebaselinePullRequestAutomation(state, enabledNow())
				);
				const chats = watchedChats(
					conversationsRef.current,
					useConversationFlagsStore.getState().archivedIds,
					Date.now()
				);
				for (const conversation of chats) {
					if (signal.aborted) {
						return;
					}
					await observeAndAct(conversation);
				}
				// Forget chats that no longer exist on this node. An empty list is
				// more likely still loading than every chat deleted.
				const known = new Set(conversationsRef.current.map((c) => c.id));
				if (known.size > 0) {
					updateState(nodeUrl, (state) =>
						prunePullRequestAutomationState(state, known, Date.now())
					);
				}
			});

		tick().catch(() => undefined);
		const interval = setInterval(() => {
			tick().catch(() => undefined);
		}, POLL_INTERVAL_MS);
		return () => {
			controller.abort();
			clearInterval(interval);
		};
	}, [active, target]);
}
