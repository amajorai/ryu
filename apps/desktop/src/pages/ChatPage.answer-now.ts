import { answerNowDelayMs } from "@ryu/blocks/desktop/agent-elements/answer-now.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { answerNowChat } from "@/src/lib/api/chat.ts";
import {
	answeredPermissionParts,
	useAnsweredPermissionPrune,
	useLiveTabPublish,
} from "@/src/lib/interface-live-tab.ts";
import {
	CHAT_RETRY_STARTED_EVENT,
	CHAT_TURN_STARTED_EVENT,
} from "@/src/lib/reconnect-retry.ts";
import {
	answeredPermissionKey,
	isPermissionAnswered,
	useInterfaceDetailStore,
} from "@/src/store/useInterfaceDetailStore.ts";
import type { useChatAcpNotices } from "./ChatPage.acp-notices.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import { RESUME_POLL_MS } from "./ChatPage.helpers.ts";
import type { useChatHistoryLoading } from "./ChatPage.history-loading.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPermissionsAndLinks } from "./ChatPage.permissions-links.ts";
import type { useChatResume } from "./ChatPage.resume.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatAnswerNowInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatPermissionsAndLinks> &
	ReturnType<typeof useChatAcpNotices> &
	ReturnType<typeof useChatHistoryLoading> &
	ReturnType<typeof useChatResume>;

/** Turn recovery status and the answer-now control. */
export function useChatAnswerNow({
	convId,
	clearError,
	tryResume,
	didMountPass,
	prevIsActiveTab,
	isActiveTab,
	status,
	resumeAbort,
	resumeInFlight,
	setResumeStreaming,
	isTranscriptCurrent,
	resumeStreaming,
	draftConvId,
	activeNode,
	activePermission,
	getConversation,
	error,
	messages,
	permissionNodeUrl,
	respondToPermission,
	latestTurnControl,
	permissionRef,
	handleRespondPermission,
	chatId,
	resolvedPermissions,
	setSpentPermissions,
	setResolvedPermissions,
	convIdRef,
	chatTargetRef,
}: UseChatAnswerNowInput) {
	// Reconnect Retry starts hidden/background turns through Core. If this tab owns
	// the same conversation, attach its UI reader after the background route has had
	// a moment to publish the live stream; the normal idle probe remains the final
	// fallback if the first attempt races the stream setup.
	useEffect(() => {
		const timers = new Set<number>();
		const onRetryStarted = (event: Event) => {
			const detail =
				/* SAFETY: The CHAT_RETRY_STARTED_EVENT producer in useReconnectRetryRecovery.ts dispatches a native CustomEvent with the full conversationId/source detail; this listener reads only that native detail slot. */ (
					event as CustomEvent<{ conversationId?: unknown }>
				).detail;
			if (detail?.conversationId !== convId) {
				return;
			}
			clearError();
			const first = window.setTimeout(() => {
				void tryResume("probe");
			}, 250);
			const second = window.setTimeout(() => {
				void tryResume("probe");
			}, 1000);
			timers.add(first);
			timers.add(second);
		};
		window.addEventListener(CHAT_RETRY_STARTED_EVENT, onRetryStarted);
		return () => {
			window.removeEventListener(CHAT_RETRY_STARTED_EVENT, onRetryStarted);
			for (const timer of timers) {
				window.clearTimeout(timer);
			}
		};
	}, [clearError, convId, tryResume]);

	// Arm 1 — tab activation (and mount). The original, and the only one that
	// re-hydrates history.
	useEffect(() => {
		const isMountPass = !didMountPass.current;
		didMountPass.current = true;
		const wasActive = prevIsActiveTab.current;
		prevIsActiveTab.current = isActiveTab;
		const settled = status === "ready" || status === "error";
		if (!wasActive && isActiveTab && settled && convId) {
			void tryResume("restore", { hydrate: !isMountPass });
		}
	}, [isActiveTab, status, convId, tryResume]);

	// Tear the reader down when the CONVERSATION changes (or the tab unmounts) —
	// not on every re-run of the effects above. The old cleanup lived on the
	// activation effect and fired on any dependency-identity churn, which aborted
	// a genuinely live resumed reader mid-reply.
	useEffect(
		() => () => {
			resumeAbort.current?.abort();
			resumeInFlight.current = false;
			setResumeStreaming(false);
		},
		[convId, isTranscriptCurrent]
	);

	// The turn state everything user-facing keys off. `status` alone reports
	// "ready" through a whole resumed reply (that stream is ours, not useChat's),
	// which showed the composer as idle — no Stop, voice mode in the trailing
	// slot — and let a fresh send interleave with the running turn instead of
	// queueing behind it. Every consumer of "is a turn in flight" uses this;
	// `status` stays the raw useChat value for the stream plumbing itself.
	const effectiveStatus: typeof status =
		resumeStreaming && status === "ready" ? "streaming" : status;
	const previousRecoveryStatus = useRef(status);
	useEffect(() => {
		const started =
			status === "streaming" && previousRecoveryStatus.current !== "streaming";
		previousRecoveryStatus.current = status;
		const conversationId = convId ?? draftConvId.current;
		if (started && conversationId) {
			// Only SDK streaming confirms a fresh send/retry. Reattached readers
			// change resumeStreaming while the SDK status remains ready.
			window.dispatchEvent(
				new CustomEvent(CHAT_TURN_STARTED_EVENT, {
					detail: { conversationId, nodeUrl: activeNode.url },
				})
			);
		}
	}, [activeNode.url, convId, status]);
	const [answerNowReadyTurnId, setAnswerNowReadyTurnId] = useState<
		string | null
	>(null);
	const [answerNowPendingTurnId, setAnswerNowPendingTurnId] = useState<
		string | null
	>(null);
	const turnIsBusy =
		effectiveStatus === "streaming" || effectiveStatus === "submitted";

	// Workspace interfaces see what only this tab can: the open permission
	// prompt (answered through respondToPermission, so this card and the
	// interface's ask clear together), the exact turn start, the live step,
	// stream errors, a login lapse and the failover verdict. In memory only.
	// The agent is the thread's own, never the composer's next pick, so a
	// limit verdict for another agent can never read as this thread's reset.
	useLiveTabPublish({
		activePermission,
		agentId: (convId ? getConversation(convId)?.agentId : undefined) ?? null,
		error,
		messages,
		nodeUrl: permissionNodeUrl,
		respondToPermission,
		running: turnIsBusy,
		startedAtMs: latestTurnControl?.startedAtMs ?? null,
		threadId: convId,
	});

	// Every unresolved permission is presented in the same composer surface as
	// structured questions, while the turn that asked runs: Core's waiter goes
	// with the turn. The transcript keeps the tool row as history, while this
	// active card owns the one decision that can unblock the turn.
	const composerPermission = turnIsBusy ? activePermission : null;
	permissionRef.current = {
		permission: composerPermission,
		onRespond: handleRespondPermission,
	};

	// A later turn (or a restarted Core) can mint the same `perm-<seq>` again:
	// answers recorded for this conversation are forgotten when the turn ends.
	useAnsweredPermissionPrune({
		nodeUrl: permissionNodeUrl,
		onTurnEnd: () => {
			const answered = useInterfaceDetailStore.getState().answeredPermissions;
			const spent = answeredPermissionParts(messages, (requestId) => {
				const scope = {
					nodeUrl: permissionNodeUrl,
					requestId,
					threadId: chatId,
				};
				return (
					resolvedPermissions.has(answeredPermissionKey(scope)) ||
					isPermissionAnswered(answered, scope)
				);
			});
			if (spent.length > 0) {
				setSpentPermissions((prev) => new Set([...prev, ...spent]));
			}
			setResolvedPermissions((prev) => (prev.size === 0 ? prev : new Set()));
		},
		running: turnIsBusy,
		threadId: chatId,
	});

	// Arm one timeout for the effort-aware grace period while the native provider
	// is still in its reasoning phase. A single deadline instead of a ticking
	// clock: the whole chat page re-renders once when the button appears, not
	// four times a second for the length of the reasoning phase. Unsupported
	// routes never publish this part, so they pay no timer or render cost.
	const answerNowTurnId = latestTurnControl?.turnId;
	const answerNowStartedAtMs = latestTurnControl?.startedAtMs;
	const answerNowEffort = latestTurnControl?.effort;
	const answerNowReasoning = latestTurnControl?.phase === "reasoning";
	useEffect(() => {
		if (
			!(
				turnIsBusy &&
				answerNowReasoning &&
				answerNowTurnId &&
				answerNowStartedAtMs !== undefined
			)
		) {
			return;
		}
		const remainingMs =
			answerNowStartedAtMs + answerNowDelayMs(answerNowEffort) - Date.now();
		if (remainingMs <= 0) {
			setAnswerNowReadyTurnId(answerNowTurnId);
			return;
		}
		const timer = window.setTimeout(
			() => setAnswerNowReadyTurnId(answerNowTurnId),
			remainingMs
		);
		return () => window.clearTimeout(timer);
	}, [
		answerNowEffort,
		answerNowReasoning,
		answerNowStartedAtMs,
		answerNowTurnId,
		turnIsBusy,
	]);

	useEffect(() => {
		if (
			answerNowPendingTurnId &&
			(answerNowPendingTurnId !== latestTurnControl?.turnId || !turnIsBusy)
		) {
			setAnswerNowPendingTurnId(null);
		}
	}, [answerNowPendingTurnId, latestTurnControl?.turnId, turnIsBusy]);

	const handleAnswerNow = useCallback(async () => {
		const control = latestTurnControl;
		const conversationId = convIdRef.current ?? draftConvId.current;
		if (!(control && conversationId && turnIsBusy)) {
			return;
		}
		setAnswerNowPendingTurnId(control.turnId);
		try {
			const accepted = await answerNowChat(
				chatTargetRef.current,
				conversationId,
				control.turnId
			);
			if (!accepted) {
				throw new Error("Core did not accept the request");
			}
		} catch {
			setAnswerNowPendingTurnId(null);
			toast.error("Could not ask this turn to answer now.");
		}
	}, [latestTurnControl, turnIsBusy]);

	const answerNowControl = useMemo(() => {
		if (
			!(
				turnIsBusy &&
				latestTurnControl?.phase === "reasoning" &&
				answerNowReadyTurnId === latestTurnControl.turnId
			)
		) {
			return undefined;
		}
		return {
			onClick: handleAnswerNow,
			pending: answerNowPendingTurnId === latestTurnControl.turnId,
		};
	}, [
		answerNowPendingTurnId,
		answerNowReadyTurnId,
		handleAnswerNow,
		latestTurnControl,
		turnIsBusy,
	]);
	// Arm 2 — a stream of OURS just ended or errored. This is the case that made
	// a runaway turn unstoppable: a local SSE that drops mid-turn puts useChat
	// back at "ready"/"error" while Core keeps the turn running, and the one-shot
	// activation probe never fires again because the tab never lost focus. Edge-
	// triggered on the busy → settled transition, so dependency churn cannot turn
	// it into a loop.
	const prevSettledStatus = useRef<string>("ready");
	useEffect(() => {
		const previous = prevSettledStatus.current;
		prevSettledStatus.current = effectiveStatus;
		const wasBusy = previous === "streaming" || previous === "submitted";
		const settledNow =
			effectiveStatus === "ready" || effectiveStatus === "error";
		if (wasBusy && settledNow && convId && isActiveTab) {
			void tryResume("probe");
		}
	}, [effectiveStatus, convId, isActiveTab, tryResume]);

	// Arm 3 — a slow poll for turns this tab never started: a queued/scheduled
	// run, or the same conversation driven from another client. Only the focused
	// workspace tab of a focused WINDOW polls, and only while it believes it is
	// idle, so this is one cheap 404 every 15s for the chat the user is actually
	// looking at — not one per open tab.
	//
	// `document.hasFocus()`, not `visibilityState`: in the Tauri shell the page
	// stays "visible" while the window sits behind another app, so a visibility
	// check would poll forever for a window nobody is looking at.
	useEffect(() => {
		if (!(convId && isActiveTab) || effectiveStatus !== "ready") {
			return;
		}
		const id = window.setInterval(() => {
			if (document.hasFocus()) {
				void tryResume("probe");
			}
		}, RESUME_POLL_MS);
		return () => window.clearInterval(id);
	}, [convId, isActiveTab, effectiveStatus, tryResume]);
	return { effectiveStatus, answerNowControl } as const;
}
