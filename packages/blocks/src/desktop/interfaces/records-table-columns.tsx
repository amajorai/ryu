import {
	AlignLeft,
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
import type { ReactNode } from "react";
import {
	type RecordsObject,
	type RecordsRow,
	type RecordsSortKey,
	recordsFullTime,
	recordsRelativeTime,
	recordsTimeUntil,
} from "./records-model.ts";
import {
	RecordsFaces,
	RecordsMark,
	RecordsRowStatus,
} from "./records-parts.tsx";

export interface Column {
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
export const NAME_WIDTH = 208;

export function recordsColumns(object: RecordsObject): Column[] {
	return object === "agents" ? AGENT_COLUMNS : GROUP_COLUMNS;
}
