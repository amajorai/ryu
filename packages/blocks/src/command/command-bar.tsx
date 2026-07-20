"use client";

// The command-bar shell, extracted as a prop-driven block.
//
// It renders the REAL shared @ryu/command surfaces (CommandPalette + ChatView)
// inside the frosted "Golden Gate" morph card. Everything is props in: the live
// apps/command wrapper injects the real transport + agents/conversations; the
// storyboard injects static data + a synthetic transport so each visual state
// renders through the genuine components. The block never imports the Electron
// bridge, a transport, or Core.

import { ChatView } from "@ryu/command/ChatView";
import { CommandPalette } from "@ryu/command/CommandPalette";
import type {
	ChatMessage,
	ChatStreamFn,
	ChatStreamHandle,
	CommandAction,
} from "@ryu/command/types";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import type { KeyboardEvent, ReactNode } from "react";

export type CommandBarMode = "palette" | "chat";

export interface CommandBarProps {
	/** Flat action list the palette renders, grouped by `group`. */
	actions?: CommandAction[];

	/** Label shown next to the back button in chat mode. */
	agentLabel?: string;

	/** Replay the entrance animation when this key changes. */
	animateKey?: string | number;
	/** Focus the palette input / chat composer on mount. */
	autoFocus?: boolean;
	/** Composer placeholder in chat mode. */
	chatPlaceholder?: string;
	className?: string;
	/** Empty-results label for the palette. */
	emptyLabel?: string;
	/** Greeting shown above an empty chat transcript. */
	greeting?: ReactNode;
	/** Pre-populated transcript rendered on mount (a resumed conversation). */
	initialMessages?: ChatMessage[];
	/** A one-shot prompt sent on mount (the text typed into the palette). */
	initialPrompt?: string;
	/** Which surface to show: the fuzzy palette or the morphed mini-chat. */
	mode?: CommandBarMode;
	/** Back-to-palette affordance handler. */
	onExit?: () => void;
	/** Palette input key handler (Escape to hide, Enter to ask). */
	onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	/** Search-change handler (the live wrapper updates its own state). */
	onSearchChange?: (value: string) => void;
	/** Palette input placeholder. */
	placeholder?: string;
	/** Controlled search value for the palette input. */
	search?: string;
	/** Static-render only: an error message the synthetic turn fails with. */
	seedError?: string;

	/** Static-render only: assistant partial text to stream and then hang on. */
	seedStreaming?: string;
	/** When false, cmdk's built-in fuzzy filter is bypassed (deterministic gallery). */
	shouldFilter?: boolean;

	/**
	 * The live streaming transport. When supplied (the real apps/command wrapper)
	 * it drives the chat. When omitted, a synthetic transport replays the static
	 * `seedStreaming` / `seedError` props so the visual state renders.
	 */
	stream?: ChatStreamFn;
}

/** A no-op handle for transports that have nothing to abort. */
const NOOP_HANDLE: ChatStreamHandle = { abort: () => undefined };

/**
 * A static transport for the storyboard: it streams the seeded partial text once
 * (so the composer flips to its Stop state) and never finishes, or fails the turn
 * with the seeded error after one tiny delta (so no empty assistant bubble shows).
 */
function makeSeedTransport(options: {
	streaming?: string;
	error?: string;
}): ChatStreamFn {
	return (_messages, handlers) => {
		if (options.error) {
			// A short real partial so the failed turn does not leave a blank bubble.
			handlers.onDelta("Working on it…");
			handlers.onError(options.error);
			return NOOP_HANDLE;
		}
		if (options.streaming) {
			handlers.onDelta(options.streaming);
			// Deliberately never call onDone: leaves the turn mid-stream.
		}
		return NOOP_HANDLE;
	};
}

/** A back chevron without pulling another icon import into the JSX. */
function BackChevron() {
	return (
		<svg
			aria-hidden="true"
			className="size-3 rotate-180"
			fill="none"
			viewBox="0 0 24 24"
		>
			<path
				d="M9 6l6 6-6 6"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

/**
 * The frosted morph card. Renders the real palette or the real chat view, with a
 * crossfade between the two. The host (Electron window / storyboard frame) draws
 * the floating surround; this block draws the inner glass slab + morph.
 */
export function CommandBar({
	mode = "palette",
	search,
	onSearchChange,
	onInputKeyDown,
	actions = [],
	placeholder = "Search or Ask",
	shouldFilter,
	autoFocus = true,
	emptyLabel,
	agentLabel = "Ryu (default)",
	onExit,
	greeting,
	chatPlaceholder = "Ask Ryu anything…",
	stream,
	initialMessages,
	initialPrompt,
	seedStreaming,
	seedError,
	animateKey,
	className,
}: CommandBarProps) {
	const chatStream =
		stream ?? makeSeedTransport({ streaming: seedStreaming, error: seedError });
	// A seeded streaming/error turn needs a prompt to fire the synthetic transport.
	const effectivePrompt =
		initialPrompt ??
		(stream ? undefined : seedStreaming || seedError ? "…" : undefined);

	return (
		<motion.div
			animate={{ opacity: 1, scale: 1 }}
			className={cn(
				"flex w-full flex-col overflow-hidden rounded-[28px] border border-white/15 bg-popover/60 text-popover-foreground shadow-2xl shadow-black/30 ring-1 ring-white/5 ring-inset backdrop-blur-2xl",
				className
			)}
			initial={{ opacity: 0, scale: 0.985 }}
			key={animateKey}
			transition={{ duration: 0.16, ease: "easeOut" }}
		>
			<AnimatePresence initial={false} mode="wait">
				{mode === "palette" ? (
					<motion.div
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key="palette"
						transition={{ duration: 0.1 }}
					>
						<CommandPalette
							actions={actions}
							autoFocus={autoFocus}
							chrome="bare"
							emptyLabel={emptyLabel}
							onInputKeyDown={onInputKeyDown}
							onSearchChange={onSearchChange}
							placeholder={placeholder}
							search={search}
							shouldFilter={shouldFilter}
						/>
					</motion.div>
				) : (
					<motion.div
						animate={{ opacity: 1 }}
						className="flex flex-col"
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key="chat"
						style={{ height: 440 }}
						transition={{ duration: 0.1 }}
					>
						<div className="flex items-center gap-2 border-border/50 border-b px-3 py-2">
							<button
								className="flex items-center gap-1 rounded-full px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
								onClick={onExit}
								type="button"
							>
								<BackChevron />
								Back
							</button>
							<span className="text-muted-foreground text-xs">
								{agentLabel}
							</span>
						</div>
						<ChatView
							autoFocus={autoFocus}
							className="min-h-0 flex-1"
							greeting={greeting}
							initialMessages={initialMessages}
							initialPrompt={effectivePrompt}
							onExit={onExit}
							placeholder={chatPlaceholder}
							stream={chatStream}
						/>
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
}
