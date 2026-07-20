// The expanded-island mini chat wrapper. The presentational body lives in
// @ryu/blocks/island (`IslandChatView`); this file owns the chat state via
// useIslandChat, the Core reachability probe, the store prefill, and reports both
// whether there is history (so the island grows from a compact composer bar to the
// full panel) and the composer's height (so the compact bar tracks the draft).

import { IslandChatView } from "@ryu/blocks/island/chat/island-chat";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIslandComposerContext } from "../../context/island-composer-context.tsx";
import { useIslandState } from "../../store/island-state.ts";
import { useIslandChat } from "./use-island-chat.ts";

type Reachability = "checking" | "offline" | "online";

export function IslandChat() {
	const { leftActions, getAcpPayload } = useIslandComposerContext();
	// Session-scoped double-check toggle. Read via a getter so useIslandChat's
	// `send` callback never closes over a stale value.
	const [doubleCheck, setDoubleCheck] = useState(false);
	const doubleCheckRef = useRef(doubleCheck);
	doubleCheckRef.current = doubleCheck;
	const { messages, sending, error, notes, send, stop, clearNotes } =
		useIslandChat({
			getAcpPayload,
			getDoubleCheck: () => doubleCheckRef.current,
		});
	const chatPrefill = useIslandState((store) => store.chatPrefill);
	const clearChatPrefill = useIslandState((store) => store.clearChatPrefill);
	const setExpandedTall = useIslandState((store) => store.setExpandedTall);
	const setComposerHeight = useIslandState((store) => store.setComposerHeight);
	const pendingAttachments = useIslandState(
		(store) => store.pendingAttachments
	);
	const removeAttachment = useIslandState((store) => store.removeAttachment);
	const clearAttachments = useIslandState((store) => store.clearAttachments);
	const [reachability, setReachability] = useState<Reachability>("checking");

	// The island is a short composer bar until a conversation exists, then it grows
	// to the full panel height.
	const hasHistory = messages.length > 0;
	useEffect(() => {
		setExpandedTall(hasHistory);
	}, [hasHistory, setExpandedTall]);

	const probe = useCallback(async (): Promise<void> => {
		setReachability("checking");
		const result = await window.island.core.health();
		setReachability(result.available ? "online" : "offline");
	}, []);

	useEffect(() => {
		probe().catch(() => setReachability("offline"));
	}, [probe]);

	const offline = reachability === "offline";

	// Action pills (double-check, and future plugin composer actions) live in their
	// own strip BELOW the composer, not crammed at its left edge — so they stay
	// visible and tappable. The composer's left edge keeps only the agent/model
	// picker (`leftActions`).
	const belowInputActions = (
		<button
			aria-pressed={doubleCheck}
			className={`shrink-0 rounded-full border px-2.5 py-1 font-medium text-[11px] transition-colors ${
				doubleCheck
					? "border-indigo-400/40 bg-indigo-500/20 text-indigo-200"
					: "border-white/10 text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
			}`}
			onClick={() => setDoubleCheck((prev) => !prev)}
			title="Have Ryu review each answer before replying"
			type="button"
		>
			Double-check
		</button>
	);

	return (
		<div className="flex h-full w-full flex-col gap-2">
			{notes.length > 0 ? (
				<div className="relative z-20 shrink-0 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1.5">
					<div className="flex items-start justify-between gap-2">
						<span className="font-semibold text-[10px] text-amber-300/90 uppercase tracking-wide">
							Note
						</span>
						<button
							aria-label="Dismiss notes"
							className="shrink-0 text-amber-200/70 hover:text-amber-100"
							onClick={clearNotes}
							type="button"
						>
							<svg
								aria-hidden="true"
								fill="none"
								height="10"
								stroke="currentColor"
								strokeLinecap="round"
								strokeWidth="2"
								viewBox="0 0 24 24"
								width="10"
							>
								<path d="M18 6 6 18M6 6l12 12" />
							</svg>
						</button>
					</div>
					{notes.map((note, index) => (
						<p
							className="mt-0.5 text-amber-100/90 text-xs leading-snug"
							// biome-ignore lint/suspicious/noArrayIndexKey: notes are append-only, ephemeral, and never reordered
							key={index}
						>
							{note}
						</p>
					))}
				</div>
			) : null}
			<div className="min-h-0 flex-1">
				<IslandChatView
					attachments={pendingAttachments.map((a) => ({
						id: a.path,
						name: a.name,
						dataUrl: a.dataUrl,
					}))}
					belowInputActions={belowInputActions}
					error={error}
					leftActions={leftActions}
					messages={messages}
					offline={offline}
					onComposerResize={setComposerHeight}
					onPrefillConsumed={clearChatPrefill}
					onRemoveAttachment={removeAttachment}
					onRetry={probe}
					onSend={(text, options) => {
						// Send the current draft with whatever images are staged, then clear
						// them (the array was already handed to send by reference).
						const attachments = useIslandState.getState().pendingAttachments;
						Promise.resolve(send(text, { ...options, attachments })).catch(
							() => undefined
						);
						clearAttachments();
					}}
					onStop={stop}
					prefill={chatPrefill}
					sending={sending}
				/>
			</div>
		</div>
	);
}
