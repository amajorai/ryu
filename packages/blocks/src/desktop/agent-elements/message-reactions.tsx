import { useLiteralMessages } from "@ryu/i18n/react";
import { EmojiPicker } from "@ryu/ui/components/emoji-picker";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";

import { IconMoodPlus, IconPlus } from "@tabler/icons-react";
import { useState } from "react";

export { isServerAssignedMessageId } from "./message-reaction-id.ts";

/**
 * Emoji reactions on one chat message: the chip row, and the picker that adds
 * to it.
 *
 * # The dark-mode halo
 *
 * `BubbleReactions` ships `ring-3 ring-card`, which exists to punch the chip row
 * out of the bubble it overlaps. That reads as a clean notch only where `--card`
 * equals the surface behind it. In this app's dark theme `--card` is a LIGHTER
 * grey than `--background`, so the ring renders as a visible pale halo around
 * every chip. The ring is overridden to the transcript's own background here
 * rather than fixed in the primitive: other surfaces (the notes editor, the
 * data grid) sit on `--card` and want the shipped value.
 */

/** One `(emoji, count)` bucket as the chip row renders it. */
export interface MessageReactionBucket {
	count: number;
	emoji: string;
	reactedByMe: boolean;
}

/**
 * The quick set, in the order every messaging client shows it.
 *
 * Fixed quick reactions keep the one-tap affordance compact; the full picker
 * remains available from the add-reaction popover.
 */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"] as const;

export interface MessageReactionsProps {
	align?: "start" | "end";
	buckets: readonly MessageReactionBucket[];
	/** Hidden entirely when false — see `isServerAssignedMessageId`. */
	canReact?: boolean;
	className?: string;
	onToggle: (emoji: string) => void;
	side?: "top" | "bottom";
}

export interface MessageReactionButtonProps {
	buckets: readonly MessageReactionBucket[];
	/** Keep the trigger for read-only reactions, but hide it when there is no data. */
	canReact?: boolean;
	className?: string;
	onToggle: (emoji: string) => void;
}

/**
 * Compact reaction action for a message toolbar.
 *
 * The transcript shows one icon, not a second chip row. Existing reaction
 * buckets remain available inside the popover so a message with reactions does
 * not become visually heavier than an ordinary message.
 */
export function MessageReactionButton({
	buckets,
	canReact = false,
	className,
	onToggle,
}: MessageReactionButtonProps) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [showEmojiPicker, setShowEmojiPicker] = useState(false);

	if (buckets.length === 0 && !canReact) {
		return null;
	}

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setShowEmojiPicker(false);
		}
	};

	const handlePick = (emoji: string) => {
		onToggle(emoji);
		handleOpenChange(false);
	};

	return (
		<Popover onOpenChange={handleOpenChange} open={open}>
			<PopoverTrigger
				render={
					<button
						aria-label="Add reaction"
						className={cn(
							"flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-60 transition-colors hover:bg-foreground/8 hover:text-foreground hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60",
							className
						)}
						data-slot="message-reaction-button"
						title="Add reaction"
						type="button"
					>
						<IconMoodPlus aria-hidden="true" className="size-3.5" />
					</button>
				}
			/>
			<PopoverContent className="w-auto" spacing="small-inset">
				<div className="flex items-center gap-0.5">
					{buckets.map((bucket) => (
						<button
							aria-label={`${bucket.emoji} ${formatNumber(bucket.count)}`}
							aria-pressed={bucket.reactedByMe}
							className={cn(
								"flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs leading-none transition-colors hover:bg-foreground/8",
								bucket.reactedByMe
									? "bg-primary/15 text-foreground"
									: "text-muted-foreground"
							)}
							key={bucket.emoji}
							onClick={() => handlePick(bucket.emoji)}
							type="button"
						>
							<span className="text-sm leading-none">{bucket.emoji}</span>
							<span className="tabular-nums">{formatNumber(bucket.count)}</span>
						</button>
					))}
					{canReact ? (
						<>
							{QUICK_REACTIONS.map((emoji) => (
								<button
									aria-label={tl("Add {emoji} reaction", { emoji })}
									className="rounded-md p-1 text-base leading-none transition-colors hover:bg-foreground/8"
									key={emoji}
									onClick={() => handlePick(emoji)}
									type="button"
								>
									{emoji}
								</button>
							))}
							<button
								aria-expanded={showEmojiPicker}
								aria-label="More emoji"
								className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-foreground/8 hover:text-foreground"
								onClick={() => setShowEmojiPicker(true)}
								title="More emoji"
								type="button"
							>
								<IconPlus aria-hidden="true" className="size-3.5" />
								<span>More</span>
							</button>
						</>
					) : null}
				</div>
				{showEmojiPicker && canReact ? (
					<div className="mt-1 overflow-hidden rounded-lg border border-border [&_em-emoji-picker]:w-full!">
						<EmojiPicker onEmojiSelect={(emoji) => handlePick(emoji.native)} />
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

/**
 * The chip row. Renders nothing at all when a message has no reactions and
 * cannot take one, so an ordinary message carries no extra box.
 */
export function MessageReactions({
	buckets,
	className,
	canReact = false,
	onToggle,
	side = "bottom",
	align = "end",
}: MessageReactionsProps) {
	if (buckets.length === 0 && !canReact) {
		return null;
	}
	return (
		<div
			// See the halo note above: `ring-background` replaces the primitive's
			// `ring-card`, which haloes wherever card ≠ background.
			className={cn(
				"absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-sm ring-3 ring-background has-[button]:p-0",
				side === "top" ? "top-0 -translate-y-3/4" : "bottom-0 translate-y-3/4",
				align === "start" ? "left-3" : "right-3",
				className
			)}
			data-align={align}
			data-side={side}
			data-slot="bubble-reactions"
		>
			{buckets.map((bucket) => (
				<button
					aria-label={`${bucket.emoji} ${formatNumber(bucket.count)}`}
					aria-pressed={bucket.reactedByMe}
					className={cn(
						"flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs leading-none transition-colors",
						"hover:bg-foreground/8",
						// The caller's own reactions are the only ones tinted, so a glance
						// answers "did I already react" without counting.
						bucket.reactedByMe
							? "bg-primary/15 text-foreground"
							: "text-muted-foreground"
					)}
					key={bucket.emoji}
					onClick={() => onToggle(bucket.emoji)}
					type="button"
				>
					<span className="text-sm leading-none">{bucket.emoji}</span>
					<span className="tabular-nums">{formatNumber(bucket.count)}</span>
				</button>
			))}
			{canReact && <ReactionPicker onPick={onToggle} />}
		</div>
	);
}

function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [showEmojiPicker, setShowEmojiPicker] = useState(false);

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setShowEmojiPicker(false);
		}
	};

	const handlePick = (emoji: string) => {
		onPick(emoji);
		handleOpenChange(false);
	};

	return (
		<Popover onOpenChange={handleOpenChange} open={open}>
			{/* Base UI triggers take a `render` prop; nesting a button as a CHILD of
			    the trigger renders a button inside a button and throws. */}
			<PopoverTrigger
				render={
					<button
						aria-label="Add reaction"
						className="flex items-center rounded-full px-1 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
						type="button"
					>
						<IconMoodPlus className="size-3.5" />
					</button>
				}
			/>
			<PopoverContent className="w-auto" spacing="small-inset">
				<div className="flex items-center gap-0.5">
					{QUICK_REACTIONS.map((emoji) => (
						<button
							aria-label={tl("Add {emoji} reaction", { emoji })}
							className="rounded-md p-1 text-base leading-none transition-colors hover:bg-foreground/8"
							key={emoji}
							onClick={() => handlePick(emoji)}
							type="button"
						>
							{emoji}
						</button>
					))}
					<button
						aria-expanded={showEmojiPicker}
						aria-label="More emoji"
						className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-foreground/8 hover:text-foreground"
						onClick={() => setShowEmojiPicker(true)}
						title="More emoji"
						type="button"
					>
						<IconPlus aria-hidden="true" className="size-3.5" />
						<span>More</span>
					</button>
				</div>
				{showEmojiPicker && (
					<div className="overflow-hidden rounded-lg border border-border [&_em-emoji-picker]:w-full!">
						<EmojiPicker onEmojiSelect={(emoji) => handlePick(emoji.native)} />
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
