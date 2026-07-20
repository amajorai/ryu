"use client";

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Calendar } from "@ryu/ui/components/calendar.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
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
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useBadgeOverflow } from "@ryu/ui/hooks/use-badge-overflow.ts";
import { useDebouncedCallback } from "@ryu/ui/hooks/use-debounced-callback.ts";
import {
	formatDateForDisplay,
	formatDateToString,
	formatFileSize,
	getCellKey,
	getFileIcon,
	getLineCount,
	getOptionColorClass,
	getUrlHref,
	parseLocalDate,
} from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	DataGridCellProps,
	FileCellData,
} from "@ryu/ui/types/data-grid.ts";
import { Check, Upload, X } from "lucide-react";
import {
	type ChangeEvent,
	type DragEvent,
	type FormEvent,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

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

	const onInput = useCallback((event: FormEvent<HTMLDivElement>) => {
		const currentValue = event.currentTarget.textContent ?? "";
		setValue(currentValue);
	}, []);

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
					placeholder="Enter text..."
					ref={textareaRef}
					value={value}
				/>
			</PopoverContent>
		</Popover>
	);
}

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
	const initialValue = cell.getValue() as number;
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

	const onInput = useCallback((event: FormEvent<HTMLDivElement>) => {
		const currentValue = event.currentTarget.textContent ?? "";
		setValue(currentValue);
	}, []);

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
						className="truncate text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 data-invalid:cursor-not-allowed data-focused:text-foreground data-invalid:text-destructive data-focused:decoration-foreground/50 data-invalid:decoration-destructive/50 data-focused:hover:decoration-foreground/70 data-invalid:hover:decoration-destructive/70"
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

export function CheckboxCell<TData>({
	cell,
	tableMeta,
	rowIndex,
	columnId,
	rowHeight,
	isFocused,
	isSelected,
	isSearchMatch,
	isActiveSearchMatch,
	readOnly,
}: Omit<DataGridCellProps<TData>, "isEditing">) {
	const initialValue = cell.getValue() as boolean;
	const [value, setValue] = useState(Boolean(initialValue));
	const containerRef = useRef<HTMLDivElement>(null);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(Boolean(initialValue));
	}

	const onCheckedChange = useCallback(
		(checked: boolean) => {
			if (readOnly) {
				return;
			}
			setValue(checked);
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: checked });
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (
				isFocused &&
				!readOnly &&
				(event.key === " " || event.key === "Enter")
			) {
				event.preventDefault();
				event.stopPropagation();
				onCheckedChange(!value);
			} else if (isFocused && event.key === "Tab") {
				event.preventDefault();
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		},
		[isFocused, value, onCheckedChange, tableMeta, readOnly]
	);

	const onWrapperClick = useCallback(
		(event: MouseEvent) => {
			if (isFocused && !readOnly) {
				event.preventDefault();
				event.stopPropagation();
				onCheckedChange(!value);
			}
		},
		[isFocused, value, onCheckedChange, readOnly]
	);

	const onCheckboxClick = useCallback((event: MouseEvent) => {
		event.stopPropagation();
	}, []);

	const onCheckboxMouseDown = useCallback((event: MouseEvent) => {
		event.stopPropagation();
	}, []);

	const onCheckboxDoubleClick = useCallback((event: MouseEvent) => {
		event.stopPropagation();
	}, []);

	return (
		<DataGridCellWrapper<TData>
			cell={cell}
			className="flex size-full justify-center"
			columnId={columnId}
			isActiveSearchMatch={isActiveSearchMatch}
			isEditing={false}
			isFocused={isFocused}
			isSearchMatch={isSearchMatch}
			isSelected={isSelected}
			onClick={onWrapperClick}
			onKeyDown={onWrapperKeyDown}
			readOnly={readOnly}
			ref={containerRef}
			rowHeight={rowHeight}
			rowIndex={rowIndex}
			tableMeta={tableMeta}
		>
			<Checkbox
				checked={value}
				className="border-primary"
				disabled={readOnly}
				onCheckedChange={onCheckedChange}
				onClick={onCheckboxClick}
				onDoubleClick={onCheckboxDoubleClick}
				onMouseDown={onCheckboxMouseDown}
			/>
		</DataGridCellWrapper>
	);
}

export function SelectCell<TData>({
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
	const initialValue = (cell.getValue() ?? undefined) as string | undefined;

	const [value, setValue] = useState(initialValue);
	const containerRef = useRef<HTMLDivElement>(null);
	const cellOpts = cell.column.columnDef.meta?.cell;
	const options = useMemo(
		() => (cellOpts?.variant === "select" ? cellOpts.options : []),
		[cellOpts]
	);
	const optionByValue = useMemo(
		() => new Map(options.map((option) => [option.value, option])),
		[options]
	);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(initialValue);
	}

	const onValueChange = useCallback(
		// Base UI's Select calls back with `string | null` (+ event details).
		(newValue: string | null) => {
			if (readOnly || newValue === null) {
				return;
			}
			setValue(newValue);
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: newValue });
			tableMeta?.onCellEditingStop?.();
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (open && !readOnly) {
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else {
				tableMeta?.onCellEditingStop?.();
			}
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (isEditing && event.key === "Escape") {
				event.preventDefault();
				setValue(initialValue);
				tableMeta?.onCellEditingStop?.();
			} else if (isFocused && event.key === "Tab") {
				event.preventDefault();
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		},
		[isEditing, isFocused, initialValue, tableMeta]
	);

	const displayLabel = value
		? (optionByValue.get(value)?.label ?? value)
		: null;

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
				<Select
					onOpenChange={onOpenChange}
					onValueChange={onValueChange}
					open={isEditing}
					value={value}
				>
					<SelectTrigger className="size-full items-start border-none p-0 shadow-none focus-visible:ring-0 dark:bg-transparent [&_svg]:hidden">
						{displayLabel ? (
							<Badge
								className={cn(
									"whitespace-pre-wrap px-1.5 py-px",
									getOptionColorClass(optionByValue.get(value ?? "")?.color)
								)}
								variant="secondary"
							>
								<SelectValue />
							</Badge>
						) : (
							<SelectValue />
						)}
					</SelectTrigger>
					<SelectContent
						// compensate for the wrapper padding
						align="start"
						alignOffset={-8}
						className="min-w-[calc(var(--anchor-width)+16px)]"
						data-grid-cell-editor=""
						sideOffset={-8}
					>
						<SelectGroup>
							{options.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									<Badge
										className={cn(
											"px-1.5 py-px font-normal",
											getOptionColorClass(option.color)
										)}
										variant="secondary"
									>
										{option.label}
									</Badge>
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			) : displayLabel ? (
				<Badge
					className={cn(
						"whitespace-pre-wrap px-1.5 py-px",
						getOptionColorClass(optionByValue.get(value ?? "")?.color)
					)}
					data-slot="grid-cell-content"
					variant="secondary"
				>
					{displayLabel}
				</Badge>
			) : null}
		</DataGridCellWrapper>
	);
}

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
									placeholder="Search..."
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

export function DateCell<TData>({
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
	const initialValue = cell.getValue() as string;
	const [value, setValue] = useState(initialValue ?? "");
	const containerRef = useRef<HTMLDivElement>(null);

	const prevInitialValueRef = useRef(initialValue);
	if (initialValue !== prevInitialValueRef.current) {
		prevInitialValueRef.current = initialValue;
		setValue(initialValue ?? "");
	}

	// Parse date as local time to avoid timezone shifts
	const selectedDate = value ? (parseLocalDate(value) ?? undefined) : undefined;

	const onDateSelect = useCallback(
		(date: Date | undefined) => {
			if (!date || readOnly) {
				return;
			}

			// Format using local date components to avoid timezone issues
			const formattedDate = formatDateToString(date);
			setValue(formattedDate);
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: formattedDate });
			tableMeta?.onCellEditingStop?.();
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (open && !readOnly) {
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else {
				tableMeta?.onCellEditingStop?.();
			}
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (isEditing && event.key === "Escape") {
				event.preventDefault();
				setValue(initialValue);
				tableMeta?.onCellEditingStop?.();
			} else if (isFocused && event.key === "Tab") {
				event.preventDefault();
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		},
		[isEditing, isFocused, initialValue, tableMeta]
	);

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
			<Popover onOpenChange={onOpenChange} open={isEditing}>
				<PopoverAnchor asChild>
					<span data-slot="grid-cell-content">
						{formatDateForDisplay(value)}
					</span>
				</PopoverAnchor>
				{isEditing && (
					<PopoverContent
						align="start"
						alignOffset={-8}
						className="w-auto p-0"
						data-grid-cell-editor=""
					>
						<Calendar
							autoFocus
							captionLayout="dropdown"
							defaultMonth={selectedDate ?? new Date()}
							mode="single"
							onSelect={onDateSelect}
							selected={selectedDate}
						/>
					</PopoverContent>
				)}
			</Popover>
		</DataGridCellWrapper>
	);
}

export function FileCell<TData>({
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
	const cellValue = useMemo(
		() => (cell.getValue() as FileCellData[]) ?? [],
		[cell]
	);

	const cellKey = getCellKey(rowIndex, columnId);
	const prevCellKeyRef = useRef(cellKey);

	const labelId = useId();
	const descriptionId = useId();

	const [files, setFiles] = useState<FileCellData[]>(cellValue);
	const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
	const [deletingFiles, setDeletingFiles] = useState<Set<string>>(new Set());
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const isUploading = uploadingFiles.size > 0;
	const isDeleting = deletingFiles.size > 0;
	const isPending = isUploading || isDeleting;
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const dropzoneRef = useRef<HTMLDivElement>(null);
	const cellOpts = cell.column.columnDef.meta?.cell;
	const sideOffset = -(containerRef.current?.clientHeight ?? 0);

	const fileCellOpts = cellOpts?.variant === "file" ? cellOpts : null;
	const maxFileSize = fileCellOpts?.maxFileSize ?? 10 * 1024 * 1024;
	const maxFiles = fileCellOpts?.maxFiles ?? 10;
	const accept = fileCellOpts?.accept;
	const multiple = fileCellOpts?.multiple ?? false;

	const acceptedTypes = useMemo(
		() => (accept ? accept.split(",").map((t) => t.trim()) : null),
		[accept]
	);

	const prevCellValueRef = useRef(cellValue);
	if (cellValue !== prevCellValueRef.current) {
		prevCellValueRef.current = cellValue;
		for (const file of files) {
			if (file.url) {
				URL.revokeObjectURL(file.url);
			}
		}
		setFiles(cellValue);
		setError(null);
	}

	if (prevCellKeyRef.current !== cellKey) {
		prevCellKeyRef.current = cellKey;
		setError(null);
	}

	const validateFile = useCallback(
		(file: File): string | null => {
			if (maxFileSize && file.size > maxFileSize) {
				return `File size exceeds ${formatFileSize(maxFileSize)}`;
			}
			if (acceptedTypes) {
				const fileExtension = `.${file.name.split(".").pop()}`;
				const isAccepted = acceptedTypes.some((type) => {
					if (type.endsWith("/*")) {
						const baseType = type.slice(0, -2);
						return file.type.startsWith(`${baseType}/`);
					}
					if (type.startsWith(".")) {
						return fileExtension.toLowerCase() === type.toLowerCase();
					}
					return file.type === type;
				});
				if (!isAccepted) {
					return "File type not accepted";
				}
			}
			return null;
		},
		[maxFileSize, acceptedTypes]
	);

	const addFiles = useCallback(
		async (newFiles: File[], skipUpload = false) => {
			if (readOnly || isPending) {
				return;
			}
			setError(null);

			if (maxFiles && files.length + newFiles.length > maxFiles) {
				const errorMessage = `Maximum ${maxFiles} files allowed`;
				setError(errorMessage);
				toast(errorMessage);
				setTimeout(() => {
					setError(null);
				}, 2000);
				return;
			}

			const rejectedFiles: Array<{ name: string; reason: string }> = [];
			const filesToValidate: File[] = [];

			for (const file of newFiles) {
				const validationError = validateFile(file);
				if (validationError) {
					rejectedFiles.push({ name: file.name, reason: validationError });
					continue;
				}
				filesToValidate.push(file);
			}

			if (rejectedFiles.length > 0) {
				const firstError = rejectedFiles[0];
				if (firstError) {
					setError(firstError.reason);

					const truncatedName =
						firstError.name.length > 20
							? `${firstError.name.slice(0, 20)}...`
							: firstError.name;

					if (rejectedFiles.length === 1) {
						toast(firstError.reason, {
							description: `"${truncatedName}" has been rejected`,
						});
					} else {
						toast(firstError.reason, {
							description: `"${truncatedName}" and ${rejectedFiles.length - 1} more rejected`,
						});
					}

					setTimeout(() => {
						setError(null);
					}, 2000);
				}
			}

			if (filesToValidate.length > 0) {
				if (skipUpload) {
					const newFilesData: FileCellData[] = filesToValidate.map((f) => ({
						id: crypto.randomUUID(),
						name: f.name,
						size: f.size,
						type: f.type,
						url: URL.createObjectURL(f),
					}));
					const updatedFiles = [...files, ...newFilesData];
					setFiles(updatedFiles);
					tableMeta?.onDataUpdate?.({
						rowIndex,
						columnId,
						value: updatedFiles,
					});
				} else {
					const tempFiles = filesToValidate.map((f) => ({
						id: crypto.randomUUID(),
						name: f.name,
						size: f.size,
						type: f.type,
						url: undefined,
					}));
					const filesWithTemp = [...files, ...tempFiles];
					setFiles(filesWithTemp);

					const uploadingIds = new Set<string>(tempFiles.map((f) => f.id));
					setUploadingFiles(uploadingIds);

					let uploadedFiles: FileCellData[] = [];

					if (tableMeta?.onFilesUpload) {
						try {
							uploadedFiles = await tableMeta.onFilesUpload({
								files: filesToValidate,
								rowIndex,
								columnId,
							});
						} catch (error) {
							toast.error(
								error instanceof Error
									? error.message
									: `Failed to upload ${filesToValidate.length} file${filesToValidate.length === 1 ? "" : "s"}`
							);
							setFiles((prev) => prev.filter((f) => !uploadingIds.has(f.id)));
							setUploadingFiles(new Set());
							return;
						}
					} else {
						uploadedFiles = filesToValidate.map((f, i) => ({
							id: tempFiles[i]?.id ?? crypto.randomUUID(),
							name: f.name,
							size: f.size,
							type: f.type,
							url: URL.createObjectURL(f),
						}));
					}

					const finalFiles = filesWithTemp
						.map((f) => {
							if (uploadingIds.has(f.id)) {
								return uploadedFiles.find((uf) => uf.name === f.name) ?? f;
							}
							return f;
						})
						.filter((f) => f.url !== undefined);

					setFiles(finalFiles);
					setUploadingFiles(new Set());
					tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: finalFiles });
				}
			}
		},
		[
			files,
			maxFiles,
			validateFile,
			tableMeta,
			rowIndex,
			columnId,
			readOnly,
			isPending,
		]
	);

	const removeFile = useCallback(
		async (fileId: string) => {
			if (readOnly || isPending) {
				return;
			}
			setError(null);

			const fileToRemove = files.find((f) => f.id === fileId);
			if (!fileToRemove) {
				return;
			}

			setDeletingFiles((prev) => new Set(prev).add(fileId));

			if (tableMeta?.onFilesDelete) {
				try {
					await tableMeta.onFilesDelete({
						fileIds: [fileId],
						rowIndex,
						columnId,
					});
				} catch (error) {
					toast.error(
						error instanceof Error
							? error.message
							: `Failed to delete ${fileToRemove.name}`
					);
					setDeletingFiles((prev) => {
						const next = new Set(prev);
						next.delete(fileId);
						return next;
					});
					return;
				}
			}

			if (fileToRemove.url?.startsWith("blob:")) {
				URL.revokeObjectURL(fileToRemove.url);
			}

			const updatedFiles = files.filter((f) => f.id !== fileId);
			setFiles(updatedFiles);
			setDeletingFiles((prev) => {
				const next = new Set(prev);
				next.delete(fileId);
				return next;
			});
			tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: updatedFiles });
		},
		[files, tableMeta, rowIndex, columnId, readOnly, isPending]
	);

	const clearAll = useCallback(async () => {
		if (readOnly || isPending) {
			return;
		}
		setError(null);

		const fileIds = files.map((f) => f.id);
		setDeletingFiles(new Set(fileIds));

		if (tableMeta?.onFilesDelete && files.length > 0) {
			try {
				await tableMeta.onFilesDelete({
					fileIds,
					rowIndex,
					columnId,
				});
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : "Failed to delete files"
				);
				setDeletingFiles(new Set());
				return;
			}
		}

		for (const file of files) {
			if (file.url?.startsWith("blob:")) {
				URL.revokeObjectURL(file.url);
			}
		}
		setFiles([]);
		setDeletingFiles(new Set());
		tableMeta?.onDataUpdate?.({ rowIndex, columnId, value: [] });
	}, [files, tableMeta, rowIndex, columnId, readOnly, isPending]);

	const onCellDragEnter = useCallback((event: DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer.types.includes("Files")) {
			setIsDraggingOver(true);
		}
	}, []);

	const onCellDragLeave = useCallback((event: DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX;
		const y = event.clientY;

		if (
			x <= rect.left ||
			x >= rect.right ||
			y <= rect.top ||
			y >= rect.bottom
		) {
			setIsDraggingOver(false);
		}
	}, []);

	const onCellDragOver = useCallback((event: DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const onCellDrop = useCallback(
		(event: DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			setIsDraggingOver(false);

			const droppedFiles = Array.from(event.dataTransfer.files);
			if (droppedFiles.length > 0) {
				addFiles(droppedFiles, false);
			}
		},
		[addFiles]
	);

	const onDropzoneDragEnter = useCallback((event: DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		setIsDragging(true);
	}, []);

	const onDropzoneDragLeave = useCallback((event: DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX;
		const y = event.clientY;

		if (
			x <= rect.left ||
			x >= rect.right ||
			y <= rect.top ||
			y >= rect.bottom
		) {
			setIsDragging(false);
		}
	}, []);

	const onDropzoneDragOver = useCallback((event: DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const onDropzoneDrop = useCallback(
		(event: DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			setIsDragging(false);

			const droppedFiles = Array.from(event.dataTransfer.files);
			addFiles(droppedFiles, false);
		},
		[addFiles]
	);

	const onDropzoneClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const onDropzoneKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				onDropzoneClick();
			}
		},
		[onDropzoneClick]
	);

	const onFileInputChange = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			const selectedFiles = Array.from(event.target.files ?? []);
			addFiles(selectedFiles, false);
			event.target.value = "";
		},
		[addFiles]
	);

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (open && !readOnly) {
				setError(null);
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else {
				setError(null);
				tableMeta?.onCellEditingStop?.();
			}
		},
		[tableMeta, rowIndex, columnId, readOnly]
	);

	// Base UI's Popover has no `onOpenAutoFocus`; focus the dropzone on open.
	// (Escape is handled by `onWrapperKeyDown` below + Base UI's own close.)
	useEffect(() => {
		if (!isEditing) {
			return;
		}
		requestAnimationFrame(() => dropzoneRef.current?.focus());
	}, [isEditing]);

	const onWrapperKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (isEditing) {
				if (event.key === "Escape") {
					event.preventDefault();
					setFiles(cellValue);
					setError(null);
					tableMeta?.onCellEditingStop?.();
				} else if (event.key === " ") {
					event.preventDefault();
					onDropzoneClick();
				} else if (event.key === "Tab") {
					event.preventDefault();
					tableMeta?.onCellEditingStop?.({
						direction: event.shiftKey ? "left" : "right",
					});
				}
			} else if (isFocused && event.key === "Enter") {
				event.preventDefault();
				tableMeta?.onCellEditingStart?.(rowIndex, columnId);
			} else if (isFocused && event.key === "Tab") {
				event.preventDefault();
				tableMeta?.onCellEditingStop?.({
					direction: event.shiftKey ? "left" : "right",
				});
			}
		},
		[
			isEditing,
			isFocused,
			cellValue,
			tableMeta,
			onDropzoneClick,
			rowIndex,
			columnId,
		]
	);

	useEffect(() => {
		return () => {
			for (const file of files) {
				if (file.url) {
					URL.revokeObjectURL(file.url);
				}
			}
		};
	}, [files]);

	const lineCount = getLineCount(rowHeight);

	const { visibleItems: visibleFiles, hiddenCount: hiddenFileCount } =
		useBadgeOverflow({
			items: files,
			getLabel: (file) => file.name,
			containerRef,
			lineCount,
			cacheKeyPrefix: "file",
			iconSize: 12,
			maxWidth: 100,
		});

	return (
		<DataGridCellWrapper<TData>
			cell={cell}
			className={cn({
				"ring-1 ring-primary/80 ring-inset": isDraggingOver,
			})}
			columnId={columnId}
			isActiveSearchMatch={isActiveSearchMatch}
			isEditing={isEditing}
			isFocused={isFocused}
			isSearchMatch={isSearchMatch}
			isSelected={isSelected}
			onDragEnter={onCellDragEnter}
			onDragLeave={onCellDragLeave}
			onDragOver={onCellDragOver}
			onDrop={onCellDrop}
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
						className="w-[400px] rounded-none p-0"
						data-grid-cell-editor=""
						sideOffset={sideOffset}
					>
						<div className="flex flex-col gap-2 p-3">
							<span className="sr-only" id={labelId}>
								File upload
							</span>
							<div
								aria-describedby={descriptionId}
								aria-disabled={isPending}
								aria-invalid={!!error}
								aria-labelledby={labelId}
								className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 outline-none transition-colors hover:bg-accent/30 focus-visible:border-ring/50 data-disabled:pointer-events-none data-dragging:border-primary/30 data-invalid:border-destructive data-dragging:bg-accent/30 data-disabled:opacity-50 data-invalid:ring-destructive/20"
								data-disabled={isPending ? "" : undefined}
								data-dragging={isDragging ? "" : undefined}
								data-invalid={error ? "" : undefined}
								onClick={onDropzoneClick}
								onDragEnter={onDropzoneDragEnter}
								onDragLeave={onDropzoneDragLeave}
								onDragOver={onDropzoneDragOver}
								onDrop={onDropzoneDrop}
								onKeyDown={onDropzoneKeyDown}
								ref={dropzoneRef}
								role="region"
								tabIndex={isDragging || isPending ? -1 : 0}
							>
								<Upload className="size-8 text-muted-foreground" />
								<div className="text-center text-sm">
									<p className="font-medium">
										{isDragging ? "Drop files here" : "Drag files here"}
									</p>
									<p className="text-muted-foreground text-xs">
										or click to browse
									</p>
								</div>
								<p className="text-muted-foreground text-xs" id={descriptionId}>
									{maxFileSize
										? `Max size: ${formatFileSize(maxFileSize)}${maxFiles ? ` â€¢ Max ${maxFiles} files` : ""}`
										: maxFiles
											? `Max ${maxFiles} files`
											: "Select files to upload"}
								</p>
							</div>
							<input
								accept={accept}
								aria-describedby={descriptionId}
								aria-labelledby={labelId}
								className="sr-only"
								multiple={multiple}
								onChange={onFileInputChange}
								ref={fileInputRef}
								type="file"
							/>
							{files.length > 0 && (
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between">
										<p className="font-medium text-muted-foreground text-xs">
											{files.length} {files.length === 1 ? "file" : "files"}
										</p>
										<Button
											className="h-6 text-muted-foreground text-xs"
											disabled={isPending}
											onClick={clearAll}
											type="button"
											variant="ghost"
										>
											Clear all
										</Button>
									</div>
									<div className="max-h-[200px] space-y-1 overflow-y-auto">
										{files.map((file) => {
											const FileIcon = getFileIcon(file.type);
											const isFileUploading = uploadingFiles.has(file.id);
											const isFileDeleting = deletingFiles.has(file.id);
											const isFilePending = isFileUploading || isFileDeleting;

											return (
												<div
													className="flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1.5 data-pending:opacity-60"
													data-pending={isFilePending ? "" : undefined}
													key={file.id}
												>
													{FileIcon && (
														<FileIcon className="size-4 shrink-0 text-muted-foreground" />
													)}
													<div className="flex-1 overflow-hidden">
														<p className="truncate text-sm">{file.name}</p>
														<p className="text-muted-foreground text-xs">
															{isFileUploading
																? "Uploading..."
																: isFileDeleting
																	? "Deleting..."
																	: formatFileSize(file.size)}
														</p>
													</div>
													<Button
														className="size-5 rounded-sm"
														disabled={isPending}
														onClick={() => removeFile(file.id)}
														size="icon"
														type="button"
														variant="ghost"
													>
														<X className="size-3" />
													</Button>
												</div>
											);
										})}
									</div>
								</div>
							)}
						</div>
					</PopoverContent>
				</Popover>
			) : null}
			{isDraggingOver ? (
				<div className="flex items-center justify-center gap-2 text-primary text-sm">
					<Upload className="size-4" />
					<span>Drop files here</span>
				</div>
			) : files.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1 overflow-hidden">
					{visibleFiles.map((file) => {
						const isUploading = uploadingFiles.has(file.id);

						if (isUploading) {
							return (
								<Skeleton
									className="h-5 shrink-0 px-1.5"
									key={file.id}
									style={{
										width: `${Math.min(file.name.length * 8 + 30, 100)}px`,
									}}
								/>
							);
						}

						const FileIcon = getFileIcon(file.type);

						return (
							<Badge
								className="gap-1 px-1.5 py-px"
								key={file.id}
								variant="secondary"
							>
								{FileIcon && <FileIcon className="size-3 shrink-0" />}
								<span className="max-w-[100px] truncate">{file.name}</span>
							</Badge>
						);
					})}
					{hiddenFileCount > 0 && (
						<Badge
							className="px-1.5 py-px text-muted-foreground"
							variant="outline"
						>
							+{hiddenFileCount}
						</Badge>
					)}
				</div>
			) : null}
		</DataGridCellWrapper>
	);
}
