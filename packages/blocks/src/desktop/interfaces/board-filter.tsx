import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	type BoardFilter,
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { CircleDot, FolderKanban, ListFilter, User, X } from "lucide-react";
import { BoardStatusDot } from "./board-status.tsx";

export type BoardFilterField = keyof BoardFilter;

/** Add or remove one value from one filter field. */
export function toggleBoardFilter(
	filter: BoardFilter,
	field: BoardFilterField,
	value: string
): BoardFilter {
	const current: readonly string[] = filter[field];
	const next = current.includes(value)
		? current.filter((item) => item !== value)
		: [...current, value];
	return { ...filter, [field]: next };
}

const FIELD_LABEL: Record<BoardFilterField, string> = {
	agentIds: "Agent",
	groupIds: "Team or project",
	statuses: "Status",
};

function valueLabel(
	snapshot: InterfaceSnapshot,
	field: BoardFilterField,
	value: string
): string {
	if (field === "statuses") {
		return THREAD_STATUS_LABELS[value as ThreadStatus] ?? value;
	}
	if (field === "agentIds") {
		return snapshot.agents.find((agent) => agent.id === value)?.name ?? value;
	}
	return snapshot.groups.find((group) => group.id === value)?.name ?? value;
}

const activeCount = (filter: BoardFilter) =>
	filter.agentIds.length + filter.groupIds.length + filter.statuses.length;

/** The header's Filter menu: one submenu per field, with checkable values. */
export function BoardFilterMenu({
	filter,
	onToggle,
	snapshot,
}: {
	filter: BoardFilter;
	onToggle: (field: BoardFilterField, value: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const count = activeCount(filter);
	const agents = [...snapshot.agents].sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	const groups = [...snapshot.groups].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={
							count > 0 ? tl("Filter, {count} active", { count }) : "Filter"
						}
						size="dense"
						type="button"
						variant="ghost"
					/>
				}
			>
				<ListFilter aria-hidden="true" data-icon="inline-start" />
				<span className="@max-[640px]/header:hidden">Filter</span>
				{count > 0 ? (
					<span className="text-muted-foreground tabular-nums">{count}</span>
				) : null}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56" drawerLabel="Filter">
				<DropdownMenuSub>
					<DropdownMenuSubTrigger className="text-[13px]">
						<CircleDot aria-hidden="true" />
						Status
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="w-52">
						{THREAD_STATUS_ORDER.map((status) => (
							<DropdownMenuCheckboxItem
								checked={filter.statuses.includes(status)}
								className="text-[13px]"
								key={status}
								onCheckedChange={() => onToggle("statuses", status)}
							>
								<BoardStatusDot pulse={false} status={status} />
								{THREAD_STATUS_LABELS[status]}
							</DropdownMenuCheckboxItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				{agents.length > 0 ? (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger className="text-[13px]">
							<User aria-hidden="true" />
							Agent
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="max-h-80 w-52">
							{agents.map((agent) => (
								<DropdownMenuCheckboxItem
									checked={filter.agentIds.includes(agent.id)}
									className="text-[13px]"
									key={agent.id}
									onCheckedChange={() => onToggle("agentIds", agent.id)}
								>
									<span className="truncate">{agent.name}</span>
								</DropdownMenuCheckboxItem>
							))}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				) : null}
				{groups.length > 0 ? (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger className="text-[13px]">
							<FolderKanban aria-hidden="true" />
							Team or project
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="max-h-80 w-52">
							{groups.map((group) => (
								<DropdownMenuCheckboxItem
									checked={filter.groupIds.includes(group.id)}
									className="text-[13px]"
									key={group.id}
									onCheckedChange={() => onToggle("groupIds", group.id)}
								>
									<span className="truncate">{group.name}</span>
									<span className="ms-auto text-muted-foreground text-xs">
										{group.kind === "team" ? "Team" : "Project"}
									</span>
								</DropdownMenuCheckboxItem>
							))}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const FIELDS: readonly BoardFilterField[] = [
	"statuses",
	"agentIds",
	"groupIds",
];

/**
 * The active filters as removable chips ("Status is Working, Your turn ×"),
 * shown under the header only while something is filtered.
 */
export function BoardFilterBar({
	filter,
	onClear,
	onRemoveField,
	snapshot,
}: {
	filter: BoardFilter;
	onClear: () => void;
	onRemoveField: (field: BoardFilterField) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const fields = FIELDS.filter((field) => filter[field].length > 0);
	if (fields.length === 0) {
		return null;
	}
	return (
		<div
			aria-label="Active filters"
			className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b px-4 py-2"
			role="group"
		>
			{fields.map((field) => {
				const values = filter[field].map((value) =>
					valueLabel(snapshot, field, value)
				);
				const verb = values.length === 1 ? "is" : "is any of";
				return (
					<span
						className="inline-flex h-7 max-w-full items-center overflow-hidden rounded-md border border-border bg-background text-xs"
						key={field}
					>
						<span className="px-2 text-muted-foreground">
							{FIELD_LABEL[field]} {verb}
						</span>
						<span className="truncate border-border border-l px-2 font-medium text-foreground">
							{values.join(", ")}
						</span>
						<button
							aria-label={tl("Remove {field} filter", {
								field: FIELD_LABEL[field].toLowerCase(),
							})}
							className="flex h-full items-center border-border border-l px-1.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							onClick={() => onRemoveField(field)}
							type="button"
						>
							<X aria-hidden="true" className="size-3.5" />
						</button>
					</span>
				);
			})}
			<Button onClick={onClear} size="xs" type="button" variant="ghost">
				Clear filters
			</Button>
		</div>
	);
}
