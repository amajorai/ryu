import { Button } from "@ryu/ui/components/button.tsx";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	MessageCircle,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import {
	RECORDS_OBJECT_LABELS,
	type RecordsRow,
	recordsPlural,
} from "./records-model.ts";
import { RECORDS_OBJECT_ICONS } from "./records-nav.tsx";
import { RecordsActivity, UPCOMING_LIMIT } from "./records-page-activity.tsx";
import {
	RecordsAttributes,
	type RecordsRelatedTarget,
} from "./records-page-attributes.tsx";
import { RecordsMark } from "./records-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export {
	RecordsAttributes,
	type RecordsRelatedTarget,
} from "./records-page-attributes.tsx";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * A record page: breadcrumb and record stepping on top, the record's header
 * with its quick action, its activity timeline, and the attributes panel on
 * the right (or inline above the activity at narrow widths). An open thread
 * takes the right column so the record stays in view beside the chat.
 */
export function RecordsPage({
	activeThreadId,
	detailsColumns,
	detailsInline,
	headingRef,
	now,
	onBack,
	onMessage,
	onNext,
	onOpenRecord,
	onOpenThread,
	onPrevious,
	position,
	row,
	side,
	snapshot,
}: {
	activeThreadId: string | null;
	/** Columns for the attributes when they sit inside the main column. */
	detailsColumns: 1 | 2;
	/** True when the page is too narrow for the attributes panel. */
	detailsInline: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	now: number;
	onBack: () => void;
	onMessage: () => void;
	onNext: (() => void) | null;
	onOpenRecord: (target: RecordsRelatedTarget) => void;
	onOpenThread: (threadId: string) => void;
	onPrevious: (() => void) | null;
	position: { index: number; total: number } | null;
	row: RecordsRow;
	/** The right column: the open thread, or null to show the attributes. */
	side: ReactNode | null;
	snapshot: InterfaceSnapshot;
}) {
	const reduceMotion = useReducedMotion();
	const ObjectIcon = RECORDS_OBJECT_ICONS[row.object];
	const objectLabel = RECORDS_OBJECT_LABELS[row.object].plural;
	// An open thread takes the right column, so the attributes move inline
	// rather than disappear.
	const inline = side !== null || detailsInline;
	const activityCount =
		row.threads.length +
		row.runs.length +
		Math.min(row.upcoming.length, UPCOMING_LIMIT);
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-testid="records-page"
			initial={reduceMotion ? false : { opacity: 0 }}
			key={row.id}
			transition={{ duration: 0.14 }}
		>
			<header className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-4">
				<nav aria-label="Breadcrumb" className="min-w-0 flex-1">
					<ol className="flex min-w-0 items-center gap-1 text-sm">
						<li className="flex shrink-0">
							<button
								className="-ms-2 flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onClick={onBack}
								title="Back to the table (Esc)"
								type="button"
							>
								<ObjectIcon aria-hidden="true" className="size-4" />
								{objectLabel}
							</button>
						</li>
						<li aria-hidden="true" className="flex text-muted-foreground">
							<ChevronRight className="size-3.5" />
						</li>
						<li
							aria-current="page"
							className="flex min-w-0 items-center gap-2 px-1 font-medium text-foreground"
						>
							<span className="truncate">{row.name}</span>
						</li>
					</ol>
				</nav>
				{position ? (
					<div className="flex shrink-0 items-center gap-1">
						<span className="me-1 text-muted-foreground text-xs tabular-nums max-sm:hidden">
							{position.index + 1} of {position.total}
						</span>
						<Button
							aria-keyshortcuts="K"
							aria-label="Previous record"
							disabled={onPrevious === null}
							onClick={onPrevious ?? undefined}
							size="icon-sm"
							title="Previous record (K)"
							type="button"
							variant="ghost"
						>
							<ChevronUp aria-hidden="true" />
						</Button>
						<Button
							aria-keyshortcuts="J"
							aria-label="Next record"
							disabled={onNext === null}
							onClick={onNext ?? undefined}
							size="icon-sm"
							title="Next record (J)"
							type="button"
							variant="ghost"
						>
							<ChevronDown aria-hidden="true" />
						</Button>
					</div>
				) : null}
			</header>
			<div className="relative flex min-h-0 flex-1">
				<div className="min-w-0 flex-1 overflow-y-auto">
					<div className="flex w-full max-w-[880px] flex-col gap-8 px-6 pt-6 pb-12 max-sm:px-4">
						<div className="flex items-start gap-4 max-sm:flex-col">
							<RecordsMark agent={row.agent} name={row.name} size={40} />
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<h2
									className="truncate text-foreground text-xl leading-7 outline-none"
									ref={headingRef}
									tabIndex={-1}
								>
									<span className="font-semibold">{row.name}</span>
								</h2>
								<p className="text-muted-foreground text-sm leading-5">
									{row.object === "agents"
										? row.description || "No description"
										: `${RECORDS_OBJECT_LABELS[row.object].singular} · ${recordsPlural(row.members.length, "member")}`}
								</p>
							</div>
							<Button
								className="shrink-0"
								onClick={onMessage}
								size="sm"
								type="button"
							>
								<MessageCircle aria-hidden="true" data-icon="inline-start" />
								Message
							</Button>
						</div>
						{inline ? (
							<section aria-labelledby="records-details-inline">
								<h3
									className="mb-2 text-foreground text-sm leading-5"
									id="records-details-inline"
								>
									<span className="font-semibold">Details</span>
								</h3>
								<RecordsAttributes
									columns={detailsColumns}
									now={now}
									onOpenRecord={onOpenRecord}
									row={row}
								/>
							</section>
						) : null}
						<section aria-labelledby="records-activity">
							<div className="mb-3 flex items-baseline gap-2">
								<h3
									className="text-foreground text-sm leading-5"
									id="records-activity"
								>
									<span className="font-semibold">Activity</span>
								</h3>
								<span className="text-muted-foreground text-sm tabular-nums">
									{activityCount}
								</span>
							</div>
							<RecordsActivity
								activeThreadId={activeThreadId}
								now={now}
								onMessage={onMessage}
								onOpenThread={onOpenThread}
								row={row}
								snapshot={snapshot}
							/>
						</section>
					</div>
				</div>
				{side ??
					(inline ? null : (
						<aside
							aria-labelledby="records-details"
							className="flex w-80 shrink-0 flex-col overflow-y-auto border-border border-l"
						>
							<h3
								className="flex h-11 shrink-0 items-center border-border border-b px-4 text-foreground text-sm"
								id="records-details"
							>
								<span className="font-semibold">Details</span>
							</h3>
							<div className="px-4 py-2">
								<RecordsAttributes
									now={now}
									onOpenRecord={onOpenRecord}
									row={row}
								/>
							</div>
						</aside>
					))}
			</div>
		</motion.div>
	);
}
