import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	AlignLeft,
	ArrowDown,
	ArrowUp,
	CalendarClock,
	CircleDot,
	Clock3,
	Inbox,
	type LucideIcon,
	MessageSquareText,
	MessagesSquare,
	UserRound,
	UsersRound,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import {
	RECORDS_OBJECT_LABELS,
	type RecordsObject,
	type RecordsRow,
	type RecordsSort,
	type RecordsSortKey,
	recordsFullTime,
	recordsPlural,
	recordsRelativeTime,
	recordsTimeUntil,
} from "./records-model.ts";
import {
	RecordsFaces,
	RecordsMark,
	RecordsRowStatus,
} from "./records-parts.tsx";

interface Column {
	align?: "end";
	cell: (row: RecordsRow, now: number) => ReactNode;
	icon: LucideIcon;
	id: string;
	label: string;
	sortKey?: RecordsSortKey;
	/** Footer calculation over the shown rows, Attio's "Sum" row. */
	sum?: (row: RecordsRow) => number;
	/** Fixed width in px; the last column takes what is left. */
	width: number;
}

function Muted({ children }: { children: ReactNode }) {
	return <span className="text-muted-foreground">{children}</span>;
}

function CountCell({ value }: { value: number }) {
	return value > 0 ? (
		<span className="tabular-nums">{value}</span>
	) : (
		<span className="text-muted-foreground tabular-nums">0</span>
	);
}

function TimeCell({ iso, now }: { iso: string | null; now: number }) {
	const label = recordsRelativeTime(iso, now);
	if (!(label && iso)) {
		return <Muted>Never</Muted>;
	}
	return (
		<time dateTime={iso} title={recordsFullTime(iso)}>
			{label}
		</time>
	);
}

function GroupNames({ groups }: { groups: RecordsRow["teams"] }) {
	if (groups.length === 0) {
		return null;
	}
	return (
		<span className="flex min-w-0 items-center gap-2">
			<RecordsMark agent={null} name={groups[0]?.name ?? ""} size={20} />
			<span className="truncate">
				{groups.map((group) => group.name).join(", ")}
			</span>
		</span>
	);
}

const STATUS: Column = {
	cell: (row) => <RecordsRowStatus row={row} />,
	icon: CircleDot,
	id: "status",
	label: "Status",
	sortKey: "status",
	width: 160,
};
const THREADS: Column = {
	align: "end",
	cell: (row) => <CountCell value={row.threads.length} />,
	icon: MessagesSquare,
	id: "threads",
	label: "Threads",
	sortKey: "threads",
	sum: (row) => row.threads.length,
	width: 104,
};
const NEEDS_YOU: Column = {
	align: "end",
	cell: (row) =>
		row.needsYou > 0 ? (
			<span className="font-medium text-foreground tabular-nums">
				{row.needsYou}
			</span>
		) : (
			<CountCell value={0} />
		),
	icon: Inbox,
	id: "needs-you",
	label: "Needs you",
	sortKey: "needsYou",
	sum: (row) => row.needsYou,
	width: 120,
};
const LAST: Column = {
	cell: (row, now) => <TimeCell iso={row.lastInteraction} now={now} />,
	icon: Clock3,
	id: "last",
	label: "Last interaction",
	sortKey: "lastInteraction",
	width: 160,
};

const NEXT_RUN: Column = {
	cell: (row, now) => {
		const label = recordsTimeUntil(row.nextRun, now);
		const event = row.upcoming[0];
		if (!(label && row.nextRun && event)) {
			return null;
		}
		return (
			<time
				dateTime={row.nextRun}
				title={`${event.title}, ${recordsFullTime(row.nextRun) ?? ""}`}
			>
				{label}
			</time>
		);
	},
	icon: CalendarClock,
	id: "next-run",
	label: "Next run",
	width: 120,
};

const AGENT_COLUMNS: Column[] = [
	STATUS,
	THREADS,
	NEEDS_YOU,
	LAST,
	NEXT_RUN,
	{
		cell: (row) => <GroupNames groups={row.teams} />,
		icon: UsersRound,
		id: "team",
		label: "Team",
		width: 152,
	},
	{
		cell: (row) =>
			row.description ? (
				<span className="truncate text-muted-foreground">
					{row.description}
				</span>
			) : null,
		icon: AlignLeft,
		id: "description",
		label: "Description",
		width: 200,
	},
];

const GROUP_COLUMNS: Column[] = [
	STATUS,
	{
		cell: (row) =>
			row.members.length > 0 ? (
				<span className="flex min-w-0 items-center gap-2">
					<RecordsFaces agents={row.members} limit={3} />
					<span className="truncate">
						{row.members.map((agent) => agent.name).join(", ")}
					</span>
				</span>
			) : null,
		icon: UserRound,
		id: "members",
		label: "Members",
		width: 200,
	},
	THREADS,
	NEEDS_YOU,
	LAST,
	{
		cell: (row) =>
			row.description ? (
				<span className="truncate text-muted-foreground">
					{row.description}
				</span>
			) : null,
		icon: MessageSquareText,
		id: "latest",
		label: "Latest thread",
		width: 288,
	},
];

/** Width of the sticky name column. */
const NAME_WIDTH = 208;

export function recordsColumns(object: RecordsObject): Column[] {
	return object === "agents" ? AGENT_COLUMNS : GROUP_COLUMNS;
}

function SortGlyph({ active, sort }: { active: boolean; sort: RecordsSort }) {
	if (!active) {
		return null;
	}
	const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
	return <Arrow aria-hidden="true" className="size-3 text-foreground" />;
}

function HeaderCell({
	column,
	name,
	onSort,
	sort,
}: {
	column: Pick<Column, "align" | "icon" | "label" | "sortKey">;
	name?: boolean;
	onSort: (key: RecordsSortKey) => void;
	sort: RecordsSort;
}) {
	const { icon: Icon, sortKey } = column;
	const active = sortKey !== undefined && sort.key === sortKey;
	let ariaSort: "ascending" | "descending" | undefined;
	if (active) {
		ariaSort = sort.direction === "asc" ? "ascending" : "descending";
	}
	const content = (
		<>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="truncate">{column.label}</span>
			<SortGlyph active={active} sort={sort} />
		</>
	);
	return (
		<th
			aria-sort={ariaSort}
			className={cn(
				"h-10 border-border border-r border-b bg-background p-0 text-left font-normal last:border-r-0",
				name && "sticky left-0 z-20"
			)}
			scope="col"
		>
			{sortKey ? (
				<button
					className={cn(
						"flex size-full items-center gap-1.5 px-3 text-[13px] outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
						active ? "text-foreground" : "text-muted-foreground",
						column.align === "end" && "justify-end"
					)}
					onClick={() => onSort(sortKey)}
					title={`Sort by ${column.label.toLowerCase()}`}
					type="button"
				>
					{content}
				</button>
			) : (
				<span className="flex items-center gap-1.5 px-3 text-[13px] text-muted-foreground">
					{content}
				</span>
			)}
		</th>
	);
}

/** Footer calculations, Attio-style: a count under the names, sums under numbers. */
function SumRow({
	columns,
	object,
	rows,
}: {
	columns: Column[];
	object: RecordsObject;
	rows: RecordsRow[];
}) {
	const noun = RECORDS_OBJECT_LABELS[object];
	return (
		<tr className="h-10 text-[13px] text-muted-foreground">
			<td className="sticky left-0 z-[1] border-border border-r border-b bg-background px-3">
				{recordsPlural(
					rows.length,
					noun.singular.toLowerCase(),
					noun.plural.toLowerCase()
				)}
			</td>
			{columns.map((column) => {
				const { sum } = column;
				let total: number | null = null;
				if (sum) {
					total = 0;
					for (const row of rows) {
						total += sum(row);
					}
				}
				return (
					<td
						className={cn(
							"border-border border-r border-b px-3 last:border-r-0",
							column.align === "end" && "text-right"
						)}
						key={column.id}
					>
						{total === null ? null : (
							<span className="inline-flex items-baseline gap-1.5">
								<span>Sum</span>
								<span className="text-foreground text-sm tabular-nums">
									{total}
								</span>
							</span>
						)}
					</td>
				);
			})}
		</tr>
	);
}

/** Placeholder rows while the first snapshot loads. */
function SkeletonRows({ columns }: { columns: Column[] }) {
	return (
		<>
			{["a", "b", "c", "d", "e", "f"].map((key, index) => (
				<tr className="h-11" key={key}>
					<td className="border-border border-r border-b px-3">
						<span className="flex items-center gap-2">
							<Skeleton className="size-5 rounded-full" />
							<Skeleton
								className="h-3"
								style={{ width: `${56 + ((index * 23) % 48)}px` }}
							/>
						</span>
					</td>
					{columns.map((column) => (
						<td
							className="border-border border-r border-b px-3 last:border-r-0"
							key={column.id}
						>
							<Skeleton
								className={cn("h-3", column.align === "end" && "ms-auto")}
								style={{
									width: `${Math.min(column.width - 40, 28 + ((index * 17 + column.width) % 64))}px`,
								}}
							/>
						</td>
					))}
				</tr>
			))}
		</>
	);
}

/**
 * Attio's object table: a sticky name column, attribute columns with typed
 * header icons, sortable headers, quiet gridlines, and 40px rows. Rows move
 * with the arrow keys; Enter (or a click anywhere on the row) opens the record.
 */
export function RecordsTable({
	cursorId,
	loading,
	now,
	object,
	onFocusRow,
	onKeyDownRow,
	onOpen,
	onSort,
	registerRow,
	rows,
	sort,
}: {
	cursorId: string | null;
	loading: boolean;
	now: number;
	object: RecordsObject;
	onFocusRow: (id: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, id: string) => void;
	onOpen: (id: string) => void;
	onSort: (key: RecordsSortKey) => void;
	registerRow: (id: string, element: HTMLElement | null) => void;
	rows: RecordsRow[];
	sort: RecordsSort;
}) {
	const columns = recordsColumns(object);
	const minWidth =
		NAME_WIDTH + columns.reduce((total, column) => total + column.width, 0);
	return (
		<table
			className="w-full table-fixed border-separate border-spacing-0 text-foreground text-sm"
			data-testid="records-table"
			style={{ minWidth }}
		>
			<colgroup>
				<col style={{ width: NAME_WIDTH }} />
				{columns.map((column, index) => (
					<col
						key={column.id}
						style={
							index === columns.length - 1
								? { minWidth: column.width }
								: { width: column.width }
						}
					/>
				))}
			</colgroup>
			<thead className="sticky top-0 z-10">
				<tr>
					<HeaderCell
						column={{ icon: AlignLeft, label: "Name", sortKey: "name" }}
						name
						onSort={onSort}
						sort={sort}
					/>
					{columns.map((column) => (
						<HeaderCell
							column={column}
							key={column.id}
							onSort={onSort}
							sort={sort}
						/>
					))}
				</tr>
			</thead>
			<tbody>
				{loading && rows.length === 0 ? (
					<SkeletonRows columns={columns} />
				) : (
					rows.map((row) => {
						const isCursor = row.id === cursorId;
						return (
							<tr
								className="group/row h-11 cursor-default"
								data-record-id={row.id}
								key={row.id}
								onClick={() => onOpen(row.id)}
							>
								<th
									className="sticky left-0 z-[1] border-border border-r border-b bg-background p-0 text-left font-normal transition-colors group-hover/row:bg-muted"
									scope="row"
								>
									<button
										className="flex size-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
										onClick={(event) => {
											event.stopPropagation();
											onOpen(row.id);
										}}
										onFocus={() => onFocusRow(row.id)}
										onKeyDown={(event) => onKeyDownRow(event, row.id)}
										ref={(element) => registerRow(row.id, element)}
										tabIndex={isCursor ? 0 : -1}
										type="button"
									>
										<RecordsMark agent={row.agent} name={row.name} size={20} />
										<span className="truncate font-medium">{row.name}</span>
									</button>
								</th>
								{columns.map((column) => (
									<td
										className={cn(
											"overflow-hidden border-border border-r border-b bg-background px-3 transition-colors last:border-r-0 group-hover/row:bg-muted",
											column.align === "end" && "text-right"
										)}
										key={column.id}
									>
										<div
											className={cn(
												"flex min-w-0 items-center truncate",
												column.align === "end" && "justify-end"
											)}
										>
											{column.cell(row, now)}
										</div>
									</td>
								))}
							</tr>
						);
					})
				)}
			</tbody>
			{loading || rows.length === 0 ? null : (
				<tfoot>
					<SumRow columns={columns} object={object} rows={rows} />
				</tfoot>
			)}
		</table>
	);
}
