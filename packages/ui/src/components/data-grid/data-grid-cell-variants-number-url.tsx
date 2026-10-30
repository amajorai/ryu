"use client";

import { DataGridCellWrapper } from "@ryu/ui/components/data-grid/data-grid-cell-wrapper.tsx";
import { getUrlHref } from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { DataGridCellProps } from "@ryu/ui/types/data-grid.ts";
import {
	type ChangeEvent,
	type ComponentProps,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

export function NumberCell<TData>({
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
	const initialValue = cell.getValue();
	const [value, setValue] = useState(String(initialValue ?? ""));
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const cellOpts = cell.column.columnDef.meta?.cell;
	const numberCellOpts = cellOpts?.variant === "number" ? cellOpts : null;
	const min = numberCellOpts?.min;
	const max = numberCellOpts?.max;
	const step = numberCellOpts?.step;

	const prevIsEditingRef = useRef(false);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(String(initialValue ?? ""));
	}

	const onBlur = useCallback(() => {
		const numValue = value === "" ? null : Number(value);
		if (!readOnly && numValue !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: numValue });
		}
		tableMeta?.onCellEditingStop?.();
	}, [tableMeta, rowIndex, columnId, initialValue, value, readOnly]);

	const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
		setValue(event.target.value);
	}, []);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (isEditing) {
				if (event.key === "Enter") {
					event.preventDefault();
					const numValue = value === "" ? null : Number(value);
					if (numValue !== initialValue) {
						tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: numValue });
					}
					tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
				} else if (event.key === "Tab") {
					event.preventDefault();
					const numValue = value === "" ? null : Number(value);
					if (numValue !== initialValue) {
						tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: numValue });
					}
					tableMeta?.onCellEditingStop?.({
						direction: event.shiftKey ? "left" : "right",
					});
				} else if (event.key === "Escape") {
					event.preventDefault();
					setValue(String(initialValue ?? ""));
					inputRef.current?.blur();
				}
			} else if (isFocused) {
				// Handle Backspace to start editing with empty value
				if (event.key === "Backspace") {
					setValue("");
				} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
					// Handle typing to pre-fill the value when editing starts
					setValue(event.key);
				}
			}
		},
		[isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId, value]
	);

	useEffect(() => {
		const wasEditing = prevIsEditingRef.current;
		prevIsEditingRef.current = isEditing;

		// Only focus when we start editing (transition from false to true)
		if (isEditing && !wasEditing && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isEditing]);

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
				<input
					className="w-full border-none bg-transparent p-0 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
					max={max}
					min={min}
					onBlur={onBlur}
					onChange={onChange}
					ref={inputRef}
					step={step}
					type="number"
					value={value}
				/>
			) : (
				<span data-slot="grid-cell-content">{value}</span>
			)}
		</DataGridCellWrapper>
	);
}

export function UrlCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	isEditing,
	isFocused,
	isSelected,
	isSearchMatch,
	isActiveSearchMatch,
	readOnly,
}: DataGridCellProps<TData>) {
	// SAFETY: This renderer is selected for the text cell schema; its column accessor returns a string.
	const initialValue = cell.getValue() as string;
	const [value, setValue] = useState(initialValue ?? "");
	const cellRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const prevIsEditingRef = useRef(false);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(initialValue ?? "");
		if (cellRef.current && !isEditing) {
			cellRef.current.textContent = initialValue ?? "";
		}
	}

	const onBlur = useCallback(() => {
		const currentValue = cellRef.current?.textContent?.trim() ?? "";

		if (!readOnly && currentValue !== initialValue) {
			tableMeta?.onDataUpdate?.({
				rowIndex,
				columnId,
				value: currentValue || null,
			});
		}
		tableMeta?.onCellEditingStop?.();
	}, [tableMeta, rowIndex, columnId, initialValue, readOnly]);

	const onInput = useCallback(
		(event: Parameters<NonNullable<ComponentProps<"div">["onInput"]>>[0]) => {
			const currentValue = event.currentTarget.textContent ?? "";
			setValue(currentValue);
		},
		[]
	);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (isEditing) {
				if (event.key === "Enter") {
					event.preventDefault();
					const currentValue = cellRef.current?.textContent?.trim() ?? "";
					if (!readOnly && currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue || null,
						});
					}
					tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
				} else if (event.key === "Tab") {
					event.preventDefault();
					const currentValue = cellRef.current?.textContent?.trim() ?? "";
					if (!readOnly && currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue || null,
						});
					}
					tableMeta?.onCellEditingStop?.({
						direction: event.shiftKey ? "left" : "right",
					});
				} else if (event.key === "Escape") {
					event.preventDefault();
					setValue(initialValue ?? "");
					cellRef.current?.blur();
				}
			} else if (
				isFocused &&
				!readOnly &&
				event.key.length === 1 &&
				!event.ctrlKey &&
				!event.metaKey
			) {
				// Handle typing to pre-fill the value when editing starts
				setValue(event.key);

				queueMicrotask(() => {
					if (cellRef.current && cellRef.current.contentEditable === "true") {
						cellRef.current.textContent = event.key;
						const range = document.createRange();
						const selection = window.getSelection();
						range.selectNodeContents(cellRef.current);
						range.collapse(false);
						selection?.removeAllRanges();
						selection?.addRange(range);
					}
				});
			}
		},
		[
			isEditing,
			isFocused,
			initialValue,
			tableMeta,
			rowIndex,
			columnId,
			readOnly,
		]
	);

	const onLinkClick = useCallback(
		(event: MouseEvent<HTMLAnchorElement>) => {
			if (isEditing) {
				event.preventDefault();
				return;
			}

			// Check if URL was rejected due to dangerous protocol
			const href = getUrlHref(value);
			if (!href) {
				event.preventDefault();
				toast.error("Invalid URL", {
					description:
						"URL contains a dangerous protocol (javascript:, data:, vbscript:, or file:)",
				});
				return;
			}

			// Stop propagation to prevent grid from interfering with link navigation
			event.stopPropagation();
		},
		[isEditing, value]
	);

	useEffect(() => {
		const wasEditing = prevIsEditingRef.current;
		prevIsEditingRef.current = isEditing;

		if (isEditing && !wasEditing && cellRef.current) {
			cellRef.current.focus();

			if (!cellRef.current.textContent && value) {
				cellRef.current.textContent = value;
			}

			if (cellRef.current.textContent) {
				const range = document.createRange();
				const selection = window.getSelection();
				range.selectNodeContents(cellRef.current);
				range.collapse(false);
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
		}
	}, [isEditing, value]);

	const displayValue = isEditing ? "" : (value ?? "");
	const urlHref = displayValue ? getUrlHref(displayValue) : "";
	const isDangerousUrl = displayValue && !urlHref;

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
			{!isEditing && displayValue ? (
				<div
					className="size-full overflow-hidden"
					data-slot="grid-cell-content"
				>
					<a
						className="truncate text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 data-invalid:cursor-not-allowed data-focused:text-foreground data-invalid:text-status-destructive data-focused:decoration-foreground/50 data-invalid:decoration-destructive/50 data-focused:hover:decoration-foreground/70 data-invalid:hover:decoration-destructive/70"
						data-focused={isFocused && !isDangerousUrl ? "" : undefined}
						data-invalid={isDangerousUrl ? "" : undefined}
						href={urlHref}
						onClick={onLinkClick}
						rel="noopener noreferrer"
						target="_blank"
					>
						{displayValue}
					</a>
				</div>
			) : (
				<div
					className={cn("size-full overflow-hidden outline-none", {
						"whitespace-nowrap **:inline **:whitespace-nowrap [&_br]:hidden":
							isEditing,
					})}
					contentEditable={isEditing}
					data-slot="grid-cell-content"
					onBlur={onBlur}
					onInput={onInput}
					ref={cellRef}
					role="textbox"
					suppressContentEditableWarning
					tabIndex={-1}
				>
					{displayValue}
				</div>
			)}
		</DataGridCellWrapper>
	);
}
