import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ButtonGroup } from "@ryu/ui/components/button-group.tsx";
import {
	DropdownMenu,
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
import { Separator } from "@ryu/ui/components/separator.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	ArrowDownWideNarrow,
	ArrowUpDown,
	ArrowUpNarrowWide,
	ChevronDown,
	FolderKanban,
	ListFilter,
	Plus,
	Search,
	Table2,
	UsersRound,
	X,
} from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { SheetStatusMark } from "./sheet-cells.tsx";
import { SHEET_COLUMN_ICON } from "./sheet-grid.tsx";
import {
	SHEET_COLUMNS,
	type SheetSort,
	sheetColumn,
	sheetSortDirectionLabel,
} from "./sheet-model.ts";

export interface SheetStartInput {
	agentId?: string;
	projectId?: string;
	teamId?: string;
}

/** Menu rows on the grid's 13px rhythm instead of the menu's default 14px. */
const MENU_ITEM = "text-[13px]";

/** View-bar buttons: quiet until they hold state, then tinted like an applied filter. */
const VIEW_BUTTON =
	"h-8 gap-1.5 rounded-md px-2.5 font-normal text-[13px] text-foreground/80 has-data-[icon=inline-start]:ps-2";
const VIEW_BUTTON_ACTIVE =
	"bg-primary/15 font-medium text-foreground hover:bg-primary/20 aria-expanded:bg-primary/20";

function SortMenu({
	onSort,
	sort,
}: {
	onSort: (sort: SheetSort | null) => void;
	sort: SheetSort | null;
}) {
	const tl = useLiteralMessages();
	const SortIcon =
		sort?.direction === "desc" ? ArrowDownWideNarrow : ArrowUpNarrowWide;
	const label = sort
		? tl("Sorted by {columnLabel}", {
				columnLabel: sheetColumn(sort.column).label,
			})
		: "Sort";
	const directionLabel = sort ? sheetSortDirectionLabel(sort) : "";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						className={cn(VIEW_BUTTON, sort && VIEW_BUTTON_ACTIVE)}
						size="sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{sort ? (
					<SortIcon
						aria-hidden="true"
						className="size-3.5"
						data-icon="inline-start"
					/>
				) : (
					<ArrowUpDown
						aria-hidden="true"
						className="size-3.5"
						data-icon="inline-start"
					/>
				)}
				<span className="@max-2xl/sheet:sr-only">{label}</span>
				{sort ? (
					<span className="sr-only">{`, ${directionLabel.replace("→", "to")}`}</span>
				) : null}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56" drawerLabel="Sort">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Sort by</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						onValueChange={(value: string) => {
							const column = SHEET_COLUMNS.find((item) => item.id === value);
							if (column) {
								onSort({
									column: column.id,
									direction:
										sort?.column === column.id ? sort.direction : "asc",
								});
							}
						}}
						value={sort?.column ?? ""}
					>
						{SHEET_COLUMNS.map((column) => {
							const Icon = SHEET_COLUMN_ICON[column.id];
							return (
								<DropdownMenuRadioItem
									className={MENU_ITEM}
									key={column.id}
									value={column.id}
								>
									<Icon
										aria-hidden="true"
										className="size-3.5 text-muted-foreground"
									/>
									{column.label}
								</DropdownMenuRadioItem>
							);
						})}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				{sort ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel>Order</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								onValueChange={(value: string) => {
									if (value === "asc" || value === "desc") {
										onSort({ column: sort.column, direction: value });
									}
								}}
								value={sort.direction}
							>
								<DropdownMenuRadioItem className={MENU_ITEM} value="asc">
									{sheetSortDirectionLabel({
										column: sort.column,
										direction: "asc",
									})}
								</DropdownMenuRadioItem>
								<DropdownMenuRadioItem className={MENU_ITEM} value="desc">
									{sheetSortDirectionLabel({
										column: sort.column,
										direction: "desc",
									})}
								</DropdownMenuRadioItem>
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className={MENU_ITEM}
							onClick={() => onSort(null)}
						>
							<X aria-hidden="true" className="size-3.5" />
							Clear sort
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const ALL_STATUSES = "all";

function FilterMenu({
	counts,
	onStatus,
	status,
	total,
}: {
	counts: Record<ThreadStatus, number>;
	onStatus: (status: ThreadStatus | null) => void;
	status: ThreadStatus | null;
	total: number;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						className={cn(VIEW_BUTTON, status && VIEW_BUTTON_ACTIVE)}
						size="sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				<ListFilter
					aria-hidden="true"
					className="size-3.5"
					data-icon="inline-start"
				/>
				<span className="@max-2xl/sheet:sr-only">
					{status ? "1 filter" : "Filter"}
				</span>
				{status ? (
					<span className="sr-only">{`: ${THREAD_STATUS_LABELS[status]}`}</span>
				) : null}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56" drawerLabel="Filter">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Status</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						onValueChange={(value: string) => {
							const next = THREAD_STATUS_ORDER.find((item) => item === value);
							onStatus(next ?? null);
						}}
						value={status ?? ALL_STATUSES}
					>
						<DropdownMenuRadioItem className={MENU_ITEM} value={ALL_STATUSES}>
							<span className="size-2.5 shrink-0" />
							<span className="flex-1">All statuses</span>
							<span className="text-muted-foreground text-xs tabular-nums">
								{total}
							</span>
						</DropdownMenuRadioItem>
						{THREAD_STATUS_ORDER.map((item) => (
							<DropdownMenuRadioItem
								className={MENU_ITEM}
								key={item}
								value={item}
							>
								<span className="flex size-2.5 shrink-0 items-center justify-center">
									<SheetStatusMark status={item} />
								</span>
								<span className="flex-1">{THREAD_STATUS_LABELS[item]}</span>
								<span className="text-muted-foreground text-xs tabular-nums">
									{counts[item]}
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				{status ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className={MENU_ITEM}
							onClick={() => onStatus(null)}
						>
							<X aria-hidden="true" className="size-3.5" />
							Clear status filter
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function SheetToolbar({
	counts,
	onQueryChange,
	onSearchKeyDown,
	onSort,
	onStart,
	onStatus,
	query,
	searchRef,
	snapshot,
	sort,
	status,
	total,
}: {
	counts: Record<ThreadStatus, number>;
	onQueryChange: (query: string) => void;
	onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
	onSort: (sort: SheetSort | null) => void;
	onStart: (input: SheetStartInput) => void;
	onStatus: (status: ThreadStatus | null) => void;
	query: string;
	searchRef: RefObject<HTMLInputElement | null>;
	snapshot: InterfaceSnapshot;
	sort: SheetSort | null;
	status: ThreadStatus | null;
	/** Rows the search leaves, before the status filter. */
	total: number;
}) {
	const teams = snapshot.groups.filter((group) => group.kind === "team");
	const projects = snapshot.groups.filter((group) => group.kind === "project");

	return (
		<header className="flex h-12 shrink-0 items-center gap-1 border-border border-b bg-background px-3">
			<h2 className="flex shrink-0 items-center gap-2 ps-1 pe-2 font-medium text-[13px] text-foreground">
				<Table2 aria-hidden="true" className="size-3.5 text-muted-foreground" />
				Threads
			</h2>
			<Separator
				className="me-1 data-vertical:h-4 data-vertical:self-center"
				orientation="vertical"
			/>
			<FilterMenu
				counts={counts}
				onStatus={onStatus}
				status={status}
				total={total}
			/>
			<SortMenu onSort={onSort} sort={sort} />
			<div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
				<InputGroup className="h-8 min-w-28 max-w-64 flex-1 rounded-md">
					<InputGroupAddon>
						<Search aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						aria-label="Search threads"
						className="text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
						onChange={(event) => onQueryChange(event.target.value)}
						onKeyDown={onSearchKeyDown}
						placeholder="Search threads"
						ref={searchRef}
						type="search"
						value={query}
					/>
					<InputGroupAddon align="inline-end">
						{query ? (
							<InputGroupButton
								aria-label="Clear search"
								onClick={() => {
									onQueryChange("");
									searchRef.current?.focus();
								}}
								size="icon-xs"
							>
								<X aria-hidden="true" />
							</InputGroupButton>
						) : (
							<Kbd className="@max-2xl/sheet:hidden">/</Kbd>
						)}
					</InputGroupAddon>
				</InputGroup>
				<ButtonGroup>
					<Button
						aria-label="New thread"
						onClick={() => onStart({})}
						size="sm"
						type="button"
					>
						<Plus aria-hidden="true" data-icon="inline-start" />
						<span className="@max-md/sheet:hidden">New thread</span>
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label="New thread with…"
									className="border-primary-foreground/20 border-l px-2"
									size="sm"
									type="button"
								/>
							}
						>
							<ChevronDown aria-hidden="true" />
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className="max-h-96 w-60"
							drawerLabel="New thread with"
						>
							<DropdownMenuItem
								className={MENU_ITEM}
								onClick={() => onStart({})}
							>
								<Plus aria-hidden="true" />
								<span className="truncate">Blank thread</span>
							</DropdownMenuItem>
							{snapshot.agents.length > 0 ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuLabel>With an agent</DropdownMenuLabel>
										{snapshot.agents.map((agent) => (
											<DropdownMenuItem
												className={MENU_ITEM}
												key={agent.id}
												onClick={() => onStart({ agentId: agent.id })}
											>
												<BoardAvatar
													agent={agent}
													className="size-4.5"
													name={agent.name}
													size={20}
												/>
												<span className="truncate">{agent.name}</span>
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</>
							) : null}
							{teams.length > 0 ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuLabel>In a team</DropdownMenuLabel>
										{teams.map((team) => (
											<DropdownMenuItem
												className={MENU_ITEM}
												key={team.id}
												onClick={() => onStart({ teamId: team.id })}
											>
												<UsersRound aria-hidden="true" />
												<span className="truncate">{team.name}</span>
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</>
							) : null}
							{projects.length > 0 ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuLabel>In a project</DropdownMenuLabel>
										{projects.map((project) => (
											<DropdownMenuItem
												className={MENU_ITEM}
												key={project.id}
												onClick={() => onStart({ projectId: project.id })}
											>
												<FolderKanban aria-hidden="true" />
												<span className="truncate">{project.name}</span>
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</ButtonGroup>
			</div>
		</header>
	);
}
