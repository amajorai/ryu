"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Table } from "@tanstack/react-table";
import {
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
} from "lucide-react";
import { type ComponentProps, useId } from "react";

interface DataTablePaginationProps<TData> extends ComponentProps<"div"> {
	pageSizeOptions?: number[];
	table: Table<TData>;
}

export function DataTablePagination<TData>({
	table,
	pageSizeOptions = [10, 20, 30, 40, 50],
	className,
	...props
}: DataTablePaginationProps<TData>) {
	const tl = useLiteralMessages();
	const pageSizeLabelId = useId();
	const { pageIndex, pageSize } = table.getState().pagination;
	const pageCount = Math.max(table.getPageCount(), 1);
	const selectedRowCount = table.getFilteredSelectedRowModel().rows.length;
	const canPreviousPage = table.getCanPreviousPage();
	const canNextPage = table.getCanNextPage();

	return (
		<div
			className={cn(
				"flex w-full flex-col-reverse items-center justify-between gap-4 overflow-auto p-1 sm:flex-row sm:gap-8",
				className
			)}
			data-slot="data-table-pagination"
			{...props}
		>
			<div
				className="flex-1 whitespace-nowrap text-muted-foreground text-sm"
				role="status"
			>
				{table.options.enableRowSelection
					? tl(
							"{count, plural, one {{countText} row selected.} other {{countText} rows selected.}}",
							{ count: selectedRowCount, countText: String(selectedRowCount) }
						)
					: null}
			</div>
			<div className="flex flex-col-reverse items-center gap-4 sm:flex-row sm:gap-6 lg:gap-8">
				<div className="flex items-center gap-2">
					<p
						className="whitespace-nowrap font-medium text-sm"
						id={pageSizeLabelId}
					>
						Rows per page
					</p>
					<Select
						onValueChange={(value) => {
							if (value == null) {
								return;
							}
							table.setPageSize(Number(value));
						}}
						value={`${pageSize}`}
					>
						<SelectTrigger aria-labelledby={pageSizeLabelId} className="w-18">
							<SelectValue placeholder={pageSize} />
						</SelectTrigger>
						<SelectContent side="top">
							<SelectGroup>
								{pageSizeOptions.map((option) => (
									<SelectItem key={option} value={`${option}`}>
										{option}
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>
				<div
					className="flex items-center justify-center font-medium text-sm"
					role="status"
				>
					{tl("Page {page} of {pageCount}", {
						page: String(pageIndex + 1),
						pageCount: String(pageCount),
					})}
				</div>
				<div className="flex items-center gap-2">
					<Button
						aria-label="Go to first page"
						className="hidden lg:flex"
						disabled={!canPreviousPage}
						onClick={() => table.setPageIndex(0)}
						size="icon"
						variant="outline"
					>
						<ChevronsLeft className="rtl:rotate-180" />
					</Button>
					<Button
						aria-label="Go to previous page"
						disabled={!canPreviousPage}
						onClick={() => table.previousPage()}
						size="icon"
						variant="outline"
					>
						<ChevronLeft className="rtl:rotate-180" />
					</Button>
					<Button
						aria-label="Go to next page"
						disabled={!canNextPage}
						onClick={() => table.nextPage()}
						size="icon"
						variant="outline"
					>
						<ChevronRight className="rtl:rotate-180" />
					</Button>
					<Button
						aria-label="Go to last page"
						className="hidden lg:flex"
						disabled={!canNextPage}
						onClick={() => table.setPageIndex(pageCount - 1)}
						size="icon"
						variant="outline"
					>
						<ChevronsRight className="rtl:rotate-180" />
					</Button>
				</div>
			</div>
		</div>
	);
}
