"use client";

import "../../types/data-table.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Column, Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { DataTableFacetedFilter } from "./data-table-faceted-filter.tsx";
import { DataTableViewOptions } from "./data-table-view-options.tsx";

interface DataTableToolbarProps<TData> extends ComponentProps<"div"> {
	table: Table<TData>;
}

/**
 * Renders one filter per column whose `meta.variant` is set (and whose
 * `enableColumnFilter` is true), a reset button once anything is filtered, any
 * `children` actions, and the column visibility menu.
 */
export function DataTableToolbar<TData>({
	table,
	children,
	className,
	...props
}: DataTableToolbarProps<TData>) {
	const columns = table
		.getAllColumns()
		.filter((column) => column.getCanFilter());
	const isFiltered = table.getState().columnFilters.length > 0;

	return (
		<div
			className={cn(
				"flex w-full items-start justify-between gap-2 p-1",
				className
			)}
			data-slot="data-table-toolbar"
			{...props}
		>
			<div className="flex flex-1 flex-wrap items-center gap-2">
				{columns.map((column) => (
					<DataTableToolbarFilter column={column} key={column.id} />
				))}
				{isFiltered ? (
					<Button
						aria-label="Reset filters"
						className="border-dashed"
						onClick={() => table.resetColumnFilters()}
						variant="outline"
					>
						<X />
						Reset
					</Button>
				) : null}
			</div>
			<div className="flex items-center gap-2">
				{children}
				<DataTableViewOptions table={table} />
			</div>
		</div>
	);
}

function DataTableToolbarFilter<TData>({
	column,
}: {
	column: Column<TData, unknown>;
}) {
	const meta = column.columnDef.meta;
	if (!meta?.variant) {
		return null;
	}
	const title = meta.label ?? column.id;

	if (meta.variant === "text") {
		const value = column.getFilterValue();
		return (
			<Input
				aria-label={title}
				className="w-40 lg:w-56"
				onChange={(event) =>
					column.setFilterValue(event.target.value || undefined)
				}
				placeholder={meta.placeholder ?? title}
				value={typeof value === "string" ? value : ""}
			/>
		);
	}

	return (
		<DataTableFacetedFilter
			column={column}
			multiple={meta.variant === "multiSelect"}
			options={meta.options ?? []}
			title={title}
		/>
	);
}
