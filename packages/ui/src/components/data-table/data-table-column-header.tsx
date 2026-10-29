"use client";

import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Column, SortDirection } from "@tanstack/react-table";
import { ChevronDown, ChevronsUpDown, ChevronUp, EyeOff } from "lucide-react";

interface DataTableColumnHeaderProps<TData, TValue> {
	className?: string;
	column: Column<TData, TValue>;
	label: string;
}

/** A column title that opens sort / hide actions when the column allows them. */
export function DataTableColumnHeader<TData, TValue>({
	column,
	label,
	className,
}: DataTableColumnHeaderProps<TData, TValue>) {
	if (!(column.getCanSort() || column.getCanHide())) {
		return <div className={cn(className)}>{label}</div>;
	}

	const sortDirection = column.getIsSorted();

	function onSortDirectionChange(direction: SortDirection) {
		if (sortDirection === direction) {
			column.clearSorting();
			return;
		}
		column.toggleSorting(direction === "desc");
	}

	let sortIcon = <ChevronsUpDown />;
	if (sortDirection === "desc") {
		sortIcon = <ChevronDown />;
	} else if (sortDirection === "asc") {
		sortIcon = <ChevronUp />;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"-ms-1.5 flex h-8 items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring data-popup-open:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
					className
				)}
			>
				{label}
				{column.getCanSort() ? sortIcon : null}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-28">
				{column.getCanSort() ? (
					<>
						<DropdownMenuCheckboxItem
							checked={sortDirection === "asc"}
							onClick={() => onSortDirectionChange("asc")}
						>
							<ChevronUp />
							Asc
						</DropdownMenuCheckboxItem>
						<DropdownMenuCheckboxItem
							checked={sortDirection === "desc"}
							onClick={() => onSortDirectionChange("desc")}
						>
							<ChevronDown />
							Desc
						</DropdownMenuCheckboxItem>
					</>
				) : null}
				{column.getCanHide() ? (
					<DropdownMenuCheckboxItem
						checked={!column.getIsVisible()}
						onClick={() => column.toggleVisibility(false)}
					>
						<EyeOff />
						Hide
					</DropdownMenuCheckboxItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
