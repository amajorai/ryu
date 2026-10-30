import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Inbox, SquarePen } from "lucide-react";
import type { ReactNode } from "react";
import { DeskAvatar } from "./desk-avatar.tsx";
import { type DeskRow, pluralize } from "./desk-model.ts";
import { DeskStatusIcon, DeskStatusPill } from "./desk-status.tsx";
import { compactAge } from "./interface-renderer.ts";

/** Needs-you threads the empty conversation pane can point at. */
export interface DeskNeedsYouHint {
	/** How many need you; zero when none do anywhere. */
	count: number;
	/** "view" when they are in the list on screen, else in other views. */
	scope: "elsewhere" | "view";
}

function needsYouPhrase(count: number, tl: LiteralMessage): string {
	return tl(
		"{count, plural, one {{countLabel} conversation needs you} other {{countLabel} conversations need you}}",
		{ count, countLabel: String(count) }
	);
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
	viewLabel: string | null,
	tl: LiteralMessage
): string {
	if (empty) {
		return "Start a conversation with any agent";
	}
	if (hint.scope === "view" && hint.count > 0) {
		return viewLabel
			? `${needsYouPhrase(hint.count, tl)} in ${viewLabel}`
			: needsYouPhrase(hint.count, tl);
	}
	if (hint.count > 0) {
		return tl(
			"{count, plural, one {{countLabel} needs you in other views} other {{countLabel} need you in other views}}",
			{ count: hint.count, countLabel: String(hint.count) }
		);
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
	const tl = useLiteralMessages();
	const age = compactAge(row.thread.updatedAt, now);
	return (
		<article
			aria-label={tl("Next up: {title}", { title: row.title })}
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
					{age ? ` ${tl("· updated {age} ago", { age })}` : ""}
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
	const tl = useLiteralMessages();
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
							{noSelectionCopy(empty, needsYou, viewLabel, tl)}
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
						{noSelectionCopy(empty, needsYou, viewLabel, tl)}
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
