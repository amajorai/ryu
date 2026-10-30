"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useFileCellDragHandlers } from "@ryu/ui/components/data-grid/data-grid-cell-variants-file-drag.ts";
import { useFileCellUploads } from "@ryu/ui/components/data-grid/data-grid-cell-variants-file-uploads.ts";
import { DataGridCellWrapper } from "@ryu/ui/components/data-grid/data-grid-cell-wrapper.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { useBadgeOverflow } from "@ryu/ui/hooks/use-badge-overflow.ts";
import {
	formatFileSize,
	getCellKey,
	getFileIcon,
	getLineCount,
} from "@ryu/ui/lib/data-grid.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	DataGridCellProps,
	FileCellData,
} from "@ryu/ui/types/data-grid.ts";
import { Upload, X } from "lucide-react";
import {
	type ChangeEvent,
	type CSSProperties,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

interface FileSkeletonStyle extends CSSProperties {
	"--file-skeleton-width": string;
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
	// SAFETY: The file column accessor supplies schema-defined FileCellData records; absent values normalize to an empty list.
	const cellValue = useMemo(
		() => (cell.getValue() as FileCellData[]) ?? [],
		[cell]
	);

	const cellKey = getCellKey(rowIndex, columnId);
	const prevCellKeyRef = useRef(cellKey);

	const tl = useLiteralMessages();
	const labelId = useId();
	const descriptionId = useId();

	const [files, setFiles] = useState<FileCellData[]>(cellValue);
	const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
	const [deletingFiles, setDeletingFiles] = useState<Set<string>>(new Set());
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

	const { addFiles, removeFile, clearAll } = useFileCellUploads({
		files,
		setFiles,
		setError,
		setUploadingFiles,
		setDeletingFiles,
		isPending,
		readOnly,
		maxFiles,
		maxFileSize,
		acceptedTypes,
		tableMeta,
		rowIndex,
		columnId,
	});

	const {
		isDraggingOver,
		isDragging,
		onCellDragEnter,
		onCellDragLeave,
		onCellDragOver,
		onCellDrop,
		onDropzoneDragEnter,
		onDropzoneDragLeave,
		onDropzoneDragOver,
		onDropzoneDrop,
	} = useFileCellDragHandlers(addFiles);

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
										? maxFiles
											? tl("Max size: {size} â€¢ Max {maxFiles} files", {
													size: formatFileSize(maxFileSize),
													maxFiles: String(maxFiles),
												})
											: tl("Max size: {size}", {
													size: formatFileSize(maxFileSize),
												})
										: maxFiles
											? tl("Max {maxFiles} files", {
													maxFiles: String(maxFiles),
												})
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
														<p className="truncate text-sm" title={file.name}>
															{file.name}
														</p>
														<p className="text-muted-foreground text-xs">
															{isFileUploading
																? "Uploading…"
																: isFileDeleting
																	? "Deleting…"
																	: formatFileSize(file.size)}
														</p>
													</div>
													<Button
														aria-label={tl("Remove {name}", {
															name: file.name,
														})}
														className="relative size-5 rounded-sm after:absolute after:-inset-0.5 after:content-['']"
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
						const skeletonStyle: FileSkeletonStyle = {
							"--file-skeleton-width": `${Math.min(file.name.length * 8 + 30, 100)}px`,
						};

						if (isUploading) {
							return (
								<Skeleton
									className="h-5 w-(--file-skeleton-width) shrink-0 px-1.5"
									key={file.id}
									style={skeletonStyle}
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
