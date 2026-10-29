"use client";

import "../types/data-table.ts";
import {
	type ColumnFiltersState,
	getCoreRowModel,
	getFacetedRowModel,
	getFacetedUniqueValues,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	type PaginationState,
	type RowSelectionState,
	type SortingState,
	type TableOptions,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import { useState } from "react";

const DEFAULT_PAGE_SIZE = 10;

interface DataTableInitialState {
	columnFilters?: ColumnFiltersState;
	columnVisibility?: VisibilityState;
	pagination?: Partial<PaginationState>;
	sorting?: SortingState;
}

/**
 * The table's paging, sorting, and filter state. Create it with this hook when
 * the caller must read the state before the table exists (a server-mode query
 * keyed on it), then pass it to `useDataTable` as `tableState`.
 */
export function useDataTableState(initialState?: DataTableInitialState) {
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: initialState?.pagination?.pageIndex ?? 0,
		pageSize: initialState?.pagination?.pageSize ?? DEFAULT_PAGE_SIZE,
	});
	const [sorting, setSorting] = useState<SortingState>(
		initialState?.sorting ?? []
	);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
		initialState?.columnFilters ?? []
	);
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
		initialState?.columnVisibility ?? {}
	);
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	return {
		pagination,
		setPagination,
		sorting,
		setSorting,
		columnFilters,
		setColumnFilters,
		columnVisibility,
		setColumnVisibility,
		rowSelection,
		setRowSelection,
	};
}

export type DataTableState = ReturnType<typeof useDataTableState>;

type UseDataTableProps<TData> = Omit<
	TableOptions<TData>,
	| "state"
	| "initialState"
	| "pageCount"
	| "getCoreRowModel"
	| "manualFiltering"
	| "manualPagination"
	| "manualSorting"
> & {
	initialState?: DataTableInitialState;
	/** State from `useDataTableState`; the hook owns its own when omitted. */
	tableState?: DataTableState;
} & (
		| {
				/**
				 * The caller fetches one page at a time with the table state
				 * (`pagination`, `sorting`, `columnFilters`) and passes the total
				 * page count back in.
				 */
				mode?: "server";
				pageCount: number;
		  }
		| { mode: "client"; pageCount?: never }
	);

/**
 * The Dice UI (tablecn) `useDataTable` hook on TanStack Table v8. State lives
 * in React rather than the URL so a table can sit inside a tabbed page without
 * fighting its query string. In `server` mode a filter or sort change returns
 * to the first page, matching the registry behaviour.
 */
export function useDataTable<TData>({
	columns,
	mode = "server",
	pageCount,
	initialState,
	tableState,
	...props
}: UseDataTableProps<TData>) {
	const isServer = mode === "server";
	const ownState = useDataTableState(initialState);
	const {
		pagination,
		setPagination,
		sorting,
		setSorting,
		columnFilters,
		setColumnFilters,
		columnVisibility,
		setColumnVisibility,
		rowSelection,
		setRowSelection,
	} = tableState ?? ownState;

	const table = useReactTable({
		...props,
		columns,
		pageCount: isServer ? pageCount : undefined,
		state: {
			pagination,
			sorting,
			columnFilters,
			columnVisibility,
			rowSelection,
		},
		defaultColumn: {
			...props.defaultColumn,
			enableColumnFilter: false,
		},
		enableRowSelection: props.enableRowSelection ?? false,
		onPaginationChange: setPagination,
		onSortingChange: (updater) => {
			setSorting(updater);
			if (isServer) {
				setPagination((current) => ({ ...current, pageIndex: 0 }));
			}
		},
		onColumnFiltersChange: (updater) => {
			setColumnFilters(updater);
			if (isServer) {
				setPagination((current) => ({ ...current, pageIndex: 0 }));
			}
		},
		onColumnVisibilityChange: setColumnVisibility,
		onRowSelectionChange: setRowSelection,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: isServer ? undefined : getFilteredRowModel(),
		getPaginationRowModel: isServer ? undefined : getPaginationRowModel(),
		getSortedRowModel: isServer ? undefined : getSortedRowModel(),
		getFacetedRowModel: getFacetedRowModel(),
		getFacetedUniqueValues: getFacetedUniqueValues(),
		manualPagination: isServer,
		manualSorting: isServer,
		manualFiltering: isServer,
	});

	return { table, pagination, sorting, columnFilters };
}
