"use client";

// The expanded-island mini chat, stripped to the essentials: a plain-text
// transcript that only appears once there is history, and a blended composer with
// the inbox button at the end. No header, no status chrome — the island shape is
// the whole surface. When Core is unreachable the composer is disabled with a
// one-line retry.
//
// Presentational view: the live island wraps this and supplies the real chat
// state (messages/sending/error) + send/stop/retry/inbox handlers.

import type { KeyboardEvent, ReactNode } from "react";
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
	belowInputActions?: ReactNode;
	error?: string | null;
	leftActions?: ReactNode;
	messages?: IslandChatMessage[];
	offline?: boolean;
	/** Focus-scoped composer settings shortcuts (cycle agent/mode/model/thinking). */
	onComposerKeyDown?: (event: KeyboardEvent<HTMLElement>) => boolean;
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
	/**
	 * The transcript to render above the composer, replacing the built-in
	 * plain-text {@link MessageList}. The live island passes
	 * {@link IslandTranscript} — the real desktop message list at compact density,
	 * so tool rows, MCP widgets and generated images render here exactly as they
	 * do in the desktop chat.
	 *
	 * Static surfaces (the storyboard screens, the marketing global island) keep
	 * passing `messages` and get the plain-text list, which needs no chat runtime.
	 */
	transcript?: ReactNode;
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
	onComposerKeyDown,
	onPrefillConsumed,
	onRemoveAttachment,
	transcript,
}: IslandChatViewProps) {
	const hasHistory = transcript ? true : messages.length > 0;

	return (
		<div
			className={`relative flex h-full w-full flex-col gap-2 ${
				hasHistory ? "" : "justify-center"
			}`}
		>
			{transcript ? (
				// The real message list owns its own scroller (MessageScroller), so it
				// gets a plain flex slot — wrapping it in `overflow-y-auto` would nest
				// two scroll containers and break auto-scroll.
				<div className="relative z-10 flex min-h-0 flex-1 flex-col">
					{transcript}
				</div>
			) : null}

			{!transcript && hasHistory ? (
				<div className="relative z-10 min-h-0 flex-1 overflow-y-auto pr-1">
					<MessageList messages={messages} />
				</div>
			) : null}

			{offline ? (
				<p className="relative z-10 text-muted-foreground text-xs">
					Can't reach Ryu Core.{" "}
					<button
						className="text-foreground underline underline-offset-2 hover:text-foreground"
						onClick={onRetry}
						type="button"
					>
						Retry
					</button>
				</p>
			) : null}

			{error && !offline ? (
				<p className="relative z-10 text-status-destructive text-xs">{error}</p>
			) : null}

			<div className="relative z-10 shrink-0">
				<MessageInput
					attachments={attachments}
					disabled={offline}
					leftActions={leftActions}
					onComposerKeyDown={onComposerKeyDown}
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
