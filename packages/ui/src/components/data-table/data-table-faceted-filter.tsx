"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import "../../types/data-table.ts";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Column } from "@tanstack/react-table";
import { Check, PlusCircle, XCircle } from "lucide-react";
import type { MouseEvent } from "react";
import type { DataTableFilterOption } from "../../types/data-table.ts";

interface DataTableFacetedFilterProps<TData, TValue> {
	column: Column<TData, TValue>;
	multiple?: boolean;
	options: DataTableFilterOption[];
	title?: string;
}

function readSelectedValues(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

/** A dashed "+ Title" button that filters a column to one or more options. */
export function DataTableFacetedFilter<TData, TValue>({
	column,
	title = column.columnDef.meta?.label ?? column.id,
	options,
	multiple = false,
}: DataTableFacetedFilterProps<TData, TValue>) {
	const tl = useLiteralMessages();
	const selectedValues = readSelectedValues(column.getFilterValue());
	const selected = new Set(selectedValues);
	const hasSelection = selected.size > 0;

	function onItemSelect(value: string) {
		let next: string[];
		if (multiple) {
			next = selected.has(value)
				? selectedValues.filter((entry) => entry !== value)
				: [...selectedValues, value];
		} else {
			next = selected.has(value) ? [] : [value];
		}
		column.setFilterValue(next.length > 0 ? next : undefined);
	}

	function onReset(event?: MouseEvent) {
		event?.stopPropagation();
		column.setFilterValue(undefined);
	}

	const selectedOptions = options.filter((option) =>
		selected.has(option.value)
	);

	return (
		<Popover>
			<PopoverTrigger
				render={<Button className="border-dashed" variant="outline" />}
			>
				{hasSelection ? (
					<XCircle
						aria-label={tl("Clear {title} filter", { title })}
						className="opacity-70 transition-opacity hover:opacity-100"
						onClick={onReset}
					/>
				) : (
					<PlusCircle />
				)}
				{title}
				{hasSelection ? (
					<>
						<Separator className="mx-0.5 h-4" orientation="vertical" />
						<span className="flex items-center gap-1">
							{selectedOptions.length > 2 ? (
								<Badge variant="secondary">
									{tl("{count} selected", {
										count: String(selectedOptions.length),
									})}
								</Badge>
							) : (
								selectedOptions.map((option) => (
									<Badge key={option.value} variant="secondary">
										{option.label}
									</Badge>
								))
							)}
						</span>
					</>
				) : null}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-50 p-0">
				<Command>
					<CommandInput placeholder={title} />
					<CommandList className="max-h-full">
						<CommandEmpty>No results found.</CommandEmpty>
						<CommandGroup className="max-h-75 scroll-py-1 overflow-y-auto overflow-x-hidden">
							{options.map((option) => {
								const isSelected = selected.has(option.value);
								return (
									<CommandItem
										key={option.value}
										onSelect={() => onItemSelect(option.value)}
										value={option.label}
									>
										<span
											className={cn(
												"flex size-4 items-center justify-center rounded-sm border border-primary",
												isSelected
													? "bg-primary text-primary-foreground"
													: "opacity-50 [&_svg]:invisible"
											)}
										>
											<Check className="size-3" />
										</span>
										{option.icon ? <option.icon /> : null}
										<span className="flex-1 truncate">{option.label}</span>
										{option.count === undefined ? null : (
											<span className="ms-auto font-mono text-xs">
												{option.count}
											</span>
										)}
									</CommandItem>
								);
							})}
						</CommandGroup>
						{hasSelection ? (
							<>
								<CommandSeparator />
								<CommandGroup>
									<CommandItem
										className="justify-center text-center"
										onSelect={() => onReset()}
									>
										Clear filters
									</CommandItem>
								</CommandGroup>
							</>
						) : null}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
