import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import {
	type Ticket,
	type TicketSection,
	type TicketSort,
	type TicketSortKey,
	ticketCountLabel,
	ticketFullTime,
	ticketStatusHint,
} from "./tickets-model.ts";
import {
	TicketAvatar,
	TicketNumber,
	TicketPriorityLabel,
	TicketSlaChip,
	TicketStatusPill,
	TicketTime,
} from "./tickets-parts.tsx";

/** Which columns fit: all of them, fewer, or a two-line mobile row. */
export type TicketsTableLayout = "compact" | "full" | "medium" | "narrow";

type ColumnId =
	| "assignee"
	| "number"
	| "priority"
	| "requester"
	| "sla"
	| "status"
	| "subject"
	| "updated";

interface Column {
	id: ColumnId;
	label: string;
	sortKey?: TicketSortKey;
	/** Fixed width in px; the subject takes what is left. */
	width?: number;
}

const COLUMNS: Record<ColumnId, Column> = {
	assignee: { id: "assignee", label: "Assignee", width: 112 },
	number: { id: "number", label: "ID", sortKey: "number", width: 76 },
	priority: {
		id: "priority",
		label: "Priority",
		sortKey: "priority",
		width: 92,
	},
	requester: {
		id: "requester",
		label: "Requester",
		sortKey: "requester",
		width: 160,
	},
	sla: { id: "sla", label: "Next SLA", sortKey: "sla", width: 96 },
	status: { id: "status", label: "Status", sortKey: "status", width: 96 },
	subject: { id: "subject", label: "Subject", sortKey: "subject" },
	updated: { id: "updated", label: "Updated", sortKey: "updated", width: 136 },
};

const LAYOUT_COLUMNS: Record<TicketsTableLayout, ColumnId[]> = {
	compact: ["subject", "updated"],
	full: [
		"status",
		"number",
		"subject",
		"requester",
		"priority",
		"sla",
		"updated",
		"assignee",
	],
	medium: [
		"status",
		"number",
		"subject",
		"requester",
		"priority",
		"sla",
		"updated",
	],
	narrow: ["status", "subject", "requester", "sla", "updated"],
};

const CHECK_WIDTH = 44;

/**
 * The shared checkbox draws its tick for the mixed state too; a partial
 * selection shows a dash instead, the way list headers mark it.
 */
const INDETERMINATE =
	"before:absolute before:hidden before:h-0.5 before:w-2 before:rounded-full before:bg-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:before:block data-indeterminate:[&_svg]:hidden";

function SortHeader({
	column,
	onSort,
	sort,
}: {
	column: Column;
	onSort: (key: TicketSortKey) => void;
	sort: TicketSort;
}) {
	const { sortKey } = column;
	if (!sortKey) {
		return <span>{column.label}</span>;
	}
	const active = sort.key === sortKey;
	const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
	return (
		<button
			className={cn(
				"-mx-1 inline-flex h-6 items-center gap-1 rounded-sm px-1 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				active && "text-foreground"
			)}
			onClick={() => onSort(sortKey)}
			type="button"
		>
			{column.label}
			{active ? (
				<Arrow aria-hidden="true" className="size-3" />
			) : (
				<span aria-hidden="true" className="size-3" />
			)}
		</button>
	);
}

function ariaSort(
	column: Column,
	sort: TicketSort
): "ascending" | "descending" | undefined {
	if (!column.sortKey || column.sortKey !== sort.key) {
		return;
	}
	return sort.direction === "asc" ? "ascending" : "descending";
}

function RequesterCell({ ticket }: { ticket: Ticket }) {
	if (!ticket.requester) {
		return <span className="text-muted-foreground">No requester</span>;
	}
	return (
		<span className="flex min-w-0 items-center gap-2">
			<TicketAvatar agent={ticket.requester} size={20} />
			<span className="truncate">{ticket.requester.name}</span>
			{ticket.ccs.length > 0 ? (
				<span
					className="shrink-0 text-muted-foreground text-xs tabular-nums"
					title={`CC: ${ticket.ccs.map((agent) => agent.name).join(", ")}`}
				>
					+{ticket.ccs.length}
				</span>
			) : null}
		</span>
	);
}

function cellFor(
	id: ColumnId,
	ticket: Ticket,
	now: number,
	subject: ReactNode,
	layout: TicketsTableLayout
): ReactNode {
	switch (id) {
		case "assignee":
			return <span className="text-muted-foreground">You</span>;
		case "number":
			return (
				<TicketNumber
					className="text-muted-foreground"
					number={ticket.number}
				/>
			);
		case "priority":
			return <TicketPriorityLabel priority={ticket.priority} />;
		case "requester":
			return <RequesterCell ticket={ticket} />;
		case "sla":
			return ticket.sla ? <TicketSlaChip sla={ticket.sla} /> : null;
		case "status":
			return (
				<TicketStatusPill
					hint={ticketStatusHint(ticket)}
					status={ticket.status}
				/>
			);
		case "subject":
			return subject;
		default:
			return layout === "compact" ? (
				<time
					className="block text-right text-muted-foreground text-xs tabular-nums"
					dateTime={ticket.thread.updatedAt}
					title={ticketFullTime(ticket.updatedAt)}
				>
					{compactAge(ticket.thread.updatedAt, now)}
				</time>
			) : (
				<TicketTime
					at={ticket.updatedAt}
					className="text-muted-foreground"
					now={now}
				/>
			);
	}
}

/** The compact (phone) row's subject block: subject over its key facts. */
function CompactSubject({
	button,
	ticket,
}: {
	button: ReactNode;
	ticket: Ticket;
}) {
	return (
		<span className="flex min-w-0 flex-col gap-1">
			{button}
			<span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
				<TicketStatusPill
					hint={ticketStatusHint(ticket)}
					status={ticket.status}
				/>
				<TicketNumber number={ticket.number} />
				<span className="truncate">
					{ticket.requester?.name ?? "No requester"}
				</span>
				{ticket.sla ? <TicketSlaChip sla={ticket.sla} /> : null}
			</span>
		</span>
	);
}

function TicketRow({
	columns,
	cursor,
	layout,
	now,
	onFocusRow,
	onOpen,
	onToggle,
	open,
	registerRow,
	selected,
	ticket,
}: {
	columns: Column[];
	cursor: boolean;
	layout: TicketsTableLayout;
	now: number;
	onFocusRow: (ticketId: string) => void;
	onOpen: (ticketId: string) => void;
	onToggle: (ticketId: string) => void;
	open: boolean;
	registerRow: (ticketId: string, element: HTMLElement | null) => void;
	selected: boolean;
	ticket: Ticket;
}) {
	const subjectButton = (
		<button
			aria-current={open ? "true" : undefined}
			className="block min-w-0 max-w-full truncate text-left font-medium text-foreground outline-none"
			data-testid={`tickets-row-${ticket.id}`}
			onClick={(event) => {
				event.stopPropagation();
				onOpen(ticket.id);
			}}
			onFocus={() => onFocusRow(ticket.id)}
			ref={(element) => registerRow(ticket.id, element)}
			tabIndex={cursor ? 0 : -1}
			title={ticket.thread.lastMessage ?? undefined}
			type="button"
		>
			{ticket.thread.title || "Untitled ticket"}
		</button>
	);
	const subject =
		layout === "compact" ? (
			<CompactSubject button={subjectButton} ticket={ticket} />
		) : (
			subjectButton
		);
	return (
		<tr
			className={cn(
				"group/row cursor-pointer transition-colors hover:bg-muted/60",
				cursor && "group-focus-within/table:bg-muted/60",
				selected &&
					"bg-primary/10 hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20",
				selected &&
					cursor &&
					"group-focus-within/table:bg-primary/15 dark:group-focus-within/table:bg-primary/20",
				layout === "compact" ? "h-16" : "h-10"
			)}
			data-cursor={cursor ? "true" : undefined}
			data-selected={selected ? "true" : undefined}
			data-status={ticket.status}
			onClick={() => onOpen(ticket.id)}
		>
			<td
				className="relative border-border border-b ps-4 pe-0 align-middle"
				style={{ width: CHECK_WIDTH }}
			>
				<span
					aria-hidden="true"
					className={cn(
						"absolute inset-y-0 left-0 w-0.5 bg-primary opacity-0 transition-opacity",
						cursor && "group-focus-within/table:opacity-100"
					)}
				/>
				{/* The cell swallows clicks so checking a ticket never opens it. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: click guard around the checkbox */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox inside handles keys */}
				<span
					className="flex items-center"
					onClick={(event) => event.stopPropagation()}
				>
					<Checkbox
						aria-label={`Select ticket #${ticket.number}`}
						checked={selected}
						onCheckedChange={() => {
							onFocusRow(ticket.id);
							onToggle(ticket.id);
						}}
						tabIndex={-1}
					/>
				</span>
			</td>
			{columns.map((column) => (
				<td
					className={cn(
						"border-border border-b px-3 align-middle text-[13px]",
						column.id === "subject" && "max-w-0"
					)}
					key={column.id}
				>
					{cellFor(column.id, ticket, now, subject, layout)}
				</td>
			))}
		</tr>
	);
}

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const SKELETON_SUBJECT = ["w-3/5", "w-2/5", "w-1/2", "w-2/3"];

function SkeletonRows({ columns }: { columns: Column[] }) {
	return (
		<>
			{SKELETON_ROWS.map((key, index) => (
				<tr className="h-10" key={key}>
					<td
						className="border-border border-b ps-4"
						style={{ width: CHECK_WIDTH }}
					>
						<Skeleton className="size-4" radius="dense" />
					</td>
					{columns.map((column) => (
						<td className="border-border border-b px-3" key={column.id}>
							<Skeleton
								className={cn(
									"h-3",
									column.id === "subject"
										? SKELETON_SUBJECT[index % SKELETON_SUBJECT.length]
										: "w-3/5"
								)}
								radius="pill"
							/>
						</td>
					))}
				</tr>
			))}
		</>
	);
}

/** What an empty view, a filter with no matches, or a fresh install says. */
export function TicketsEmpty({
	action,
	description,
	title,
}: {
	action: { label: string; onClick: () => void } | null;
	description: string;
	title: string;
}) {
	return (
		<Empty className="flex-1 rounded-none" data-testid="tickets-empty">
			<EmptyHeader>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{action ? (
				<EmptyContent>
					<Button
						onClick={action.onClick}
						size="sm"
						type="button"
						variant="outline"
					>
						<Plus aria-hidden="true" data-icon="inline-start" />
						{action.label}
					</Button>
				</EmptyContent>
			) : null}
		</Empty>
	);
}

/**
 * The ticket table: a checkbox column, sortable headers, and status (or
 * priority) group rows, the way a Zendesk view lists tickets.
 */
export function TicketsTable({
	activeTicketId,
	allSelected,
	cursorId,
	layout,
	loading,
	now,
	onFocusRow,
	onOpen,
	onSort,
	onToggle,
	onToggleAll,
	registerRow,
	sections,
	selectedIds,
	someSelected,
	sort,
	viewLabel,
}: {
	activeTicketId: string | null;
	allSelected: boolean;
	cursorId: string | null;
	layout: TicketsTableLayout;
	loading: boolean;
	now: number;
	onFocusRow: (ticketId: string) => void;
	onOpen: (ticketId: string) => void;
	onSort: (key: TicketSortKey) => void;
	onToggle: (ticketId: string) => void;
	onToggleAll: () => void;
	registerRow: (ticketId: string, element: HTMLElement | null) => void;
	sections: TicketSection[];
	selectedIds: ReadonlySet<string>;
	someSelected: boolean;
	sort: TicketSort;
	viewLabel: string;
}) {
	const columns = LAYOUT_COLUMNS[layout].map((id) =>
		layout === "compact" && id === "updated"
			? { ...COLUMNS.updated, width: 64 }
			: COLUMNS[id]
	);
	const span = columns.length + 1;
	const showHead = layout !== "compact";
	return (
		<table
			aria-label={viewLabel}
			className="group/table w-full table-fixed border-separate border-spacing-0 text-sm"
			data-layout={layout}
			data-testid="tickets-table"
		>
			<colgroup>
				<col style={{ width: CHECK_WIDTH }} />
				{columns.map((column) => (
					<col
						key={column.id}
						style={column.width ? { width: column.width } : undefined}
					/>
				))}
			</colgroup>
			<thead className={showHead ? undefined : "sr-only"}>
				<tr className="h-9">
					<th
						className="sticky top-0 z-10 border-border border-b bg-background ps-4 pe-0 text-left font-normal"
						scope="col"
					>
						<Checkbox
							aria-label="Select all tickets in view"
							checked={allSelected}
							className={INDETERMINATE}
							disabled={loading || sections.length === 0}
							indeterminate={someSelected && !allSelected}
							onCheckedChange={onToggleAll}
						/>
					</th>
					{columns.map((column) => (
						<th
							aria-sort={ariaSort(column, sort)}
							className="sticky top-0 z-10 border-border border-b bg-background px-3 text-left font-medium text-muted-foreground text-xs"
							key={column.id}
							scope="col"
						>
							<SortHeader column={column} onSort={onSort} sort={sort} />
						</th>
					))}
				</tr>
			</thead>
			{loading ? (
				<tbody aria-busy="true">
					<SkeletonRows columns={columns} />
				</tbody>
			) : (
				sections.map((section) => (
					<tbody data-section={section.id} key={section.id}>
						{section.label ? (
							<tr className="h-9">
								<th
									className="border-border border-b bg-muted/40 px-4 text-left font-semibold text-foreground text-xs"
									colSpan={span}
									scope="colgroup"
								>
									{section.label}
									<span className="ms-2 font-normal text-muted-foreground tabular-nums">
										<span className="sr-only">, </span>
										{ticketCountLabel(section.tickets.length)}
									</span>
								</th>
							</tr>
						) : null}
						{section.tickets.map((ticket) => (
							<TicketRow
								columns={columns}
								cursor={ticket.id === cursorId}
								key={ticket.id}
								layout={layout}
								now={now}
								onFocusRow={onFocusRow}
								onOpen={onOpen}
								onToggle={onToggle}
								open={ticket.id === activeTicketId}
								registerRow={registerRow}
								selected={selectedIds.has(ticket.id)}
								ticket={ticket}
							/>
						))}
					</tbody>
				))
			)}
		</table>
	);
}
