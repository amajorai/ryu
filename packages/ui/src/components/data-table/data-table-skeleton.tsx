import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps } from "react";

interface DataTableSkeletonProps extends ComponentProps<"div"> {
	columnCount: number;
	filterCount?: number;
	rowCount?: number;
}

/** Placeholder with the data table's shape while its first page loads. */
export function DataTableSkeleton({
	columnCount,
	filterCount = 0,
	rowCount = 10,
	className,
	...props
}: DataTableSkeletonProps) {
	const columns = Array.from({ length: columnCount }, (_, i) => `c${i}`);
	const rows = Array.from({ length: rowCount }, (_, i) => `r${i}`);
	const filters = Array.from({ length: filterCount }, (_, i) => `f${i}`);

	return (
		<div
			aria-busy="true"
			className={cn("flex w-full flex-col gap-2.5 overflow-auto", className)}
			{...props}
		>
			<div className="flex w-full items-center justify-between gap-2 overflow-auto p-1">
				<div className="flex flex-1 items-center gap-2">
					{filters.map((key) => (
						<Skeleton className="h-9 w-[4.5rem] border-dashed" key={key} />
					))}
				</div>
				<Skeleton className="ms-auto hidden h-9 w-[4.5rem] lg:flex" />
			</div>
			<div className="rounded-md border">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							{columns.map((key) => (
								<TableHead key={key}>
									<Skeleton className="h-6 w-full" />
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((rowKey) => (
							<TableRow className="hover:bg-transparent" key={rowKey}>
								{columns.map((key) => (
									<TableCell key={key}>
										<Skeleton className="h-6 w-full" />
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
