import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceThread, ThreadStatus } from "@ryuhq/protocol/interfaces";
import { LoaderCircle, MessageSquarePlus } from "lucide-react";
import type { ReactNode } from "react";
import { ArenaAvatar } from "./arena-avatar.tsx";
import {
	ARENA_STATE_LABELS,
	type ArenaAgentState,
	type ArenaCardView,
} from "./arena-model.ts";
import { compactAge } from "./interface-renderer.ts";

/** Marks the one control per card that arrow keys move focus between. */
export const ARENA_NAV_ATTRIBUTE = "data-arena-nav";

/*
 * A card's state is one signal: a status mark and a word beside the name. It
 * is the only mark on the card; the counts below it are plain text.
 * Each state differs by more than hue, so themes whose primary and success
 * colours are close (green presets) still read: working spins, failed is
 * destructive text, needs-you is full-contrast medium text, idle is muted.
 */
const STATE_TEXT: Record<ArenaAgentState, string> = {
	failed: "font-medium text-status-destructive",
	idle: "text-muted-foreground",
	"needs-you": "font-medium text-foreground",
	working: "text-foreground",
};

const STATE_DOT: Record<Exclude<ArenaAgentState, "working">, string> = {
	failed: "bg-destructive",
	idle: "bg-muted-foreground/40",
	"needs-you": "bg-primary",
};

interface CountToken {
	label: string;
	status: ThreadStatus;
	/** Number and label tone; only a failed count leaves the neutral scale. */
	tone: { label: string; value: string };
}

const NEUTRAL_TONE = {
	label: "text-muted-foreground",
	value: "text-foreground",
};

const COUNT_TOKENS: readonly CountToken[] = [
	{
		label: "failed",
		status: "attention",
		tone: {
			label: "text-status-destructive",
			value: "text-status-destructive",
		},
	},
	{ label: "your turn", status: "your-turn", tone: NEUTRAL_TONE },
	{ label: "waiting", status: "waiting", tone: NEUTRAL_TONE },
];

const COUNT_ARIA: Record<ThreadStatus, string> = {
	attention: "failed run",
	quiet: "unstarted thread",
	waiting: "thread waiting on the agent",
	working: "running thread",
	"your-turn": "reply waiting for you",
};

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function threadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

/** "Launch Crew" stays a name; "+2" becomes "2 others". */
function withLabel(focusWith: string): string {
	const extra = /^\+(\d+)$/.exec(focusWith);
	if (!extra) {
		return `with ${focusWith}`;
	}
	const count = Number(extra[1]);
	return `with ${count} ${count === 1 ? "other" : "others"}`;
}

function activityLabel(card: ArenaCardView, now: number): ReactNode {
	const age = card.lastActivityAt ? compactAge(card.lastActivityAt, now) : "";
	if (!(card.lastActivityAt && age)) {
		return "No activity yet";
	}
	return (
		<time dateTime={card.lastActivityAt}>
			{age === "now" ? "Just now" : `${age} ago`}
		</time>
	);
}

/** Which thread the card's focus area shows, and who else is on it. */
function focusOf(
	card: ArenaCardView,
	inPanel: InterfaceThread | undefined
): {
	repeat: boolean;
	thread: InterfaceThread | undefined;
	with: string | null;
} {
	if (!inPanel) {
		return {
			repeat: card.focusRepeat,
			thread: card.focusThread,
			with: card.focusWith,
		};
	}
	let shared: string | null = null;
	if (inPanel.id === card.focusThreadId) {
		shared = card.focusWith;
	} else if (inPanel.agentIds.length > 1) {
		shared = `+${inPanel.agentIds.length - 1}`;
	}
	return { repeat: false, thread: inPanel, with: shared };
}

/** The agent's state: one mark and one word, beside the name. */
function StateLabel({ state }: { state: ArenaAgentState }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-baseline gap-1.5 text-[13px] leading-5",
				STATE_TEXT[state]
			)}
		>
			{state === "working" ? (
				<LoaderCircle
					aria-hidden="true"
					className="size-3 self-center text-status-success motion-safe:animate-spin"
				/>
			) : (
				<span
					aria-hidden="true"
					className={cn("size-1.5 self-center rounded-full", STATE_DOT[state])}
				/>
			)}
			{ARENA_STATE_LABELS[state]}
		</span>
	);
}

function FocusThread({
	card,
	compact,
	inPanel,
	onOpen,
	tabIndex,
}: {
	card: ArenaCardView;
	compact: boolean;
	inPanel: InterfaceThread | undefined;
	onOpen: (threadId: string) => void;
	tabIndex: number;
}) {
	const focus = focusOf(card, inPanel);
	const thread = focus.thread;
	if (!thread) {
		return (
			<p
				className={cn(
					"text-muted-foreground text-sm",
					!compact && "min-h-[3.75rem]"
				)}
			>
				No conversations yet
			</p>
		);
	}
	const title = threadTitle(thread);
	const titleClass =
		"-mx-1.5 -my-0.5 min-w-0 truncate px-1.5 py-0.5 text-start font-medium text-foreground text-sm leading-5";
	// The open thread is already highlighted; its title is not a second link.
	const heading = inPanel ? (
		<span className={titleClass}>{title}</span>
	) : (
		<button
			{...{ [ARENA_NAV_ATTRIBUTE]: "" }}
			aria-label={`Open ${card.name}'s ${thread.running ? "live" : "latest"} thread: ${title}`}
			className={cn(
				titleClass,
				"rounded-md outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:ring-2 focus-visible:ring-ring"
			)}
			onClick={() => onOpen(thread.id)}
			tabIndex={tabIndex}
			type="button"
		>
			{title}
		</button>
	);
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<p className="flex min-w-0 items-baseline gap-1.5">
				{heading}
				{focus.with ? (
					<span className="min-w-0 shrink-[2] truncate text-[13px] text-muted-foreground">
						{withLabel(focus.with)}
					</span>
				) : null}
				{/* The state label already says Working for the agent's own run. */}
				{thread.running && card.state !== "working" ? (
					<span className="ms-auto inline-flex shrink-0 items-center gap-1.5 self-center text-foreground text-xs">
						<LoaderCircle
							aria-hidden="true"
							className="size-3 text-status-success motion-safe:animate-spin"
						/>
						Live
					</span>
				) : null}
			</p>
			{thread.lastMessage && !(compact || focus.repeat) ? (
				<p className="line-clamp-2 min-h-10 text-muted-foreground text-sm leading-5">
					{thread.lastMessageRole === "user" ? (
						<span className="text-foreground">You: </span>
					) : null}
					{thread.lastMessage}
				</p>
			) : null}
		</div>
	);
}

function Counts({
	card,
	compact,
	onOpen,
	tabIndex,
}: {
	card: ArenaCardView;
	compact: boolean;
	onOpen: (threadId: string) => void;
	tabIndex: number;
}) {
	const shown = COUNT_TOKENS.filter((token) => card.counts[token.status] > 0);
	if (shown.length === 0) {
		return (
			<p
				className={cn(
					"truncate text-[13px] text-muted-foreground leading-6",
					compact && "hidden"
				)}
			>
				{card.threadCount === 0
					? "Ready for a first message"
					: `${plural(card.threadCount, "thread")}, nothing waiting on you`}
			</p>
		);
	}
	return (
		<ul
			aria-label={`${card.name}'s threads`}
			className="-ms-1.5 flex min-w-0 flex-wrap items-center"
		>
			{shown.map((token, index) => {
				const count = card.counts[token.status];
				const shared = card.shared[token.status] ?? 0;
				const threadId = card.latestByStatus[token.status];
				const sharedNote =
					shared > 0
						? `, ${shared} shared with other agents and counted on their cards too`
						: "";
				return (
					<li className="flex shrink-0 items-center" key={token.status}>
						{index > 0 ? (
							<span
								aria-hidden="true"
								className="text-[13px] text-muted-foreground"
							>
								·
							</span>
						) : null}
						<button
							aria-label={`Open ${card.name}'s latest ${COUNT_ARIA[token.status]} (${count} total${sharedNote})`}
							className={cn(
								"relative z-10 inline-flex h-6 items-baseline gap-1 rounded-md px-1.5 text-[13px] leading-6 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
							)}
							disabled={!threadId}
							onClick={() => (threadId ? onOpen(threadId) : undefined)}
							tabIndex={tabIndex}
							title={
								shared > 0
									? `Includes ${plural(shared, "shared thread")}, also counted on teammates' cards`
									: undefined
							}
							type="button"
						>
							<span
								className={cn("font-medium tabular-nums", token.tone.value)}
							>
								{count}
							</span>
							<span className={token.tone.label}>{token.label}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function IconAction({
	icon,
	label,
	navigable,
	onClick,
	revealOnHover,
	tabIndex,
}: {
	icon: ReactNode;
	label: string;
	navigable: boolean;
	onClick: () => void;
	/** Secondary on this card: shown on hover or keyboard focus only. */
	revealOnHover: boolean;
	tabIndex: number;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						{...(navigable ? { [ARENA_NAV_ATTRIBUTE]: "" } : {})}
						aria-label={label}
						className={cn(
							"relative z-10 size-7 text-muted-foreground hover:text-foreground",
							revealOnHover &&
								"opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-[popup-open]:opacity-100"
						)}
						onClick={onClick}
						size="icon-sm"
						tabIndex={tabIndex}
						type="button"
						variant="ghost"
					/>
				}
			>
				{icon}
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

export interface ArenaAgentCardProps {
	card: ArenaCardView;
	/** Beside an open thread: smaller avatar, one-line focus, inline counts. */
	compact: boolean;
	/** The open thread, when this card is the one that leads it. */
	inPanel: InterfaceThread | undefined;
	now: number;
	onMessage: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	/**
	 * Whether this card's controls are in the Tab order. The wall uses a
	 * roving tab stop, so Tab enters one card and arrow keys move between them.
	 */
	tabbable: boolean;
}

/**
 * One agent on the wall: who it is and where it stands, the thread it is on
 * (live run first, else the newest; its title opens it), what is waiting on
 * whom, and a quiet action to start a new thread with the agent. The card
 * that leads the open thread mirrors it; the panel owns closing it.
 */
export function ArenaAgentCard({
	card,
	compact,
	inPanel,
	now,
	onMessage,
	onOpen,
	tabbable,
}: ArenaAgentCardProps) {
	const nameId = `arena-agent-${card.agentId}`;
	const tabIndex = tabbable ? 0 : -1;
	// With no thread title to open (none yet, or it is the one in the panel),
	// Message is the card's arrow-key target.
	const messageIsNav = inPanel !== undefined || !card.focusThread;
	// With no threads yet, Message is the card's main action and stays visible.
	const secondaryMessage = card.threadCount > 0;
	return (
		<article
			aria-current={inPanel ? "true" : undefined}
			aria-labelledby={nameId}
			className={cn(
				"group/card relative flex h-full flex-col rounded-lg border bg-card p-4 text-card-foreground transition-colors",
				compact ? "gap-2" : "gap-3",
				inPanel
					? "border-primary"
					: "border-border hover:border-foreground/20 hover:bg-muted/30"
			)}
			data-agent-id={card.agentId}
			data-state={card.state}
		>
			<header className="flex items-center gap-3">
				<ArenaAvatar
					agent={card.agent}
					name={card.name}
					size={compact ? 32 : 40}
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex min-w-0 items-baseline gap-2">
						<h3
							className="min-w-0 flex-1 truncate text-base leading-6"
							id={nameId}
						>
							<span className="font-semibold">{card.name}</span>
						</h3>
						<StateLabel state={card.state} />
					</div>
					{compact ? null : (
						<p className="truncate text-[13px] text-muted-foreground leading-5">
							{card.agent?.description || plural(card.threadCount, "thread")}
						</p>
					)}
				</div>
			</header>
			<FocusThread
				card={card}
				compact={compact}
				inPanel={inPanel}
				onOpen={onOpen}
				tabIndex={tabIndex}
			/>
			<footer className="mt-auto flex h-7 min-w-0 items-center gap-2">
				<div className="min-w-0 flex-1 overflow-hidden">
					<Counts
						card={card}
						compact={compact}
						onOpen={onOpen}
						tabIndex={tabIndex}
					/>
				</div>
				{/* On a card with threads, Message takes the time's place on hover or focus. */}
				<div className="relative flex shrink-0 items-center justify-end">
					{secondaryMessage ? (
						<span className="text-[13px] text-muted-foreground tabular-nums leading-6 transition-opacity group-focus-within/card:opacity-0 group-hover/card:opacity-0">
							{activityLabel(card, now)}
						</span>
					) : null}
					<div
						className={cn(
							"-me-1.5 flex items-center",
							secondaryMessage && "absolute end-0"
						)}
					>
						<IconAction
							icon={<MessageSquarePlus aria-hidden="true" />}
							label={`Message ${card.name}`}
							navigable={messageIsNav}
							onClick={() => onMessage(card.agentId)}
							revealOnHover={secondaryMessage}
							tabIndex={tabIndex}
						/>
					</div>
				</div>
			</footer>
		</article>
	);
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

/** Placeholder cards shaped like the real ones while the first snapshot loads. */
export function ArenaCardSkeletons() {
	return SKELETON_KEYS.map((key) => (
		<li aria-hidden="true" key={key}>
			<div className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4">
				<div className="flex items-center gap-3">
					<Skeleton className="size-10" radius="dense" />
					<div className="flex flex-1 flex-col gap-1.5">
						<Skeleton className="h-3.5 w-24" radius="dense" />
						<Skeleton className="h-3 w-40" radius="dense" />
					</div>
				</div>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-3.5 w-3/5" radius="dense" />
					<Skeleton className="h-3 w-full" radius="dense" />
					<Skeleton className="h-3 w-4/5" radius="dense" />
				</div>
				<div className="flex h-7 items-center justify-between">
					<Skeleton className="h-3 w-20" radius="dense" />
					<Skeleton className="h-3 w-12" radius="dense" />
				</div>
			</div>
		</li>
	));
}
