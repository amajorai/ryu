import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";

import type { MessageReactionBucket } from "./message-reactions.tsx";

/** How many distinct emoji the corner badge shows before it summarises. */
const BADGE_MAX_EMOJI = 3;

export interface MessageReactionBadgeProps {
	/** The bubble edge the message sits on; the badge pins to the opposite corner. */
	align?: "start" | "end";
	buckets: readonly MessageReactionBucket[];
	className?: string;
}

/**
 * The reactions a message already carries, pinned to the bubble's top corner the
 * way messaging apps show them.
 *
 * This is what makes an agent's reaction visible: an agent acknowledges a short
 * instruction with 👍 instead of a "Got it" reply, and that only reads as an
 * answer if it sits on the message at a glance rather than inside the hover
 * toolbar's popover. It is read-only; adding and removing stay on the toolbar
 * button and the context menu, so the bubble never grows a second control.
 */
export function MessageReactionBadge({
	align = "end",
	buckets,
	className,
}: MessageReactionBadgeProps) {
	if (buckets.length === 0) {
		return null;
	}
	const shown = buckets.slice(0, BADGE_MAX_EMOJI);
	const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
	const label = `Reactions: ${buckets
		.map((bucket) => `${bucket.emoji} ${formatNumber(bucket.count)}`)
		.join(", ")}`;
	return (
		<span
			aria-label={label}
			className={cn(
				// `ring-background`, not `ring-card`: see the dark-mode halo note in
				// `message-reactions.tsx`.
				"absolute -top-3 z-10 flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-sm leading-none ring-3 ring-background",
				// A message on the right carries its badge on the left corner and
				// vice versa, so the badge faces the conversation, not the gutter.
				align === "end" ? "-left-2" : "-right-2",
				className
			)}
			data-align={align}
			data-slot="message-reaction-badge"
			role="img"
			title={label}
		>
			{shown.map((bucket) => (
				<span aria-hidden="true" key={bucket.emoji}>
					{bucket.emoji}
				</span>
			))}
			{total > shown.length ? (
				<span
					aria-hidden="true"
					className="pl-0.5 text-muted-foreground text-xs tabular-nums"
				>
					{formatNumber(total)}
				</span>
			) : null}
		</span>
	);
}
