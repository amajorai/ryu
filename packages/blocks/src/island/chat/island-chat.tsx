"use client";

// The expanded-island mini chat, stripped to the essentials: a plain-text
// transcript that only appears once there is history, and a blended composer with
// the inbox button at the end. No header, no status chrome — the island shape is
// the whole surface. When Core is unreachable the composer is disabled with a
// one-line retry.
//
// Presentational view: the live island wraps this and supplies the real chat
// state (messages/sending/error) + send/stop/retry/inbox handlers.

import { type ComposerAttachment, MessageInput } from "./message-input.tsx";
import { type IslandChatMessage, MessageList } from "./message-list.tsx";

export interface IslandChatViewProps {
	/** Images staged on the composer, shown as removable chips above the input. */
	attachments?: ComposerAttachment[];
	/**
	 * A row of action pills rendered as its own strip BELOW the composer input
	 * (double-check, plugin composer actions, …). Kept out of the composer's
	 * cramped left edge so the buttons stay readable and tappable.
	 */
	belowInputActions?: React.ReactNode;
	error?: string | null;
	leftActions?: React.ReactNode;
	messages?: IslandChatMessage[];
	offline?: boolean;
	/** Report the composer height so the island can size the compact bar. */
	onComposerResize?: (height: number) => void;
	onPrefillConsumed?: () => void;
	/** Remove one staged attachment (the chip's ✕). */
	onRemoveAttachment?: (id: string) => void;
	onRetry?: () => void;
	onSend?: (text: string, options: { withScreen: boolean }) => void;
	onStop?: () => void;
	prefill?: string | null;
	sending?: boolean;
}

const noop = (): void => {
	// Static-render default; the live island injects the real chat handlers.
};

export function IslandChatView({
	attachments = [],
	messages = [],
	leftActions,
	belowInputActions,
	offline = false,
	error = null,
	sending = false,
	prefill,
	onSend = noop,
	onStop = noop,
	onRetry = noop,
	onComposerResize = noop,
	onPrefillConsumed,
	onRemoveAttachment,
}: IslandChatViewProps) {
	const hasHistory = messages.length > 0;

	return (
		<div
			className={`relative flex h-full w-full flex-col gap-2 ${
				hasHistory ? "" : "justify-center"
			}`}
		>
			{hasHistory ? (
				<div className="relative z-10 min-h-0 flex-1 overflow-y-auto pr-1">
					<MessageList messages={messages} />
				</div>
			) : null}

			{offline ? (
				<p className="relative z-10 text-neutral-400 text-xs">
					Can't reach Ryu Core.{" "}
					<button
						className="text-neutral-200 underline underline-offset-2 hover:text-neutral-100"
						onClick={onRetry}
						type="button"
					>
						Retry
					</button>
				</p>
			) : null}

			{error && !offline ? (
				<p className="relative z-10 text-red-300 text-xs">{error}</p>
			) : null}

			<div className="relative z-10 shrink-0">
				<MessageInput
					attachments={attachments}
					disabled={offline}
					leftActions={leftActions}
					onComposerResize={onComposerResize}
					onPrefillConsumed={onPrefillConsumed}
					onRemoveAttachment={onRemoveAttachment}
					onSend={onSend}
					onStop={onStop}
					prefill={prefill}
					sending={sending}
				/>
			</div>

			{/* Action pills as their own strip below the composer — a separate island
			    row so the buttons stay visible instead of crammed at the input's edge. */}
			{belowInputActions ? (
				<div className="relative z-10 flex shrink-0 flex-wrap items-center gap-1.5">
					{belowInputActions}
				</div>
			) : null}
		</div>
	);
}
