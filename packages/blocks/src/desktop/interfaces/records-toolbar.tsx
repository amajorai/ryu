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
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import {
	ArrowDownWideNarrow,
	ArrowUpNarrowWide,
	ChevronDown,
	ChevronRight,
	Columns3,
	ListFilter,
	Plus,
	Search,
	Table2,
	X,
} from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { FilterChips } from "./records-filter-chips.tsx";
import {
	RECORDS_OBJECT_LABELS,
	RECORDS_OBJECTS,
	RECORDS_SORT_KEYS,
	RECORDS_SORT_LABELS,
	RECORDS_STATUS_ORDER,
	RECORDS_VIEWS,
	type RecordsFilter,
	type RecordsObject,
	type RecordsSort,
	type RecordsView,
	recordsFilterCount,
} from "./records-model.ts";
import { RECORDS_OBJECT_ICONS } from "./records-nav.tsx";

export type RecordsLayout = "board" | "table";

/** Menu rows on the table's 13px rhythm. */
const MENU_ITEM = "text-[13px] font-normal";

/**
 * The page header: which object (and saved view) is on screen, its count,
 * and the one primary action. Below the nav breakpoint the title becomes the
 * object and view switcher.
 */
export function RecordsHeader({
	compact,
	count,
	loading,
	object,
	onSelectObject,
	onSelectView,
	onStart,
	view,
}: {
	compact: boolean;
	count: number;
	loading: boolean;
	object: RecordsObject;
	onSelectObject: (object: RecordsObject) => void;
	onSelectView: (viewId: string) => void;
	onStart: () => void;
	view: RecordsView | undefined;
}) {
	const tl = useLiteralMessages();
	const Icon = RECORDS_OBJECT_ICONS[object];
	const objectLabel = RECORDS_OBJECT_LABELS[object].plural;
	const title = (
		<span className="flex min-w-0 items-center gap-2">
			<Icon aria-hidden="true" className="size-4 shrink-0 text-foreground/70" />
			<span className="truncate font-semibold text-foreground text-sm">
				{objectLabel}
			</span>
			{view ? (
				<>
					<ChevronRight
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
					<span className="truncate font-semibold text-foreground text-sm">
						{view.label}
					</span>
				</>
			) : null}
		</span>
	);
	const countLabel = loading ? null : (
		<span
			aria-live="polite"
			className="shrink-0 font-normal text-muted-foreground text-sm tabular-nums"
		>
			{count}
			<span className="sr-only"> shown</span>
		</span>
	);
	return (
		<header className="flex h-12 shrink-0 items-center gap-3 border-border border-b px-4">
			<h1 className="flex min-w-0 items-center gap-2">
				{compact ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									aria-label={
										view
											? tl("{objectLabel}, {viewLabel}. Switch records", {
													objectLabel,
													viewLabel: view.label,
												})
											: tl("{objectLabel}. Switch records", { objectLabel })
									}
									className="-ms-2 min-w-0 px-2"
									size="sm"
									type="button"
									variant="ghost"
								/>
							}
						>
							{title}
							{countLabel}
							<ChevronDown
								aria-hidden="true"
								className="size-3.5 text-muted-foreground"
							/>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="start"
							className="w-56"
							drawerLabel="Records"
						>
							<DropdownMenuGroup>
								<DropdownMenuLabel>Objects</DropdownMenuLabel>
								{RECORDS_OBJECTS.map((option) => {
									const OptionIcon = RECORDS_OBJECT_ICONS[option];
									return (
										<DropdownMenuItem
											className={MENU_ITEM}
											key={option}
											onClick={() => onSelectObject(option)}
										>
											<OptionIcon aria-hidden="true" />
											{RECORDS_OBJECT_LABELS[option].plural}
										</DropdownMenuItem>
									);
								})}
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								<DropdownMenuLabel>Views</DropdownMenuLabel>
								{RECORDS_VIEWS.map((option) => (
									<DropdownMenuItem
										className={MENU_ITEM}
										key={option.id}
										onClick={() => onSelectView(option.id)}
									>
										<ListFilter aria-hidden="true" />
										{option.label}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					title
				)}
				{compact ? null : countLabel}
			</h1>
			<Button
				className="ms-auto"
				onClick={onStart}
				size="sm"
				type="button"
				variant="outline"
			>
				<Plus aria-hidden="true" data-icon="inline-start" />
				New thread
			</Button>
		</header>
	);
}

/**
 * The view bar under the header: layout switch, sort, filter (with chips for
 * what is active), and search, in Attio's order.
 */
export function RecordsToolbar({
	filter,
	layout,
	onFilterChange,
	onLayoutChange,
	onQueryChange,
	onSearchKeyDown,
	onSortChange,
	query,
	searchLabel,
	searchRef,
	sort,
}: {
	filter: RecordsFilter;
	layout: RecordsLayout;
	onFilterChange: (filter: RecordsFilter) => void;
	onLayoutChange: (layout: RecordsLayout) => void;
	onQueryChange: (query: string) => void;
	onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
	onSortChange: (sort: RecordsSort) => void;
	query: string;
	searchLabel: string;
	searchRef: RefObject<HTMLInputElement | null>;
	sort: RecordsSort;
}) {
	const tl = useLiteralMessages();
	const filterCount = recordsFilterCount(filter);
	const SortIcon =
		sort.direction === "desc" ? ArrowDownWideNarrow : ArrowUpNarrowWide;
	const toggleStatus = (status: (typeof RECORDS_STATUS_ORDER)[number]) => {
		const statuses = filter.statuses.includes(status)
			? filter.statuses.filter((value) => value !== status)
			: RECORDS_STATUS_ORDER.filter(
					(value) => value === status || filter.statuses.includes(value)
				);
		onFilterChange({ ...filter, statuses });
	};
	return (
		<div
			aria-label="View options"
			className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-4"
			role="toolbar"
		>
			<ToggleGroup
				appearance="segmented"
				aria-label="Layout"
				multiple={false}
				onValueChange={(values: string[]) => {
					const value = values[0];
					if (value === "table" || value === "board") {
						onLayoutChange(value);
					}
				}}
				spacing={0}
				value={[layout]}
			>
				<ToggleGroupItem
					aria-label="Table"
					density="segmented"
					title="Table"
					value="table"
				>
					<Table2 aria-hidden="true" />
					<span className="max-sm:hidden">Table</span>
				</ToggleGroupItem>
				<ToggleGroupItem
					aria-label="Board by status"
					density="segmented"
					title="Board by status"
					value="board"
				>
					<Columns3 aria-hidden="true" />
					<span className="max-sm:hidden">Board</span>
				</ToggleGroupItem>
			</ToggleGroup>
			<span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={tl(
								"Sort: {sortLabel}, {direction, select, asc {ascending} other {descending}}",
								{
									direction: sort.direction,
									sortLabel: RECORDS_SORT_LABELS[sort.key],
								}
							)}
							className="text-foreground/80"
							size="dense"
							type="button"
							variant="ghost"
						/>
					}
				>
					<SortIcon aria-hidden="true" data-icon="inline-start" />
					<span className="max-md:hidden">{RECORDS_SORT_LABELS[sort.key]}</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-52" drawerLabel="Sort">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Sort by</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							onValueChange={(value: unknown) => {
								const key = RECORDS_SORT_KEYS.find(
									(candidate) => candidate === value
								);
								if (key) {
									onSortChange({ ...sort, key });
								}
							}}
							value={sort.key}
						>
							{RECORDS_SORT_KEYS.map((key) => (
								<DropdownMenuRadioItem
									className={MENU_ITEM}
									key={key}
									value={key}
								>
									{RECORDS_SORT_LABELS[key]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuRadioGroup
						onValueChange={(value: unknown) => {
							if (value === "asc" || value === "desc") {
								onSortChange({ ...sort, direction: value });
							}
						}}
						value={sort.direction}
					>
						<DropdownMenuRadioItem className={MENU_ITEM} value="asc">
							Ascending
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem className={MENU_ITEM} value="desc">
							Descending
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={
								filterCount > 0
									? tl("Filter, {filterCount} active", { filterCount })
									: "Filter"
							}
							className="text-foreground/80"
							size="dense"
							type="button"
							variant="ghost"
						/>
					}
				>
					<ListFilter aria-hidden="true" data-icon="inline-start" />
					<span className="max-md:hidden">Filter</span>
					{filterCount > 0 ? (
						<span className="text-muted-foreground tabular-nums">
							{filterCount}
						</span>
					) : null}
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="w-60"
					drawerLabel="Filter"
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Status</DropdownMenuLabel>
						{RECORDS_STATUS_ORDER.map((status) => (
							<DropdownMenuCheckboxItem
								checked={filter.statuses.includes(status)}
								className={MENU_ITEM}
								key={status}
								onCheckedChange={() => toggleStatus(status)}
							>
								<BoardStatusDot className="mx-1" status={status} />
								{THREAD_STATUS_LABELS[status]}
							</DropdownMenuCheckboxItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuLabel>Activity</DropdownMenuLabel>
						<DropdownMenuCheckboxItem
							checked={filter.needsYou}
							className={MENU_ITEM}
							onCheckedChange={(checked: boolean) =>
								onFilterChange({ ...filter, needsYou: checked })
							}
						>
							Has threads that need you
						</DropdownMenuCheckboxItem>
						<DropdownMenuCheckboxItem
							checked={filter.recentHours !== null}
							className={MENU_ITEM}
							onCheckedChange={(checked: boolean) =>
								onFilterChange({ ...filter, recentHours: checked ? 24 : null })
							}
						>
							Active in the last 24 hours
						</DropdownMenuCheckboxItem>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden max-lg:hidden">
				<FilterChips filter={filter} onFilterChange={onFilterChange} />
			</div>
			<InputGroup className="ms-auto h-8 w-56 min-w-0 shrink max-lg:flex-1">
				<InputGroupAddon>
					<Search aria-hidden="true" />
				</InputGroupAddon>
				<InputGroupInput
					aria-label={searchLabel}
					className="text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={onSearchKeyDown}
					placeholder="Search"
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
						<Kbd className="max-md:hidden">/</Kbd>
					)}
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}
