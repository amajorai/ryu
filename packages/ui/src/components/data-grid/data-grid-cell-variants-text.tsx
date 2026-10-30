"use client";

import { DataGridCellWrapper } from "@ryu/ui/components/data-grid/data-grid-cell-wrapper.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useDebouncedCallback } from "@ryu/ui/hooks/use-debounced-callback.ts";
import { isFormulaError } from "@ryu/ui/lib/data-grid-formula.ts";
import {
	isNativeBoolean,
	isNativeNumber,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { DataGridCellProps } from "@ryu/ui/types/data-grid.ts";
import {
	type ChangeEvent,
	type ComponentProps,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

export function ShortTextCell<TData>({
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
	const [value, setValue] = useState(initialValue);
	const cellRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const prevIsEditingRef = useRef(false);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(initialValue);
		if (cellRef.current && !isEditing) {
			cellRef.current.textContent = initialValue;
		}
	}

	const onBlur = useCallback(() => {
		// Read the current value directly from the DOM to avoid stale state
		const currentValue = cellRef.current?.textContent ?? "";
		if (!readOnly && currentValue !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: currentValue });
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
					const currentValue = cellRef.current?.textContent ?? "";
					if (currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue,
						});
					}
					tableMeta?.onCellEditingStop?.({ moveToNextRow: true });
				} else if (event.key === "Tab") {
					event.preventDefault();
					const currentValue = cellRef.current?.textContent ?? "";
					if (currentValue !== initialValue) {
						tableMeta?.onDataUpdate?.({
							rowIndex,
							columnId,
							value: currentValue,
						});
					}
					tableMeta?.onCellEditingStop?.({
						direction: event.shiftKey ? "left" : "right",
					});
				} else if (event.key === "Escape") {
					event.preventDefault();
					setValue(initialValue);
					cellRef.current?.blur();
				}
			} else if (
				isFocused &&
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
		[isEditing, isFocused, initialValue, tableMeta, rowIndex, columnId]
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
		</DataGridCellWrapper>
	);
}

/**
 * A read-only computed value (formula column). It never enters edit mode;
 * error results such as `#DIV/0!` render in the destructive color.
 */
export function FormulaCell<TData>({
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
}: DataGridCellProps<TData>) {
	const value = cell.getValue();
	const isError = isFormulaError(value);
	let text = "";
	if (isNativeBoolean(value)) {
		text = value ? "TRUE" : "FALSE";
	} else if (isNativeNumber(value)) {
		text = value.toLocaleString(undefined, { maximumFractionDigits: 10 });
	} else if (value !== null && value !== undefined) {
		text = String(value);
	}

	return (
		<DataGridCellWrapper<TData>
			cell={cell}
			columnId={columnId}
			isActiveSearchMatch={isActiveSearchMatch}
			isEditing={isEditing}
			isFocused={isFocused}
			isSearchMatch={isSearchMatch}
			isSelected={isSelected}
			readOnly
			rowHeight={rowHeight}
			rowIndex={rowIndex}
			tableMeta={tableMeta}
		>
			<span
				className={cn({
					"block text-end tabular-nums": isNativeNumber(value),
					"text-destructive": isError,
				})}
				data-slot="grid-cell-content"
			>
				{text}
			</span>
		</DataGridCellWrapper>
	);
}

export function LongTextCell<TData>({
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
	// SAFETY: This renderer is selected for the text cell schema; its column accessor returns a string.
	const initialValue = cell.getValue() as string;
	const [value, setValue] = useState(initialValue ?? "");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const pendingCharRef = useRef<string | null>(null);
	const sideOffset = -(containerRef.current?.clientHeight ?? 0);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(initialValue ?? "");
	}

	const debouncedSave = useDebouncedCallback((newValue: string) => {
		if (!readOnly) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValue });
		}
	}, 300);

	const onSave = useCallback(() => {
		// Immediately save any pending changes and close the popover
		if (!readOnly && value !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
		}
		tableMeta?.onCellEditingStop?.();
	}, [tableMeta, value, initialValue, rowIndex, columnId, readOnly]);

	const onCancel = useCallback(() => {
		// Restore the original value
		setValue(initialValue ?? "");
		if (!readOnly) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: initialValue });
		}
		tableMeta?.onCellEditingStop?.();
	}, [tableMeta, initialValue, rowIndex, columnId, readOnly]);

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (open && !readOnly) {
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else {
				// Immediately save any pending changes when closing
				if (!readOnly && value !== initialValue) {
					tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
				}
				tableMeta?.onCellEditingStop?.();
			}
		},
		[tableMeta, value, initialValue, rowIndex, columnId, readOnly]
	);

	// Base UI's Popover has no `onOpenAutoFocus`; focus the textarea when editing
	// starts (replaying any pending typed character into the undo history).
	useEffect(() => {
		if (!isEditing) {
			return;
		}
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) {
				return;
			}
			textarea.focus();
			const length = textarea.value.length;
			textarea.setSelectionRange(length, length);
			if (pendingCharRef.current) {
				const char = pendingCharRef.current;
				pendingCharRef.current = null;
				if (document.activeElement === textarea) {
					document.execCommand("insertText", false, char);
					textarea.scrollTop = textarea.scrollHeight;
				}
			} else {
				textarea.scrollTop = textarea.scrollHeight;
			}
		});
	}, [isEditing]);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (
				isFocused &&
				!isEditing &&
				!readOnly &&
				event.key.length === 1 &&
				!event.ctrlKey &&
				!event.metaKey
			) {
				// Store the character to be inserted after textarea focuses
				// This ensures it's part of the textarea's undo history
				pendingCharRef.current = event.key;
			}
		},
		[isFocused, isEditing, readOnly]
	);

	const onBlur = useCallback(() => {
		// Immediately save any pending changes on blur
		if (!readOnly && value !== initialValue) {
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
		}
		tableMeta?.onCellEditingStop?.();
	}, [tableMeta, value, initialValue, rowIndex, columnId, readOnly]);

	const onChange = useCallback(
		(event: ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = event.target.value;
			setValue(newValue);
			debouncedSave(newValue);
		},
		[debouncedSave]
	);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCancel();
			} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				onSave();
			} else if (event.key === "Tab") {
				event.preventDefault();
				// Save any pending changes
				if (value !== initialValue) {
					tableMeta?.onDataUpdate?.({ rowIndex, columnId, value });
				}
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
				return;
			}
			// Stop propagation to prevent grid navigation
			event.stopPropagation();
		},
		[onSave, onCancel, value, initialValue, tableMeta, rowIndex, columnId]
	);

	return (
		<Popover onOpenChange={onOpenChange} open={isEditing}>
			<PopoverAnchor asChild>
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
					<span data-slot="grid-cell-content">{value}</span>
				</DataGridCellWrapper>
			</PopoverAnchor>
			<PopoverContent
				align="start"
				className="w-[400px] rounded-none p-0"
				data-grid-cell-editor=""
				side="bottom"
				sideOffset={sideOffset}
			>
				<Textarea
					className="max-h-[300px] min-h-[150px] resize-none overflow-y-auto rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-ring"
					onBlur={onBlur}
					onChange={onChange}
					onKeyDown={onKeyDown}
					placeholder="Enter text…"
					ref={textareaRef}
					value={value}
				/>
			</PopoverContent>
		</Popover>
	);
}
