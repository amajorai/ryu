import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	ChevronDown,
	CornerDownLeft,
	ListFilter,
	Play,
	Search,
	X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import {
	NO_REQUESTER_ID,
	TICKET_PRIORITY_LABELS,
	TICKET_PRIORITY_ORDER,
	type TicketFilter,
	type TicketGroupBy,
	type TicketPriority,
	ticketCountLabel,
	ticketFilterCount,
} from "./tickets-model.ts";

const MENU_ITEM = "text-[13px] font-normal";

const GROUP_LABELS: Record<TicketGroupBy, string> = {
	none: "None",
	priority: "Priority",
	status: "Status",
};

/** The view's title row: name, count, and Zendesk's Play button. */
export function TicketsViewHeader({
	count,
	loading,
	onPlay,
	title,
	viewSelect,
}: {
	count: number;
	loading: boolean;
	/** Opens the first ticket in the view; null when there is none. */
	onPlay: (() => void) | null;
	title: string;
	/** Replaces the title with a view picker at narrow widths. */
	viewSelect: ReactNode | null;
}) {
	return (
		<header className="flex h-12 shrink-0 items-center gap-3 px-4">
			{viewSelect ? (
				<div className="flex min-w-0 flex-1 items-center">
					<h1 className="sr-only">{title}</h1>
					{viewSelect}
				</div>
			) : (
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h1 className="truncate font-semibold text-base text-foreground">
						{title}
					</h1>
					{loading ? null : (
						<span
							aria-live="polite"
							className="shrink-0 text-muted-foreground text-sm tabular-nums"
						>
							{ticketCountLabel(count)}
						</span>
					)}
				</div>
			)}
			<Button
				disabled={onPlay === null}
				onClick={onPlay ?? undefined}
				size="sm"
				title="Open the first ticket in this view"
				type="button"
				variant="outline"
			>
				<Play aria-hidden="true" data-icon="inline-start" />
				Play
			</Button>
		</header>
	);
}

function toggled<T>(values: readonly T[], value: T, order: readonly T[]): T[] {
	return values.includes(value)
		? values.filter((item) => item !== value)
		: order.filter((item) => item === value || values.includes(item));
}

function FilterChip({
	label,
	onClear,
	value,
}: {
	label: string;
	onClear: () => void;
	value: string;
}) {
	const tl = useLiteralMessages();
	return (
		<span className="inline-flex h-7 max-w-64 shrink-0 items-center gap-1 rounded-full bg-muted ps-2.5 pe-0.5 text-foreground text-xs">
			<span className="text-muted-foreground">{label}</span>
			<span className="truncate font-medium">{value}</span>
			<button
				aria-label={tl("Remove {filterLabel} filter", {
					filterLabel: label.toLowerCase(),
				})}
				className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onClick={onClear}
				type="button"
			>
				<X aria-hidden="true" className="size-3.5" />
			</button>
		</span>
	);
}

/**
 * The bar above the table: a filter field, requester and priority filters,
 * group-by, and, while tickets are checked, the bulk-selection actions.
 */
export function TicketsToolbar({
	agents,
	compact,
	filter,
	groupBy,
	onClearSelection,
	onFilterChange,
	onGroupByChange,
	onOpenSelected,
	onSearchKeyDown,
	searchRef,
	selectedCount,
}: {
	agents: InterfaceAgent[];
	compact: boolean;
	filter: TicketFilter;
	groupBy: TicketGroupBy;
	onClearSelection: () => void;
	onFilterChange: (filter: TicketFilter) => void;
	onGroupByChange: (groupBy: TicketGroupBy) => void;
	onOpenSelected: () => void;
	onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
	searchRef: RefObject<HTMLInputElement | null>;
	selectedCount: number;
}) {
	const tl = useLiteralMessages();
	const filterCount = ticketFilterCount(filter);
	const requesterOrder = [...agents.map((agent) => agent.id), NO_REQUESTER_ID];
	const requesterName = (id: string) =>
		id === NO_REQUESTER_ID
			? "No requester"
			: (agents.find((agent) => agent.id === id)?.name ?? id);

	if (selectedCount > 0) {
		return (
			<div
				aria-label="Selected tickets"
				className="flex h-11 shrink-0 items-center gap-2 border-border border-y bg-muted/40 px-4"
				data-testid="tickets-bulk-bar"
				role="toolbar"
			>
				<span
					aria-live="polite"
					className="font-medium text-foreground text-sm tabular-nums"
				>
					{tl("{selectedCount} selected", {
						selectedCount: String(selectedCount),
					})}
				</span>
				<span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
				<Button
					onClick={onOpenSelected}
					size="sm"
					type="button"
					variant="ghost"
				>
					Open in tabs
				</Button>
				<Button
					onClick={onClearSelection}
					size="sm"
					type="button"
					variant="ghost-muted"
				>
					Clear selection
				</Button>
			</div>
		);
	}

	return (
		<div
			aria-label="Filter tickets"
			className="flex h-11 shrink-0 items-center gap-2 border-border border-y px-4"
			role="toolbar"
		>
			<InputGroup
				className={cn("h-8 shrink-0", compact ? "w-full max-w-56" : "w-64")}
			>
				<InputGroupAddon>
					<Search aria-hidden="true" className="size-3.5" />
				</InputGroupAddon>
				<InputGroupInput
					aria-label="Filter tickets by subject, number, requester or tag"
					className="text-[13px]"
					data-testid="tickets-search"
					onChange={(event) =>
						onFilterChange({ ...filter, query: event.target.value })
					}
					onKeyDown={onSearchKeyDown}
					placeholder="Filter tickets"
					ref={searchRef}
					value={filter.query}
				/>
				{filter.query ? (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							aria-label="Clear filter"
							onClick={() => onFilterChange({ ...filter, query: "" })}
							size="icon-xs"
						>
							<X aria-hidden="true" />
						</InputGroupButton>
					</InputGroupAddon>
				) : (
					<InputGroupAddon align="inline-end">
						<Kbd>/</Kbd>
					</InputGroupAddon>
				)}
			</InputGroup>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={
								filterCount > 0
									? tl("Filters, {filterCount} active", { filterCount })
									: "Filters"
							}
							size="sm"
							type="button"
							variant={filterCount > 0 ? "secondary" : "ghost"}
						/>
					}
				>
					<ListFilter aria-hidden="true" data-icon="inline-start" />
					{compact ? null : "Filter"}
					{filterCount > 0 ? (
						<span className="text-muted-foreground tabular-nums">
							{filterCount}
						</span>
					) : null}
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="w-56"
					drawerLabel="Filter"
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Priority</DropdownMenuLabel>
						{TICKET_PRIORITY_ORDER.map((priority) => (
							<DropdownMenuCheckboxItem
								checked={filter.priorities.includes(priority)}
								className={MENU_ITEM}
								key={priority}
								onCheckedChange={() =>
									onFilterChange({
										...filter,
										priorities: toggled<TicketPriority>(
											filter.priorities,
											priority,
											TICKET_PRIORITY_ORDER
										),
									})
								}
							>
								{TICKET_PRIORITY_LABELS[priority]}
							</DropdownMenuCheckboxItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuLabel>Requester</DropdownMenuLabel>
						{requesterOrder.map((id) => (
							<DropdownMenuCheckboxItem
								checked={filter.requesterIds.includes(id)}
								className={MENU_ITEM}
								key={id}
								onCheckedChange={() =>
									onFilterChange({
										...filter,
										requesterIds: toggled(
											filter.requesterIds,
											id,
											requesterOrder
										),
									})
								}
							>
								{requesterName(id)}
							</DropdownMenuCheckboxItem>
						))}
					</DropdownMenuGroup>
					{filterCount > 0 ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className={MENU_ITEM}
								onClick={() =>
									onFilterChange({
										...filter,
										priorities: [],
										requesterIds: [],
									})
								}
							>
								Clear filters
							</DropdownMenuItem>
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			{compact ? null : (
				<>
					{filter.priorities.length > 0 ? (
						<FilterChip
							label="Priority"
							onClear={() => onFilterChange({ ...filter, priorities: [] })}
							value={filter.priorities
								.map((priority) => TICKET_PRIORITY_LABELS[priority])
								.join(", ")}
						/>
					) : null}
					{filter.requesterIds.length > 0 ? (
						<FilterChip
							label="Requester"
							onClear={() => onFilterChange({ ...filter, requesterIds: [] })}
							value={filter.requesterIds.map(requesterName).join(", ")}
						/>
					) : null}
				</>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={tl("Group by {groupLabel}", {
								groupLabel: GROUP_LABELS[groupBy].toLowerCase(),
							})}
							className="ms-auto"
							size="sm"
							type="button"
							variant="ghost"
						/>
					}
				>
					{compact ? null : (
						<span className="text-muted-foreground">Group by</span>
					)}
					{GROUP_LABELS[groupBy]}
					<ChevronDown
						aria-hidden="true"
						className="size-3.5 text-muted-foreground"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="w-44"
					drawerLabel="Group by"
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Group by</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							onValueChange={(value: unknown) => {
								if (
									value === "none" ||
									value === "priority" ||
									value === "status"
								) {
									onGroupByChange(value);
								}
							}}
							value={groupBy}
						>
							{(["status", "priority", "none"] as const).map((option) => (
								<DropdownMenuRadioItem
									className={MENU_ITEM}
									key={option}
									value={option}
								>
									{GROUP_LABELS[option]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** The table's footer: what is shown, and the keys that move through it. */
export function TicketsFooter({
	shown,
	showHints,
	total,
}: {
	shown: number;
	showHints: boolean;
	total: number;
}) {
	return (
		<footer className="flex h-9 shrink-0 items-center gap-4 border-border border-t px-4 text-muted-foreground text-xs">
			<span className="tabular-nums">
				{shown === total
					? ticketCountLabel(total)
					: `${shown} of ${ticketCountLabel(total)}`}
			</span>
			{showHints ? (
				<span aria-hidden="true" className="ms-auto flex items-center gap-4">
					<span className="flex items-center gap-1.5">
						<Kbd>J</Kbd>
						<Kbd>K</Kbd>
						Move
					</span>
					<span className="flex items-center gap-1.5">
						<Kbd>
							<CornerDownLeft />
						</Kbd>
						Open
					</span>
					<span className="flex items-center gap-1.5">
						<Kbd>X</Kbd>
						Select
					</span>
					<span className="flex items-center gap-1.5">
						<Kbd>C</Kbd>
						New ticket
					</span>
				</span>
			) : null}
		</footer>
	);
}
