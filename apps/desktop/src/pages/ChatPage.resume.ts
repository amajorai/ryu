import { mergeResumedTurnMessage } from "@ryu/blocks/desktop/agent-elements/resume-merge.ts";
import type { UIMessage } from "ai";
import { useCallback, useRef, useState } from "react";
import { chatHeaders, chatStreamResumeUrl } from "@/src/lib/api/chat.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import { buildVersions } from "@/src/lib/chat-message-selectors.ts";
import {
	type ResumedTurnSnapshot,
	readResumedTurn,
	readResumeReplayHeader,
} from "@/src/lib/chat-resume-stream.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import {
	ACTIVE_TAB_STREAM_THROTTLE_MS,
	BACKGROUND_TAB_STREAM_THROTTLE_MS,
	RESUME_REATTACH_GRACE_MS,
} from "./ChatPage.helpers.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatResumeInput = ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatTransport>;

/** Reattaching to an in-flight turn after a remount or reconnect. */
export function useChatResume({
	convIdRef,
	isTranscriptCurrent,
	loadMessagesPageResult,
	olderMessagesCursorRef,
	setHasOlderMessages,
	setVersions,
	setMessages,
	clearError,
	chatTargetRef,
	isActiveTabRef,
	refresh,
}: UseChatResumeInput) {
	// Re-hydrate messages when the user switches back to this tab. If the ACP
	// agent is still running, reconnect to Core's live stream resume endpoint so
	// text deltas appear in real time. Otherwise just load persisted history.
	//
	// "error" re-hydrates alongside "ready": a turn whose stream died (Core
	// restarted, network dropped) leaves useChat parked in `error` forever, and
	// gating re-hydration on "ready" alone meant that tab NEVER refreshed again —
	// it showed the truncated thread for the rest of the session even though Core
	// had the finished turn persisted. There is no live stream to clobber in the
	// error state, so reloading is safe. (A turn stuck in "streaming" without a
	// terminal frame is still not re-hydrated — clobbering a genuinely live turn
	// would be worse.)
	//
	// Reloading history alone would leave the tab READ-ONLY: `handleComposerSubmit`
	// only sends on `status === "ready"` and otherwise parks the message in the
	// send queue, which drains on "ready" — so a chat stuck in `error` swallowed
	// every subsequent message. `clearError()` returns the Chat to "ready" once the
	// persisted thread is back on screen, which is also what drains that queue.
	//
	// Seeded `false`, not `isActiveTab`: seeding it from the live value meant the
	// mount pass counted as "was already active", so a tab that mounts on an
	// existing conversation NEVER attempted a resume. Reopening the app (or a
	// thread) while Core was mid-turn therefore showed a frozen partial reply and
	// an idle composer — no live text, no Stop — until the tab was toggled away
	// and back. A fresh chat has no `convId`, so this stays a no-op there.
	const prevIsActiveTab = useRef(false);
	const resumeAbort = useRef<AbortController | null>(null);
	// A resumed turn streams through `setMessages` below, NOT through `useChat`,
	// so its `status` stays "ready" for the whole reply — which left the composer
	// showing the idle trailing button (voice mode) with no Stop while text was
	// visibly arriving. Track the resumed stream explicitly and fold it into the
	// status handed to the chat surface so Stop appears for it too.
	const [resumeStreaming, setResumeStreaming] = useState(false);
	// True until this effect has taken its branch once. The mount pass must NOT
	// re-hydrate: the effect above already owns mount hydration, and its mapping
	// is the richer one (prefers structured `parts`, marks #404 stale-running
	// turns "⚠️ Interrupted", seeds `messageSentAtRef` with the server stamps).
	// Two hydrations racing on the same tab would let the lossy one win at random,
	// so on mount we read history only to seed the resume reader.
	// Keyed off the first effect INVOCATION, not the first time the branch is
	// taken: a tab that mounts on a fresh chat (no `convId`) skips the branch, so
	// a "first branch entry" flag would still read as the mount pass on a later
	// re-activation and skip the `clearError()` that un-sticks an error-parked
	// thread. Mount is the only pass that races the hydrator.
	const didMountPass = useRef(false);
	// True while a resume attempt (probe or attached reader) is outstanding. The
	// probe is now armed from three places instead of one, and without this guard
	// two of them can attach two readers to the same turn — which duplicates every
	// delta and leaves an orphaned reader running.
	const resumeInFlight = useRef(false);
	// Epoch ms until which resume probing is suppressed (set by an explicit Stop).
	const resumeSuppressedUntil = useRef(0);

	/**
	 * Probe `/api/chat/stream/resume/:id` and, if Core says a turn IS running,
	 * attach to it — which is what makes `effectiveStatus` (and therefore the
	 * composer's Stop button) report the truth.
	 *
	 * The 404-when-idle contract is what makes this safe to arm repeatedly: the
	 * server side is one in-memory registry lookup, so a probe against an idle
	 * conversation costs nothing. It is deliberately NOT derived from the
	 * conversation's persisted `run_status` — Core never reconciles that field at
	 * boot, so a crashed turn would leave the composer permanently showing Stop.
	 *
	 * `restore` also re-loads persisted history first (the tab-activation path,
	 * which must repaint the thread and `clearError()` whether or not a turn is
	 * live). `probe` touches nothing unless the probe actually attaches.
	 */
	const tryResume = useCallback(
		// one SSE reader, kept whole
		async (mode: "restore" | "probe", options?: { hydrate?: boolean }) => {
			const conv = convIdRef.current;
			if (!(conv && isTranscriptCurrent()) || resumeInFlight.current) {
				return;
			}
			// An explicit Stop cancels the turn server-side, but Core takes a moment
			// to tear the live stream down. Without this window the poll below would
			// re-attach to the dying turn and flash Stop back on immediately after
			// the user pressed it.
			if (Date.now() < resumeSuppressedUntil.current) {
				return;
			}
			resumeInFlight.current = true;
			const controller = new AbortController();
			resumeAbort.current = controller;
			const hydrate = options?.hydrate ?? false;
			let attached = false;
			try {
				let history: Awaited<
					ReturnType<typeof loadMessagesPageResult>
				>["messages"] = [];
				if (mode === "restore") {
					const page = await loadMessagesPageResult(conv);
					history = page.messages;
					if (controller.signal.aborted || !isTranscriptCurrent()) {
						return;
					}
					if (page.status === "ok" && hydrate) {
						const nextCursor = page.olderMessagesCursor ?? null;
						olderMessagesCursorRef.current = nextCursor;
						setHasOlderMessages(
							page.hasOlderMessages === true && nextCursor !== null
						);
					}
					if (history.length > 0 && hydrate) {
						setVersions(buildVersions(history));
						// The SAME mapper the mount pass uses. These two used to
						// disagree: this one mapped bare parts and dropped the
						// interruption marker, so a turn that was cut off came back
						// looking finished every time the tab was reopened.
						const now = Date.now();
						setMessages(history.map((m) => hydrateHistoryMessage(m, now)));
					}
					// Persisted state is on screen — take the chat out of `error` so the
					// composer (and any queued messages) work again. No-op when ready.
					if (hydrate) {
						clearError();
					}
				}

				// Try to reconnect to the running turn's live stream.
				const resumeUrl = chatStreamResumeUrl(chatTargetRef.current, conv);
				const headers = chatHeaders(chatTargetRef.current);
				const resp = await fetch(resumeUrl, {
					headers,
					signal: controller.signal,
				});
				if (
					controller.signal.aborted ||
					!isTranscriptCurrent() ||
					!(resp.ok && resp.body)
				) {
					return; // 404 = no running turn
				}
				// A live turn IS attached — the composer must show Stop.
				attached = true;
				setResumeStreaming(true);
				if (mode === "probe") {
					// Only now is the history worth fetching: a bare probe must not cost
					// a conversation read on every tick.
					const page = await loadMessagesPageResult(conv);
					history = page.messages;
					if (controller.signal.aborted || !isTranscriptCurrent()) {
						return;
					}
				}
				// Core replays the running turn from its first chunk, so the reply
				// belongs to the in-progress assistant row when one is already
				// persisted (the newest message), otherwise to a new message after
				// the user's turn — never to the PREVIOUS turn's assistant reply.
				const newest = history.at(-1);
				const continued = newest?.role === "assistant" ? newest : undefined;
				const targetMsgId = continued?.id ?? `resume-${Date.now()}`;
				// Core states whether the replay is the whole turn; see readResumedTurn.
				const replay = readResumeReplayHeader(resp.headers);
				// The reader yields a fresh message snapshot per chunk. Rendering each
				// one re-renders the whole transcript per token, so coalesce them to
				// the same window `useChat` throttles the live turn to.
				let pending: ResumedTurnSnapshot | null = null;
				let flushTimer: number | undefined;
				// The row as it was before this reader touched it. Every snapshot is
				// the whole resumed message so far, so it is merged into this base —
				// merging into the already-merged row would append a partial
				// replay's parts again on every flush.
				let baseRow: UIMessage | undefined;
				const flushResumed = () => {
					flushTimer = undefined;
					const snapshot = pending;
					pending = null;
					if (
						!snapshot ||
						controller.signal.aborted ||
						!isTranscriptCurrent()
					) {
						return;
					}
					const { message: resumed, replayed } = snapshot;
					setMessages((prev) => {
						const idx = prev.findIndex((m) => m.id === targetMsgId);
						if (idx !== -1) {
							const next = prev.slice();
							baseRow ??= next[idx];
							// The whole-message form keeps the row's id and server
							// metadata and clears `_interrupted`, which a live
							// reattach disproves — see mergeResumedTurnMessage.
							next[idx] = mergeResumedTurnMessage(
								baseRow,
								resumed.parts,
								replayed
							);
							return next;
						}
						return [
							...prev,
							{ id: targetMsgId, parts: resumed.parts, role: "assistant" },
						];
					});
				};
				try {
					for await (const snapshot of readResumedTurn(resp.body, {
						replay,
					})) {
						if (controller.signal.aborted || !isTranscriptCurrent()) {
							break;
						}
						pending = snapshot;
						flushTimer ??= window.setTimeout(
							flushResumed,
							isActiveTabRef.current
								? ACTIVE_TAB_STREAM_THROTTLE_MS
								: BACKGROUND_TAB_STREAM_THROTTLE_MS
						);
					}
				} finally {
					if (flushTimer !== undefined) {
						window.clearTimeout(flushTimer);
						flushResumed();
					}
				}
				// Stream ended — re-fetch the final persisted state.
				if (!controller.signal.aborted && isTranscriptCurrent()) {
					const finalPage = await loadMessagesPageResult(conv);
					if (controller.signal.aborted || !isTranscriptCurrent()) {
						return;
					}
					if (finalPage.status === "ok" && finalPage.messages.length > 0) {
						const nextCursor = finalPage.olderMessagesCursor ?? null;
						olderMessagesCursorRef.current = nextCursor;
						setHasOlderMessages(
							finalPage.hasOlderMessages === true && nextCursor !== null
						);
						const now = Date.now();
						setMessages(
							finalPage.messages.map((m) => hydrateHistoryMessage(m, now))
						);
					}
					refresh();
				}
			} catch {
				// Resume failed (no live turn / network error) — persisted history is
				// already loaded above, nothing more to do.
			} finally {
				if (isTranscriptCurrent()) {
					resumeInFlight.current = false;
					setResumeStreaming(false);
					if (attached) {
						// Detaching flips `effectiveStatus` back to "ready", which re-arms
						// arm 2. Bound that cycle: if Core ever hands back a stream that
						// closes immediately, this makes it a slow retry rather than a
						// request storm.
						resumeSuppressedUntil.current =
							Date.now() + RESUME_REATTACH_GRACE_MS;
					}
				}
			}
		},
		[
			isTranscriptCurrent,
			loadMessagesPageResult,
			setMessages,
			refresh,
			clearError,
		]
	);
	return {
		prevIsActiveTab,
		resumeAbort,
		resumeStreaming,
		setResumeStreaming,
		didMountPass,
		resumeInFlight,
		resumeSuppressedUntil,
		tryResume,
	} as const;
}
