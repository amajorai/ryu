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
import {
	type TicketSection,
	type TicketSort,
	type TicketSortKey,
	ticketCountLabel,
} from "./tickets-model.ts";
import {
	CHECK_WIDTH,
	COLUMNS,
	type Column,
	LAYOUT_COLUMNS,
	type TicketsTableLayout,
} from "./tickets-table-columns.ts";
import { TicketRow } from "./tickets-table-row.tsx";

export type { TicketsTableLayout } from "./tickets-table-columns.ts";

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
