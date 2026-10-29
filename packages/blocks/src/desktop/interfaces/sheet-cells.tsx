import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { Check } from "lucide-react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import {
	type SheetRow,
	sheetAbsoluteTime,
	sheetRelativeTime,
	sheetSnippet,
	splitMatches,
} from "./sheet-model.ts";

/**
 * Status options share one shape, a flat lozenge like a single-select field.
 * Only the two states that ask for something carry a tint (failures and "your
 * turn"); "Working" stays neutral and is marked by its spinner alone, so it
 * never reads as "your turn" in themes whose primary is the success green.
 */
const PILL_TONE: Record<ThreadStatus, string> = {
	attention: "bg-destructive/12 text-foreground",
	quiet: "bg-foreground/6 text-muted-foreground",
	waiting: "bg-foreground/6 text-foreground/85",
	working: "bg-foreground/6 text-foreground",
	"your-turn": "bg-primary/14 text-foreground",
};

/**
 * The status mark: the shared Board dot, except "Working", which is a spinner
 * (a faint full track under a solid arc, static under reduced motion) so live
 * runs stand apart by shape even in a still frame.
 */
export function SheetStatusMark({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	if (status === "working") {
		return (
			<span
				aria-hidden="true"
				className={cn(
					className,
					"inline-block size-2.5 shrink-0 rounded-full border-2 border-success/25 border-t-success border-r-success motion-safe:animate-spin motion-safe:[animation-duration:1.4s]"
				)}
			/>
		);
	}
	return <BoardStatusDot className={className} status={status} />;
}

/** A single-select style status lozenge, the way a grid tool shows options. */
export function SheetStatusPill({ status }: { status: ThreadStatus }) {
	return (
		<span
			className={cn(
				"inline-flex h-5.5 max-w-full items-center gap-1.5 rounded-full px-2 text-xs",
				PILL_TONE[status]
			)}
		>
			<SheetStatusMark className="size-2" status={status} />
			<span className="truncate">{THREAD_STATUS_LABELS[status]}</span>
		</span>
	);
}

/** Segment fills for the share bar, in the same hues as the status marks. */
const SHARE_FILL: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-foreground/15",
	waiting: "bg-foreground/35",
	working: "bg-success/55",
	"your-turn": "bg-primary",
};

/**
 * A single-select field's "percent by option" summary: one thin bar split by
 * status in the sheet's status order, with the counts in its tooltip and name.
 */
export function SheetStatusShare({
	counts,
}: {
	counts: Record<ThreadStatus, number>;
}) {
	const tl = useLiteralMessages();
	const present = THREAD_STATUS_ORDER.filter((status) => counts[status] > 0);
	const total = present.reduce((sum, status) => sum + counts[status], 0);
	if (total === 0) {
		return null;
	}
	const label = present
		.map((status) => `${counts[status]} ${THREAD_STATUS_LABELS[status]}`)
		.join(", ");
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={tl("Status: {statusSummary}", { statusSummary: label })}
						className="flex h-full w-full items-center"
						role="img"
					/>
				}
			>
				<span className="flex h-1.5 w-full gap-px overflow-hidden rounded-full">
					{present.map((status) => (
						<span
							className={cn("h-full", SHARE_FILL[status])}
							key={status}
							style={{ flexGrow: counts[status], flexBasis: 0 }}
						/>
					))}
				</span>
			</TooltipTrigger>
			<TooltipContent side="top">
				<span className="flex flex-col gap-1">
					{present.map((status) => (
						<span className="flex items-center gap-2" key={status}>
							<SheetStatusMark className="size-2" status={status} />
							<span className="flex-1">{THREAD_STATUS_LABELS[status]}</span>
							<span className="tabular-nums">{counts[status]}</span>
						</span>
					))}
				</span>
			</TooltipContent>
		</Tooltip>
	);
}

/** Text with the search query's words marked, for Title and Last message. */
export function SheetHighlight({
	query,
	text,
}: {
	query: string;
	text: string;
}) {
	const segments = splitMatches(text, query);
	if (segments.length === 1 && !segments[0]?.match) {
		return <>{text}</>;
	}
	let offset = 0;
	return (
		<>
			{segments.map((segment) => {
				const key = `${offset}:${segment.text.length}`;
				offset += segment.text.length;
				return segment.match ? (
					<mark className="rounded-xs bg-warning/30 text-inherit" key={key}>
						{segment.text}
					</mark>
				) : (
					<span key={key}>{segment.text}</span>
				);
			})}
		</>
	);
}

const STACK_LIMIT = 3;

/** The agent to name first: the one the search matched, else the lead agent. */
function leadAgent(agents: InterfaceAgent[], query: string): InterfaceAgent {
	const lead =
		agents.find((agent) =>
			splitMatches(agent.name, query).some((segment) => segment.match)
		) ?? agents[0];
	if (!lead) {
		throw new Error("leadAgent needs at least one agent");
	}
	return lead;
}

/**
 * Overlapping faces plus the lead name and a plain "+n" count, like a linked
 * collaborator field; the full list is in the tooltip and for screen readers.
 * When the column is dragged narrow, a container query drops the name and the
 * stack keeps only an overflow count, so nothing clips mid-chip.
 */
export function SheetAgents({
	agents,
	query,
}: {
	agents: InterfaceAgent[];
	query: string;
}) {
	if (agents.length === 0) {
		return <SheetBlank label="No agent" />;
	}
	const lead = leadAgent(agents, query);
	const rest = agents.filter((agent) => agent.id !== lead.id);
	const shown = [lead, ...rest].slice(0, STACK_LIMIT);
	const overflow = agents.length - shown.length;
	const names = agents.map((agent) => agent.name).join(", ");
	const content = (
		<>
			<span className="flex shrink-0 -space-x-1.5">
				{shown.map((agent) => (
					<BoardAvatar
						agent={agent}
						className="ring-2 ring-background"
						key={agent.id}
						name={agent.name}
						size={20}
					/>
				))}
			</span>
			<span className="flex @max-[6.5rem]/agents:hidden min-w-0 items-center gap-1">
				<span className="truncate text-foreground/90">
					<SheetHighlight query={query} text={lead.name} />
				</span>
				{rest.length > 0 ? (
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						<span aria-hidden="true">+{rest.length}</span>
						<span className="sr-only">
							{`, ${rest.map((agent) => agent.name).join(", ")}`}
						</span>
					</span>
				) : null}
			</span>
			{overflow > 0 ? (
				<span
					aria-hidden="true"
					className="@max-[6.5rem]/agents:inline hidden shrink-0 text-muted-foreground text-xs tabular-nums"
				>
					+{overflow}
				</span>
			) : null}
		</>
	);
	const row = "flex min-w-0 items-center gap-2";
	return (
		<span className="@container/agents block w-full min-w-0">
			{rest.length === 0 ? (
				<span className={row}>{content}</span>
			) : (
				<Tooltip>
					<TooltipTrigger render={<span className={row} />}>
						{content}
					</TooltipTrigger>
					<TooltipContent side="top">{names}</TooltipContent>
				</Tooltip>
			)}
		</span>
	);
}

/** A linked-record chip for a team or project name. */
export function SheetChip({
	kind,
	name,
	query,
}: {
	kind: "project" | "team";
	name: string | null;
	query: string;
}) {
	if (!name) {
		return <SheetBlank label={kind === "team" ? "No team" : "No project"} />;
	}
	return (
		<span className="inline-flex h-5.5 max-w-full items-center rounded-sm bg-foreground/7 px-1.5 text-foreground text-xs">
			<span className="truncate">
				<SheetHighlight query={query} text={name} />
			</span>
		</span>
	);
}

/** An empty cell: visually blank, but named for screen readers. */
export function SheetBlank({ label }: { label: string }) {
	return <span className="sr-only">{label}</span>;
}

export function SheetLastMessage({
	query,
	row,
}: {
	query: string;
	row: SheetRow;
}) {
	const text = row.thread.lastMessage?.trim();
	if (!text) {
		return <SheetBlank label="No messages" />;
	}
	return (
		<span className="block truncate text-foreground/70">
			{row.thread.lastMessageRole === "user" ? (
				<span className="text-foreground">You: </span>
			) : null}
			<SheetHighlight query={query} text={sheetSnippet(text, query)} />
		</span>
	);
}

/** Relative age with the exact time in a tooltip and on the `<time>` element. */
export function SheetUpdated({ now, row }: { now: number; row: SheetRow }) {
	const absolute = sheetAbsoluteTime(row.updatedAt);
	if (!absolute) {
		return <SheetBlank label="Unknown" />;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<time
						className="truncate text-muted-foreground tabular-nums"
						dateTime={row.thread.updatedAt}
					/>
				}
			>
				{sheetRelativeTime(row.updatedAt, now)}
				<span className="sr-only">, {absolute}</span>
			</TooltipTrigger>
			<TooltipContent side="top">{absolute}</TooltipContent>
		</Tooltip>
	);
}

/** A checkbox field: an empty box, or a filled check when the thread is pinned. */
export function SheetPinned({ pinned }: { pinned: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex size-3.5 items-center justify-center rounded-xs",
				pinned
					? "bg-primary text-primary-foreground"
					: "border border-foreground/20"
			)}
		>
			{pinned ? (
				<Check aria-hidden="true" className="size-2.5" strokeWidth={3} />
			) : null}
			<span className="sr-only">{pinned ? "Pinned" : "Not pinned"}</span>
		</span>
	);
}
