"use client";

import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
import { DataGridCellWrapper } from "@ryu/ui/components/data-grid/data-grid-cell-wrapper.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import { useBadgeOverflow } from "@ryu/ui/hooks/use-badge-overflow.ts";
import {
	getCellKey,
	getLineCount,
	getOptionColorClass,
} from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { DataGridCellProps } from "@ryu/ui/types/data-grid.ts";
import { Check, X } from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

export function MultiSelectCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	isFocused,
	isEditing,
	isSelected,
	isSearchMatch,
	isActiveSearchMatch,
	readOnly,
}: DataGridCellProps<TData>) {
	const cellValue = useMemo(() => {
		// SAFETY: The multi-select column accessor supplies its schema-defined array of option strings.
		const value = cell.getValue() as string[];
		return value ?? [];
	}, [cell]);

	const cellKey = getCellKey(rowIndex, columnId);
	const prevCellKeyRef = useRef(cellKey);

	const [selectedValues, setSelectedValues] = useState<string[]>(cellValue);
	const [searchValue, setSearchValue] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const cellOpts = cell.column.columnDef.meta?.cell;
	const options = useMemo(
		() => (cellOpts?.variant === "multi-select" ? cellOpts.options : []),
		[cellOpts]
	);
	const optionByValue = useMemo(
		() => new Map(options.map((option) => [option.value, option])),
		[options]
	);
	const sideOffset = -(containerRef.current?.clientHeight ?? 0);

	const prevCellValueRef = useRef(cellValue);
	if (cellValue !== prevCellValueRef.current) {
		prevCellValueRef.current = cellValue;
		setSelectedValues(cellValue);
	}

	if (prevCellKeyRef.current !== cellKey) {
		prevCellKeyRef.current = cellKey;
		setSearchValue("");
	}

	const onValueChange = useCallback(
		(value: string) => {
			if (readOnly) {
				return;
			}
			let newValues: string[] = [];
			setSelectedValues((curr) => {
				newValues = curr.includes(value)
					? curr.filter((v) => v !== value)
					: [...curr, value];
				return newValues;
			});
			queueMicrotask(() => {
				tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
				inputRef.current?.focus();
			});
			setSearchValue("");
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const removeValue = useCallback(
		(valueToRemove: string, event?: MouseEvent) => {
			if (readOnly) {
				return;
			}
			event?.stopPropagation();
			event?.preventDefault();
			let newValues: string[] = [];
			setSelectedValues((curr) => {
				newValues = curr.filter((v) => v !== valueToRemove);
				return newValues;
			});
			queueMicrotask(() => {
				tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
				inputRef.current?.focus();
			});
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const clearAll = useCallback(() => {
		if (readOnly) {
			return;
		}
		setSelectedValues([]);
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: [] });
		queueMicrotask(() => inputRef.current?.focus());
	}, [tableMeta, rowIndex, columnId, readOnly]);

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (open && !readOnly) {
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else {
				setSearchValue("");
				tableMeta?.onCellEditingStop?.();
			}
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	// Base UI's Popover has no `onOpenAutoFocus`; focus the search input on open.
	useEffect(() => {
		if (!isEditing) {
			return;
		}
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [isEditing]);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (isEditing && event.key === "Escape") {
				event.preventDefault();
				setSelectedValues(cellValue);
				setSearchValue("");
				tableMeta?.onCellEditingStop?.();
			} else if (isFocused && event.key === "Tab") {
				event.preventDefault();
				setSearchValue("");
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		},
		[isEditing, isFocused, cellValue, tableMeta]
	);

	const onInputKeyDown = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Backspace" && searchValue === "") {
				event.preventDefault();
				let newValues: string[] | null = null;
				setSelectedValues((curr) => {
					if (curr.length === 0) {
						return curr;
					}
					newValues = curr.slice(0, -1);
					return newValues;
				});
				queueMicrotask(() => {
					if (newValues !== null) {
						tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValues });
					}
					inputRef.current?.focus();
				});
			}
			if (event.key === "Escape") {
				event.stopPropagation();
			}
		},
		[searchValue, tableMeta, rowIndex, columnId]
	);

	const displayLabels = selectedValues
		.map((val) => optionByValue.get(val)?.label ?? val)
		.filter(Boolean);

	const selectedValuesSet = useMemo(
		() => new Set(selectedValues),
		[selectedValues]
	);

	const lineCount = getLineCount(rowHeight);

	const { visibleItems: visibleLabels, hiddenCount: hiddenBadgeCount } =
		useBadgeOverflow({
			items: displayLabels,
			getLabel: (label) => label,
			containerRef,
			lineCount,
		});

	return (
		<DataGridCellWrapper<TData>
			cell={cell}
			columnId={columnId}
			isActiveSearchMatch={isActiveSearchMatch}
			isEditing={isEditing}
			isFocused={isFocused}
			isSearchMatch={isSearchMatch}
			isSelected={isSelected}
			onKeyDown={onWrapperKeyDown}
			readOnly={readOnly}
			ref={containerRef}
			rowHeight={rowHeight}
			rowIndex={rowIndex}
			tableMeta={tableMeta}
		>
			{isEditing ? (
				<Popover onOpenChange={onOpenChange} open={isEditing}>
					<PopoverAnchor asChild>
						<div className="absolute inset-0" />
					</PopoverAnchor>
					<PopoverContent
						align="start"
						className="w-[300px] rounded-none p-0"
						data-grid-cell-editor=""
						sideOffset={sideOffset}
					>
						<Command className="**:data-[slot=command-input-wrapper]:h-auto **:data-[slot=command-input-wrapper]:border-none **:data-[slot=command-input-wrapper]:p-0 [&_[data-slot=command-input-wrapper]_svg]:hidden">
							<div className="flex min-h-9 flex-wrap items-center gap-1 border-b px-3 py-1.5">
								{selectedValues.map((value) => {
									const label = optionByValue.get(value)?.label ?? value;

									return (
										<Badge
											className={cn(
												"gap-1 px-1.5 py-px",
												getOptionColorClass(
													optionByValue.get(value ?? "")?.color
												)
											)}
											key={value}
											variant="secondary"
										>
											{label}
											<button
												onClick={(event) => removeValue(value, event)}
												onPointerDown={(event) => {
													event.preventDefault();
													event.stopPropagation();
												}}
												type="button"
											>
												<X className="size-3" />
											</button>
										</Badge>
									);
								})}
								<CommandInput
									className="h-auto flex-1 p-0"
									onKeyDown={onInputKeyDown}
									onValueChange={setSearchValue}
									placeholder="Search…"
									ref={inputRef}
									value={searchValue}
								/>
							</div>
							<CommandList className="max-h-full">
								<CommandEmpty>No options found.</CommandEmpty>
								<CommandGroup className="max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden">
									{options.map((option) => {
										const isSelected = selectedValuesSet.has(option.value);

										return (
											<CommandItem
												key={option.value}
												onSelect={() => onValueChange(option.value)}
												value={option.label}
											>
												<div
													className={cn(
														"flex size-4 items-center justify-center rounded-sm border border-primary",
														isSelected
															? "bg-primary text-primary-foreground"
															: "opacity-50 [&_svg]:invisible"
													)}
												>
													<Check className="size-3" />
												</div>
												<Badge
													className={cn(
														"px-1.5 py-px font-normal",
														getOptionColorClass(option.color)
													)}
													variant="secondary"
												>
													{option.label}
												</Badge>
											</CommandItem>
										);
									})}
								</CommandGroup>
								{selectedValues.length > 0 && (
									<>
										<CommandSeparator />
										<CommandGroup>
											<CommandItem
												className="justify-center text-muted-foreground"
												onSelect={clearAll}
											>
												Clear all
											</CommandItem>
										</CommandGroup>
									</>
								)}
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			) : null}
			{displayLabels.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1 overflow-hidden">
					{visibleLabels.map((label, index) => (
						<Badge
							className={cn(
								"px-1.5 py-px",
								getOptionColorClass(
									optionByValue.get(selectedValues[index] ?? "")?.color
								)
							)}
							key={selectedValues[index]}
							variant="secondary"
						>
							{label}
						</Badge>
					))}
					{hiddenBadgeCount > 0 && (
						<Badge
							className="px-1.5 py-px text-muted-foreground"
							variant="outline"
						>
							+{hiddenBadgeCount}
						</Badge>
					)}
				</div>
			) : null}
		</DataGridCellWrapper>
	);
}
