import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { UserRound } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { memo } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasFrameModel,
	type CanvasRect,
	FRAME_HEADER,
	FRAME_LABEL,
	FRAME_PADDING,
	UNASSIGNED_FRAME_ID,
} from "./canvas-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Section labels stay legible when zoomed out, like FigJam's: up to 1.8x
 * their world size, growing from the edge they are pinned to.
 */
const LABEL_SCALE = "clamp(1, calc(var(--canvas-scale, 1) * 0.9), 1.8)";

/** A frame leaving (the other arrangement's) clears out ahead of the glide. */
const FADE_OUT = {
	opacity: 0,
	transition: { duration: 0.25, ease: [0, 0, 0.2, 1] },
} as const;

/**
 * A labelled section (FigJam's "section", tldraw's "frame") that the canvas
 * first files stickies into. Frames sit under the cards and are not
 * themselves draggable: dragging on one pans, like dragging empty canvas.
 */
export const CanvasFrame = memo(function CanvasFrameImpl({
	frame,
	gliding,
	moved,
	rect,
	vacant,
}: {
	frame: CanvasFrameModel;
	/** Ease to a new size (a frame repacking) instead of jumping. */
	gliding: boolean;
	/** Its stickies dragged out of it (live while one is being dragged). */
	moved: number;
	/** The frame's rect now: its home, grown to hold stickies moved inside it. */
	rect: CanvasRect;
	/** Every sticky was moved out: show the empty slot instead of bare frame. */
	vacant: boolean;
}) {
	// The count says what the frame visibly holds; stickies dragged out of it
	// are counted apart, so a frame never claims a sticky it no longer shows.
	const tl = useLiteralMessages();
	const count = Math.max(0, frame.threadIds.length - moved);
	const label = `${frame.label}, ${count} ${count === 1 ? "thread" : "threads"}${moved > 0 ? `, ${moved} moved out` : ""}`;
	const reduceMotion = useReducedMotion();
	// A frame that appears or leaves while the stickies glide (switching the
	// arrangement) fades on the same 500ms curve, so the new sections arrive
	// with their stickies instead of snapping in under cards still in flight.
	const fade = gliding && !reduceMotion;
	// A frame fading out belongs to the arrangement being left: keep it out of
	// the accessibility tree and the frame queries while it goes.
	const present = useIsPresent();
	return (
		<motion.section
			animate={{ opacity: 1 }}
			aria-hidden={present ? undefined : true}
			aria-label={label}
			className={cn(
				"absolute top-0 left-0",
				!present && "pointer-events-none",
				gliding &&
					"motion-safe:transition-[transform,width,height] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.2,0,0,1)]"
			)}
			data-canvas-frame={present ? frame.id : undefined}
			data-testid={present ? "canvas-frame" : "canvas-frame-exit"}
			exit={reduceMotion ? undefined : FADE_OUT}
			initial={fade ? { opacity: 0 } : false}
			style={{
				height: rect.height,
				transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
				width: rect.width,
			}}
			transition={{ duration: 0.5, ease: [0.4, 0, 1, 1] }}
		>
			<header
				className="flex origin-bottom-left items-center gap-2 text-sm leading-none"
				style={{ height: FRAME_LABEL, scale: LABEL_SCALE }}
			>
				{/* The label knocks out the dot grid behind it, like FigJam's
				    section names, so no grid dot runs through a word. */}
				<span className="-ms-1.5 flex min-w-0 items-center gap-2 rounded-sm bg-background px-1.5 py-1">
					{frame.status ? <BoardStatusDot status={frame.status} /> : null}
					{frame.agent ? (
						<BoardAvatar
							agent={frame.agent}
							name={frame.agent.name}
							size={20}
						/>
					) : null}
					{frame.id === UNASSIGNED_FRAME_ID ? (
						<span
							aria-hidden="true"
							className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground/60"
						>
							<UserRound className="size-3" strokeWidth={2} />
						</span>
					) : null}
					<h3 className="min-w-0 truncate text-foreground">
						{/* An inner span: the global heading rule caps h1-h6 at 500. */}
						<span className="font-medium">{frame.label}</span>
					</h3>
					<span className="text-foreground/55 tabular-nums">{count}</span>
					{moved > 0 ? (
						<span
							className="whitespace-nowrap text-foreground/55 tabular-nums"
							data-testid="canvas-frame-moved"
						>
							{tl("{moved} moved", { moved })}
						</span>
					) : null}
				</span>
			</header>
			{/* An opaque section, as FigJam draws one: the dot grid stops at its
			    edge instead of showing through behind the stickies. */}
			<div
				aria-hidden="true"
				className="absolute inset-x-0 bottom-0 overflow-hidden rounded-lg bg-background"
				style={{ top: FRAME_LABEL }}
			>
				<div className="size-full bg-foreground/[0.035] dark:bg-foreground/[0.045]" />
			</div>
			{vacant ? (
				<span
					aria-hidden="true"
					className="absolute flex items-center justify-center rounded-md border border-foreground/15 border-dashed text-foreground/55 text-xs"
					style={{
						height: CARD_HEIGHT,
						left: FRAME_PADDING,
						top: FRAME_HEADER,
						width: CARD_WIDTH,
					}}
				>
					Moved out
				</span>
			) : null}
		</motion.section>
	);
});
