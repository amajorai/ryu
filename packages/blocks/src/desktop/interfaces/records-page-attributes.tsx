import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceGroup,
} from "@ryuhq/protocol/interfaces";
import {
	AtSign,
	CalendarClock,
	CircleDot,
	Clock3,
	FolderKanban,
	Inbox,
	type LucideIcon,
	MessageCircle,
	MessagesSquare,
	Shapes,
	UserRound,
	UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { agentHandle } from "./interface-renderer.ts";
import {
	RECORDS_OBJECT_LABELS,
	type RecordsObject,
	type RecordsRow,
	recordsFullTime,
	recordsRelativeTime,
	recordsRunTime,
} from "./records-model.ts";
import { RecordsMark, RecordsRowStatus } from "./records-parts.tsx";

export interface RecordsRelatedTarget {
	id: string;
	object: RecordsObject;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function Attribute({
	children,
	icon: Icon,
	label,
}: {
	children: ReactNode;
	icon: LucideIcon;
	label: string;
}) {
	return (
		<div className="grid grid-cols-[120px_minmax(0,1fr)] items-start gap-3 py-1.5">
			<dt className="flex h-6 items-center gap-2 text-muted-foreground">
				<Icon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="truncate">{label}</span>
			</dt>
			<dd className="flex min-h-6 min-w-0 items-center text-foreground">
				{children}
			</dd>
		</div>
	);
}

function RelatedLink({
	agent,
	name,
	onOpen,
}: {
	agent: InterfaceAgent | null;
	name: string;
	onOpen: () => void;
}) {
	return (
		<button
			className="-mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onOpen}
			type="button"
		>
			<RecordsMark agent={agent} name={name} size={20} />
			<span className="truncate">{name}</span>
		</button>
	);
}

function GroupLinks({
	groups,
	object,
	onOpenRecord,
}: {
	groups: readonly InterfaceGroup[];
	object: RecordsObject;
	onOpenRecord: (target: RecordsRelatedTarget) => void;
}) {
	if (groups.length === 0) {
		return <span className="text-muted-foreground">None</span>;
	}
	return (
		<ul className="flex min-w-0 flex-col gap-0.5">
			{groups.map((group) => (
				<li className="flex min-w-0" key={group.id}>
					<RelatedLink
						agent={null}
						name={group.name}
						onOpen={() => onOpenRecord({ id: group.id, object })}
					/>
				</li>
			))}
		</ul>
	);
}

function CountValue({ value }: { value: number }) {
	return (
		<span
			className={cn("tabular-nums", value === 0 && "text-muted-foreground")}
		>
			{value}
		</span>
	);
}

/** The record's attribute list, Attio's "Record details". */
export function RecordsAttributes({
	columns = 1,
	now,
	onOpenRecord,
	row,
}: {
	/** Two columns where the list sits inline in a wide page. */
	columns?: 1 | 2;
	now: number;
	onOpenRecord: (target: RecordsRelatedTarget) => void;
	row: RecordsRow;
}) {
	const last = recordsRelativeTime(row.lastInteraction, now);
	const nextRun = row.upcoming[0];
	return (
		<dl
			className={cn(
				"text-[13px]",
				columns === 2 ? "grid grid-cols-2 gap-x-8" : "flex flex-col"
			)}
		>
			{row.agent ? (
				<Attribute icon={AtSign} label="Handle">
					<span className="truncate">{agentHandle(row.agent.name)}</span>
				</Attribute>
			) : (
				<Attribute icon={Shapes} label="Type">
					{RECORDS_OBJECT_LABELS[row.object].singular}
				</Attribute>
			)}
			<Attribute icon={CircleDot} label="Status">
				<RecordsRowStatus row={row} />
			</Attribute>
			<Attribute icon={MessagesSquare} label="Threads">
				<CountValue value={row.threads.length} />
			</Attribute>
			<Attribute icon={Inbox} label="Needs you">
				<CountValue value={row.needsYou} />
			</Attribute>
			<Attribute icon={MessageCircle} label="Messages">
				<CountValue value={row.messageCount} />
			</Attribute>
			<Attribute icon={Clock3} label="Last interaction">
				{last && row.lastInteraction ? (
					<time
						dateTime={row.lastInteraction}
						title={recordsFullTime(row.lastInteraction)}
					>
						{last}
					</time>
				) : (
					<span className="text-muted-foreground">Never</span>
				)}
			</Attribute>
			{row.object === "agents" ? (
				<Attribute icon={CalendarClock} label="Next run">
					{nextRun ? (
						<span className="flex min-w-0 flex-col py-0.5">
							<span className="truncate leading-5">{nextRun.title}</span>
							<time
								className="truncate text-muted-foreground text-xs leading-4"
								dateTime={nextRun.start}
								title={recordsFullTime(nextRun.start)}
							>
								{recordsRunTime(nextRun.start, now)}
							</time>
						</span>
					) : (
						<span className="text-muted-foreground">None scheduled</span>
					)}
				</Attribute>
			) : null}
			{row.object === "agents" ? (
				<>
					<Attribute icon={UsersRound} label="Teams">
						<GroupLinks
							groups={row.teams}
							object="teams"
							onOpenRecord={onOpenRecord}
						/>
					</Attribute>
					<Attribute icon={FolderKanban} label="Projects">
						<GroupLinks
							groups={row.projects}
							object="projects"
							onOpenRecord={onOpenRecord}
						/>
					</Attribute>
				</>
			) : (
				<Attribute icon={UserRound} label="Members">
					{row.members.length > 0 ? (
						<ul className="flex min-w-0 flex-col gap-0.5">
							{row.members.map((agent) => (
								<li className="flex min-w-0" key={agent.id}>
									<RelatedLink
										agent={agent}
										name={agent.name}
										onOpen={() =>
											onOpenRecord({ id: agent.id, object: "agents" })
										}
									/>
								</li>
							))}
						</ul>
					) : (
						<span className="text-muted-foreground">No members</span>
					)}
				</Attribute>
			)}
		</dl>
	);
}
