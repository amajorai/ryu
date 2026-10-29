import { cn } from "@ryu/ui/lib/utils";
import { CircleAlert, CircleCheck, MessageCircleQuestion } from "lucide-react";
import { POST_MARKER_LABELS, type PostMarker } from "./posts-model.ts";

const TONE: Record<PostMarker, string> = {
	"awaiting-reply": "text-muted-foreground",
	"feedback-requested": "text-status-warning",
	"in-progress": "text-status-success",
	"needs-attention": "text-status-destructive",
	resolved: "text-muted-foreground",
};

/** A live run: a solid dot with a slow halo (still when motion is reduced). */
function LiveDot() {
	return (
		<span
			aria-hidden="true"
			className="relative flex size-3.5 shrink-0 items-center justify-center"
		>
			<span className="absolute size-2.5 rounded-full bg-success/25 motion-safe:animate-pulse" />
			<span className="relative size-1.5 rounded-full bg-success" />
		</span>
	);
}

/** A waiting post: a hollow ring, so it never reads as a live run. */
function HollowDot() {
	return (
		<span
			aria-hidden="true"
			className="flex size-3.5 shrink-0 items-center justify-center"
		>
			<span className="size-2 rounded-full border-[1.5px] border-current" />
		</span>
	);
}

function MarkerGlyph({ marker }: { marker: PostMarker }) {
	switch (marker) {
		case "feedback-requested":
			return (
				<MessageCircleQuestion
					aria-hidden="true"
					className="size-3.5 shrink-0"
					strokeWidth={2}
				/>
			);
		case "needs-attention":
			return (
				<CircleAlert
					aria-hidden="true"
					className="size-3.5 shrink-0"
					strokeWidth={2}
				/>
			);
		case "resolved":
			return (
				<CircleCheck
					aria-hidden="true"
					className="size-3.5 shrink-0"
					strokeWidth={2}
				/>
			);
		case "in-progress":
			return <LiveDot />;
		default:
			return <HollowDot />;
	}
}

/**
 * The one status mark a post carries, in Campsite's vocabulary. `label`
 * overrides the text (e.g. "Forge is writing") but keeps the glyph and tone.
 */
export function PostMarkerLabel({
	className,
	label,
	marker,
}: {
	className?: string;
	label?: string;
	marker: PostMarker;
}) {
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1.5 font-medium text-[13px] leading-5",
				TONE[marker],
				className
			)}
			data-marker={marker}
		>
			<MarkerGlyph marker={marker} />
			<span className="truncate">{label ?? POST_MARKER_LABELS[marker]}</span>
		</span>
	);
}
