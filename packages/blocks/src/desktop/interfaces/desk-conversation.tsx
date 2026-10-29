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
import { ArrowLeft, Inbox, PanelRight, SquarePen, X } from "lucide-react";
import { motion } from "motion/react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useRef,
} from "react";
import { DeskAvatar, DeskAvatarStack } from "./desk-avatar.tsx";
import { type DeskRow, pluralize } from "./desk-model.ts";
import { DeskStatusIcon, DeskStatusPill } from "./desk-status.tsx";
import { compactAge } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** True for targets where Escape belongs to the text the user is editing. */
function isEditableTarget(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

function ConversationHeader({
	detailsInline,
	detailsOpen,
	newTargetLabel,
	onClose,
	onToggleDetails,
	row,
	stacked,
}: {
	/** Details sit beside the chat, so the pill would repeat their status. */
	detailsInline: boolean;
	detailsOpen: boolean;
	newTargetLabel: string | null;
	onClose: () => void;
	onToggleDetails: (() => void) | null;
	row: DeskRow | null;
	stacked: boolean;
}) {
	const title = row ? row.title : "New conversation";
	let context: ReactNode = newTargetLabel
		? `With ${newTargetLabel} · write the first message below`
		: "Pick an agent and write the first message below";
	if (row) {
		const names =
			row.agents.length > 0
				? row.agents.map((agent) => agent.name).join(", ")
				: "No agent";
		context = row.group ? `${names} · ${row.group.name}` : names;
	}
	return (
		<header
			className={cn(
				"flex h-14 shrink-0 items-center gap-3 border-border border-b bg-background pr-2",
				stacked ? "pl-2" : "pl-4"
			)}
		>
			{stacked ? (
				<Button
					aria-label="Back to conversations"
					onClick={onClose}
					size="icon-sm"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" />
				</Button>
			) : null}
			{row && row.agents.length > 0 ? (
				<DeskAvatarStack agents={row.agents} />
			) : null}
			<div className="flex min-w-0 flex-1 flex-col">
				<h2 className="truncate text-foreground text-sm">
					<span className="font-semibold">{title}</span>
				</h2>
				<p className="truncate text-muted-foreground text-xs">{context}</p>
			</div>
			{row && !detailsInline ? (
				<DeskStatusPill
					className="@max-[520px]/conv:hidden"
					status={row.status}
				/>
			) : null}
			<div className="flex shrink-0 items-center gap-1">
				{onToggleDetails ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-controls="desk-details"
									aria-expanded={detailsOpen}
									aria-label={detailsOpen ? "Hide details" : "Show details"}
									className={cn(detailsOpen && "bg-muted text-foreground")}
									data-testid="desk-details-toggle"
									onClick={onToggleDetails}
									size="icon-sm"
									variant="ghost-muted"
								/>
							}
						>
							<PanelRight aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{detailsOpen ? "Hide details" : "Show details"} <Kbd>I</Kbd>
						</TooltipContent>
					</Tooltip>
				) : null}
				{stacked ? null : (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label="Close conversation"
									onClick={onClose}
									size="icon-sm"
									variant="ghost-muted"
								/>
							}
						>
							<X aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="bottom">
							Close <Kbd>Esc</Kbd>
						</TooltipContent>
					</Tooltip>
				)}
			</div>
		</header>
	);
}

/**
 * The open conversation: our header over the host's real chat screen, with
 * the details sidebar beside it (or over it at narrow widths).
 */
export function DeskConversation({
	details,
	detailsOpen,
	detailsOverlay,
	newTargetLabel,
	onClose,
	onCloseDetails,
	onToggleDetails,
	ref,
	row,
	stacked,
	threadView,
}: {
	/** The details sidebar, when it is open and there is a thread to describe. */
	details: ReactNode | null;
	detailsOpen: boolean;
	/** Float details over the chat instead of beside it. */
	detailsOverlay: boolean;
	newTargetLabel: string | null;
	onClose: () => void;
	onCloseDetails: () => void;
	onToggleDetails: (() => void) | null;
	ref?: Ref<HTMLElement>;
	/** Null while the host shows a brand-new conversation. */
	row: DeskRow | null;
	stacked: boolean;
	threadView: ReactNode;
}) {
	const mainRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const focusInOverlay = useRef(false);
	const overlayOpen = Boolean(details) && detailsOverlay;
	const reduceMotion = useReducedMotion();
	const transition = reduceMotion
		? { duration: 0 }
		: { duration: 0.18, ease: "easeOut" as const };
	const wasDetailsOpen = useRef(detailsOpen);

	// Floating details take focus when the user opens them, and hand it back
	// to the Details toggle when they close with focus inside them.
	useEffect(() => {
		const opened = detailsOpen && !wasDetailsOpen.current;
		wasDetailsOpen.current = detailsOpen;
		if (overlayOpen) {
			if (opened) {
				overlayRef.current
					?.querySelector<HTMLElement>("#desk-details")
					?.focus({ preventScroll: true });
			}
			return;
		}
		if (!focusInOverlay.current) {
			return;
		}
		focusInOverlay.current = false;
		const active = document.activeElement;
		if (!active || active === document.body) {
			mainRef.current
				?.querySelector<HTMLElement>("[data-testid='desk-details-toggle']")
				?.focus({ preventScroll: true });
		}
	}, [detailsOpen, overlayOpen]);

	const onOverlayBlur = (event: FocusEvent<HTMLDivElement>) => {
		// A null relatedTarget is focus lost to removal: keep the flag so the
		// effect above can return focus to the toggle.
		const next = event.relatedTarget;
		if (next instanceof Node && !event.currentTarget.contains(next)) {
			focusInOverlay.current = false;
		}
	};

	// Esc closes the details overlay first, then the conversation, unless the
	// host's chat already used it or the user is typing a reply.
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			isEditableTarget(event.target)
		) {
			return;
		}
		event.preventDefault();
		if (overlayOpen) {
			onCloseDetails();
			return;
		}
		onClose();
	};
	return (
		<section
			aria-label={row ? `Conversation: ${row.title}` : "New conversation"}
			className="@container/conv relative flex min-h-0 min-w-0 flex-1 outline-none"
			data-testid="desk-conversation"
			onKeyDown={onKeyDown}
			ref={ref}
			tabIndex={-1}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col" ref={mainRef}>
				<ConversationHeader
					detailsInline={Boolean(details) && !detailsOverlay}
					detailsOpen={detailsOpen}
					newTargetLabel={newTargetLabel}
					onClose={onClose}
					onToggleDetails={onToggleDetails}
					row={row}
					stacked={stacked}
				/>
				<div
					className="min-h-0 flex-1 overflow-hidden"
					data-testid="desk-thread-view"
				>
					{threadView}
				</div>
			</div>
			{overlayOpen ? (
				<motion.div
					animate={{ opacity: 1, x: 0 }}
					className="absolute top-14 right-0 bottom-0 z-20 flex max-w-full shadow-lg"
					initial={reduceMotion ? false : { opacity: 0, x: 16 }}
					onBlur={onOverlayBlur}
					onFocus={() => {
						focusInOverlay.current = true;
					}}
					ref={overlayRef}
					transition={transition}
				>
					{details}
				</motion.div>
			) : null}
			{details && !detailsOverlay ? (
				<motion.div
					animate={{ width: 300 }}
					className="flex shrink-0 overflow-hidden"
					initial={reduceMotion ? false : { width: 0 }}
					transition={transition}
				>
					{details}
				</motion.div>
			) : null}
		</section>
	);
}

/** Needs-you threads the empty conversation pane can point at. */
export interface DeskNeedsYouHint {
	/** How many need you; zero when none do anywhere. */
	count: number;
	/** "view" when they are in the list on screen, else in other views. */
	scope: "elsewhere" | "view";
}

function needsYouPhrase(count: number): string {
	return `${pluralize(count, "conversation")} need${count === 1 ? "s" : ""} you`;
}

/** The empty pane's quieter second line: what to do next. */
function noSelectionDetail(empty: boolean, hint: DeskNeedsYouHint): string {
	if (empty) {
		return "Conversations with your agents are listed here.";
	}
	if (hint.scope !== "view" && hint.count > 0) {
		return "Nothing in this view is waiting on you.";
	}
	return "Move with J and K, open with Enter.";
}

/** The empty pane's one line of guidance. */
function noSelectionCopy(
	empty: boolean,
	hint: DeskNeedsYouHint,
	viewLabel: string | null
): string {
	if (empty) {
		return "Start a conversation with any agent";
	}
	if (hint.scope === "view" && hint.count > 0) {
		return viewLabel
			? `${needsYouPhrase(hint.count)} in ${viewLabel}`
			: needsYouPhrase(hint.count);
	}
	if (hint.count > 0) {
		return `${hint.count} need${hint.count === 1 ? "s" : ""} you in other views`;
	}
	return "Select a conversation to read it";
}

/** Statuses the queue overview counts, most urgent first. */
const QUEUE_STATUSES: readonly ThreadStatus[] = [
	"attention",
	"your-turn",
	"working",
	"waiting",
];

/** One count in the queue overview: glyph, number, and status. */
function QueueStat({ count, status }: { count: number; status: ThreadStatus }) {
	return (
		<li className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground">
			<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<DeskStatusIcon status={status} />
				{THREAD_STATUS_LABELS[status]}
			</span>
			<span
				className={cn(
					"font-semibold text-2xl tabular-nums leading-7",
					count === 0 ? "text-muted-foreground" : "text-foreground"
				)}
			>
				{count}
			</span>
		</li>
	);
}

/** The next conversation that needs the user, as a card with its last message. */
function NextUpCard({
	now,
	onOpenNext,
	row,
}: {
	now: number;
	onOpenNext: () => void;
	row: DeskRow;
}) {
	const age = compactAge(row.thread.updatedAt, now);
	return (
		<article
			aria-label={`Next up: ${row.title}`}
			className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground"
		>
			<header className="flex items-center gap-3">
				<DeskAvatar agent={row.lead} size={36} />
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-semibold text-base text-foreground">
						{row.title}
					</span>
					<span className="truncate text-muted-foreground text-sm">
						{row.actorLabel}
						{row.group ? ` · ${row.group.name}` : ""}
					</span>
				</div>
				<DeskStatusPill status={row.status} />
			</header>
			<p className="line-clamp-4 text-foreground/80 text-sm leading-6">
				{row.preview}
			</p>
			<footer className="flex items-center gap-3">
				<Button onClick={onOpenNext} size="sm">
					Open next
				</Button>
				<span className="text-muted-foreground text-xs tabular-nums">
					{pluralize(row.thread.messageCount, "message")}
					{age ? ` · updated ${age} ago` : ""}
				</span>
			</footer>
		</article>
	);
}

/**
 * The conversation pane with nothing open. With work waiting it is the
 * queue at a glance, the way a help desk opens on its queue: counts by
 * status and the next conversation that needs the user, ready to open.
 * Otherwise it is one line and the next step.
 */
export function DeskNoSelection({
	empty,
	needsYou,
	nextRow,
	now,
	onOpenNext,
	onShowNeedsYou,
	onStart,
	startLabel,
	statusCounts,
	viewLabel,
}: {
	empty: boolean;
	needsYou: DeskNeedsYouHint;
	/** The first conversation in this view that needs the user, if any. */
	nextRow: DeskRow | null;
	now: number;
	/** Opens the first conversation in this view that needs you. */
	onOpenNext: () => void;
	/** Switches the list to the Needs-you view. */
	onShowNeedsYou: () => void;
	onStart: () => void;
	startLabel: string;
	/** How many conversations, across every view, are in each status. */
	statusCounts: Readonly<Record<ThreadStatus, number>>;
	/** The scoped view's name, or null for the all and Needs-you views. */
	viewLabel: string | null;
}) {
	const hasHint = !empty && needsYou.count > 0;
	if (hasHint && needsYou.scope === "view" && nextRow) {
		return (
			<div
				className="@container h-full w-full overflow-y-auto"
				data-testid="desk-no-selection"
			>
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 @min-[900px]:pt-16 pt-12 pb-8">
					<div className="flex flex-col gap-1">
						<h2 className="text-balance font-semibold text-foreground text-xl tracking-tight">
							{noSelectionCopy(empty, needsYou, viewLabel)}
						</h2>
						<p className="text-muted-foreground text-sm">
							{noSelectionDetail(empty, needsYou)}
						</p>
					</div>
					<section
						aria-labelledby="desk-queue-heading"
						className="flex flex-col gap-2"
					>
						<h3
							className="font-medium text-muted-foreground text-xs"
							id="desk-queue-heading"
						>
							All conversations
						</h3>
						<ul className="grid @min-[560px]:grid-cols-4 grid-cols-2 gap-3">
							{QUEUE_STATUSES.map((status) => (
								<QueueStat
									count={statusCounts[status]}
									key={status}
									status={status}
								/>
							))}
						</ul>
					</section>
					<section aria-label="Next up" className="flex flex-col gap-2">
						<h3 className="font-medium text-muted-foreground text-xs">
							Next up
						</h3>
						<NextUpCard now={now} onOpenNext={onOpenNext} row={nextRow} />
					</section>
				</div>
			</div>
		);
	}
	let action: ReactNode = null;
	if (empty) {
		action = (
			<Button onClick={onStart} size="sm" variant="outline">
				<SquarePen aria-hidden="true" data-icon="inline-start" />
				{startLabel}
			</Button>
		);
	} else if (hasHint && needsYou.scope === "view") {
		action = (
			<Button onClick={onOpenNext} size="sm" variant="outline">
				Open next
			</Button>
		);
	} else if (hasHint) {
		action = (
			<Button onClick={onShowNeedsYou} size="sm" variant="outline">
				Go to Needs you
			</Button>
		);
	}
	return (
		<div
			className="grid h-full w-full grid-rows-[2fr_auto_3fr] p-6"
			data-testid="desk-no-selection"
		>
			{/* Sits at about 40% height, where the eye lands, not dead centre. */}
			<div className="row-start-2 flex flex-col items-center gap-4 text-center">
				<Inbox aria-hidden="true" className="size-5 text-muted-foreground" />
				<div className="flex flex-col gap-1">
					<p className="font-medium text-foreground text-sm">
						{noSelectionCopy(empty, needsYou, viewLabel)}
					</p>
					<p className="text-muted-foreground text-sm">
						{noSelectionDetail(empty, needsYou)}
					</p>
				</div>
				{action}
			</div>
		</div>
	);
}
