import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import {
	ArrowLeft,
	ChevronLeft,
	ChevronRight,
	type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { FOCUS_TOOLTIP_KBD } from "./focus-card.tsx";
import type { FocusItem } from "./focus-model.ts";
import { FocusStrip } from "./focus-strip.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/** One of the header's previous/next pair: a ghost icon button with its shortcut. */
function FrameStep({
	disabled = false,
	icon: Icon,
	keys,
	label,
	onClick,
	shortcut,
}: {
	disabled?: boolean;
	icon: LucideIcon;
	keys: string;
	label: string;
	onClick: () => void;
	shortcut: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-keyshortcuts={shortcut}
						aria-label={label}
						className="disabled:text-muted-foreground/60 disabled:opacity-100"
						disabled={disabled}
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost-muted"
					/>
				}
			>
				<Icon aria-hidden="true" />
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{label}
				<Kbd className={FOCUS_TOOLTIP_KBD}>{keys}</Kbd>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * An open thread inside Focus: a slim header (back to the queue, where you
 * are, and the next thread) over the host's own conversation surface. The
 * host's view is the chat; Focus only frames it.
 */
export function FocusFrame({
	currentIndex,
	hasNext,
	hasPrevious,
	item,
	onBack,
	onNext,
	onPrevious,
	onSelect,
	position,
	queue,
	threadRef,
	threadView,
}: {
	currentIndex: number;
	hasNext: boolean;
	hasPrevious: boolean;
	/** The open thread's queue entry; undefined for a thread not in the snapshot yet. */
	item: FocusItem | undefined;
	onBack: () => void;
	onNext: () => void;
	onPrevious: () => void;
	onSelect: (index: number) => void;
	position: string;
	queue: FocusItem[];
	threadRef: RefObject<HTMLDivElement | null>;
	threadView: ReactNode;
}) {
	const reduceMotion = useReducedMotion();
	return (
		<motion.div
			animate={{ opacity: 1, scale: 1 }}
			className="flex size-full min-h-0 flex-col"
			data-testid="focus-frame"
			initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.99 }}
			transition={{ duration: reduceMotion ? 0.1 : 0.24, ease: "easeOut" }}
		>
			{/* The header keeps the queue's reading column, so opening a thread
			    leaves the title, position and steps where the eye already is. */}
			<header className="mx-auto flex w-full max-w-[44rem] shrink-0 flex-col px-4 pt-2 sm:px-6">
				<div className="flex h-12 min-w-0 items-center gap-2">
					<Button
						aria-keyshortcuts="Escape"
						className="-ms-2"
						onClick={onBack}
						size="sm"
						type="button"
						variant="ghost-muted"
					>
						<ArrowLeft aria-hidden="true" />
						<span className="max-sm:sr-only">Back to queue</span>
					</Button>
					<div className="flex min-w-0 flex-1 items-center gap-2">
						{item ? <BoardStatusDot status={item.status} /> : null}
						<h2 className="truncate font-medium text-foreground text-sm">
							{item?.thread.title ?? "New conversation"}
						</h2>
					</div>
					<span
						aria-live="polite"
						className="shrink-0 pe-2 text-muted-foreground text-sm tabular-nums"
					>
						{position}
					</span>
					<div className="-me-2 flex shrink-0 items-center">
						<FrameStep
							disabled={!hasPrevious}
							icon={ChevronLeft}
							keys="K"
							label="Previous thread"
							onClick={onPrevious}
							shortcut="K ArrowLeft"
						/>
						<FrameStep
							icon={ChevronRight}
							keys="J"
							label={hasNext ? "Next thread" : "Finish"}
							onClick={onNext}
							shortcut="J ArrowRight"
						/>
					</div>
				</div>
				{/* The queue strip is the header's bottom edge. */}
				<FocusStrip
					currentIndex={currentIndex}
					density="slim"
					onSelect={onSelect}
					queue={queue}
				/>
			</header>
			{/* The conversation shares the header's column, so the frame and the
			    chat keep one pair of edges. The host view brings its own inner
			    gutter; the extra sm:px-2 lines it up with the header's px-6. */}
			<div
				className="relative mx-auto min-h-0 w-full max-w-[44rem] flex-1 overflow-hidden sm:px-2"
				data-testid="focus-thread"
				ref={threadRef}
			>
				{threadView}
			</div>
		</motion.div>
	);
}
