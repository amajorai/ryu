import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type FocusItem,
	focusAge,
	focusAgentLine,
	focusAuthor,
	focusReason,
} from "./focus-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const EASE = [0.22, 1, 0.36, 1] as const;
const FACE_LIMIT = 3;

/**
 * The dot carries the status hue; the label stays in the foreground so it
 * reads at body contrast in every theme. A failed run is the one exception.
 */
const STATUS_TEXT: Record<ThreadStatus, string> = {
	attention: "text-destructive",
	quiet: "text-foreground",
	waiting: "text-foreground",
	working: "text-foreground",
	"your-turn": "text-foreground",
};

/** Tooltips render as a light popover here, so the key keeps its own fill. */
export const FOCUS_TOOLTIP_KBD =
	"in-data-[slot=tooltip-content]:bg-muted in-data-[slot=tooltip-content]:text-muted-foreground dark:in-data-[slot=tooltip-content]:bg-muted";

function FocusFaces({ item }: { item: FocusItem }) {
	const shown = item.agents.slice(0, FACE_LIMIT);
	if (shown.length === 0) {
		return null;
	}
	const stacked = shown.length > 1;
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-2">
			{shown.map((agent) => (
				// A calm monogram (or the agent's own picture) reads cleanly at
				// this size, where the generative tile turns to noise.
				<Avatar
					className={cn(
						"size-7 before:hidden",
						stacked ? "ring-2 ring-background" : null
					)}
					key={agent.id}
				>
					{agent.avatarUrl ? (
						<AvatarImage alt="" src={agent.avatarUrl} />
					) : null}
					<AvatarFallback className="bg-muted font-medium text-foreground text-xs leading-none">
						{agent.name.trim().charAt(0).toUpperCase() || "?"}
					</AvatarFallback>
				</Avatar>
			))}
		</span>
	);
}

function Dot() {
	return (
		<span aria-hidden="true" className="text-muted-foreground/60">
			·
		</span>
	);
}

/** The changing body: status and why, title, who and when, the latest message. */
function FocusCardBody({
	item,
	now,
	titleId,
}: {
	item: FocusItem;
	now: number;
	titleId: string;
}) {
	const { thread } = item;
	const reason = focusReason(item);
	const author = focusAuthor(item);
	const age = focusAge(thread.updatedAt, now);
	const counts = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`;
	return (
		<div className="flex flex-col">
			<p className="flex min-w-0 items-center gap-2 text-sm">
				<span className="inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3">
					<BoardStatusDot status={item.status} />
					<span className={cn("font-medium", STATUS_TEXT[item.status])}>
						{THREAD_STATUS_LABELS[item.status]}
					</span>
				</span>
				{reason ? (
					<>
						<Dot />
						<span className="truncate text-muted-foreground">{reason}</span>
					</>
				) : null}
			</p>
			<h2
				className="mt-5 text-balance font-semibold @min-[640px]:text-4xl text-3xl text-foreground leading-tight tracking-tight"
				id={titleId}
			>
				{thread.title}
			</h2>
			<div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
				<FocusFaces item={item} />
				<span className="font-medium text-foreground">
					{focusAgentLine(item.agents)}
				</span>
				{item.group ? (
					<>
						<Dot />
						<span className="truncate">{item.group.name}</span>
					</>
				) : null}
				<Dot />
				<span className="tabular-nums">{counts}</span>
				{age ? (
					<>
						<Dot />
						<time className="tabular-nums" dateTime={thread.updatedAt}>
							{age}
						</time>
					</>
				) : null}
				{thread.pinned ? (
					<>
						<Dot />
						<span>Pinned</span>
					</>
				) : null}
			</div>
			<figure className="mt-8 rounded-xl bg-muted/60 px-5 py-4">
				{author ? (
					<figcaption className="mb-1.5 font-medium text-muted-foreground text-sm">
						{author}
					</figcaption>
				) : null}
				<blockquote
					className={cn(
						"line-clamp-5 text-pretty text-lg leading-relaxed",
						thread.lastMessage ? "text-foreground" : "text-muted-foreground"
					)}
				>
					{thread.lastMessage ?? "No messages yet"}
				</blockquote>
			</figure>
		</div>
	);
}

/** A ghost icon step (previous / next) with its shortcut in the tooltip. */
function StepButton({
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
						// Disabled keeps a readable tint so Previous and Next
						// still read as a pair on the first thread.
						className="disabled:text-muted-foreground/60 disabled:opacity-100"
						disabled={disabled}
						onClick={onClick}
						size="icon-lg"
						type="button"
						variant="outline"
					/>
				}
			>
				<Icon aria-hidden="true" />
			</TooltipTrigger>
			<TooltipContent side="top">
				{label}
				<Kbd className={FOCUS_TOOLTIP_KBD}>{keys}</Kbd>
			</TooltipContent>
		</Tooltip>
	);
}

/** The next thread, peeking out under the card; clicking it steps forward. */
function UpNext({ item, onNext }: { item: FocusItem; onNext: () => void }) {
	return (
		<button
			className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-border border-dashed px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onNext}
			type="button"
		>
			<span className="shrink-0 font-medium text-muted-foreground">
				Up next
			</span>
			<BoardStatusDot status={item.status} />
			<span className="min-w-0 flex-1 truncate font-medium text-foreground">
				{item.thread.title}
			</span>
			<span className="shrink-0 text-muted-foreground max-sm:hidden">
				{focusAgentLine(item.agents)}
			</span>
			<ChevronRight
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
			/>
		</button>
	);
}

/**
 * The one thread Focus shows, set straight on the page. The action row stays
 * put while the body slides and cross-fades between threads, so keyboard
 * focus on Previous or Next survives a step and the page never flashes empty.
 */
export function FocusCard({
	direction,
	hasNext,
	hasPrevious,
	item,
	now,
	onNext,
	onOpen,
	onPrevious,
	upNext,
}: {
	direction: number;
	hasNext: boolean;
	hasPrevious: boolean;
	item: FocusItem;
	now: number;
	onNext: () => void;
	onOpen: () => void;
	onPrevious: () => void;
	upNext: FocusItem | undefined;
}) {
	const titleId = useId();
	const reduceMotion = useReducedMotion();
	const offset = reduceMotion ? 0 : 24;
	return (
		<div className="flex w-full flex-col gap-4">
			<article
				aria-labelledby={titleId}
				className="flex w-full flex-col rounded-2xl border border-border bg-card @min-[640px]:p-10 p-6 text-card-foreground shadow-sm"
				data-testid="focus-card"
			>
				<div className="relative">
					<AnimatePresence custom={direction} initial={false} mode="popLayout">
						<motion.div
							animate={{ opacity: 1, x: 0 }}
							exit={{ opacity: 0, x: -direction * offset }}
							initial={{ opacity: 0, x: direction * offset }}
							key={item.thread.id}
							transition={{
								duration: reduceMotion ? 0.12 : 0.26,
								ease: EASE,
							}}
						>
							<FocusCardBody item={item} now={now} titleId={titleId} />
						</motion.div>
					</AnimatePresence>
				</div>
				<footer className="mt-8 flex items-center gap-3 border-border border-t pt-5">
					<div className="flex shrink-0 items-center gap-1">
						<StepButton
							disabled={!hasPrevious}
							icon={ChevronLeft}
							keys="K"
							label="Previous"
							onClick={onPrevious}
							shortcut="K ArrowLeft"
						/>
						<StepButton
							icon={ChevronRight}
							keys="J"
							label={hasNext ? "Next" : "Finish"}
							onClick={onNext}
							shortcut="J ArrowRight"
						/>
					</div>
					<span className="flex-1" />
					<Button
						aria-keyshortcuts="Enter O"
						aria-label="Open thread"
						className="shrink-0 gap-2"
						onClick={onOpen}
						size="lg"
						type="button"
					>
						Open thread
						<Kbd className="bg-primary-foreground/15 text-primary-foreground">
							↵
						</Kbd>
					</Button>
				</footer>
			</article>
			{upNext ? (
				<UpNext item={upNext} onNext={onNext} />
			) : (
				<p className="px-1 text-muted-foreground text-sm">Last in the queue</p>
			)}
		</div>
	);
}

const BAR =
	"block animate-pulse rounded-sm bg-muted motion-reduce:animate-none";

/** The page's shape while the first snapshot loads. */
export function FocusCardSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="flex w-full flex-col"
			data-testid="focus-skeleton"
		>
			<span className={cn(BAR, "h-5 w-44")} />
			<span className={cn(BAR, "mt-3 h-7 w-4/5")} />
			<span className={cn(BAR, "mt-2 h-7 w-1/2")} />
			<span className={cn(BAR, "mt-3 h-5 w-64 max-w-full")} />
			<div className="mt-8 flex flex-col gap-2 border-muted-foreground/30 border-s-2 ps-4">
				<span className={cn(BAR, "h-5 w-full")} />
				<span className={cn(BAR, "h-5 w-11/12")} />
				<span className={cn(BAR, "h-5 w-2/3")} />
			</div>
		</div>
	);
}
