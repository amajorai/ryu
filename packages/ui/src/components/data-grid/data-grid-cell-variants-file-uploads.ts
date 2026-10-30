"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { formatFileSize } from "@ryu/ui/lib/data-grid.ts";
import type {
	DataGridCellProps,
	FileCellData,
} from "@ryu/ui/types/data-grid.ts";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { toast } from "sonner";

interface FileCellUploadsOptions<TData> {
	acceptedTypes: string[] | null;
	columnId: string;
	files: FileCellData[];
	isPending: boolean;
	maxFileSize: number;
	maxFiles: number;
	readOnly: DataGridCellProps<TData>["readOnly"];
	rowIndex: number;
	setDeletingFiles: Dispatch<SetStateAction<Set<string>>>;
	setError: Dispatch<SetStateAction<string | null>>;
	setFiles: Dispatch<SetStateAction<FileCellData[]>>;
	setUploadingFiles: Dispatch<SetStateAction<Set<string>>>;
	tableMeta: DataGridCellProps<TData>["tableMeta"];
}

export function useFileCellUploads<TData>({
	acceptedTypes,
	columnId,
	files,
	isPending,
	maxFiles,
	maxFileSize,
	readOnly,
	rowIndex,
	setDeletingFiles,
	setError,
	setFiles,
	setUploadingFiles,
	tableMeta,
}: FileCellUploadsOptions<TData>) {
	const tl = useLiteralMessages();
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
				const errorMessage = tl("Maximum {maxFiles} files allowed", {
					maxFiles: String(maxFiles),
				});
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
							description: tl('"{truncatedName}" has been rejected', {
								truncatedName,
							}),
						});
					} else {
						toast(firstError.reason, {
							description: tl('"{truncatedName}" and {count} more rejected', {
								truncatedName,
								count: String(rejectedFiles.length - 1),
							}),
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
									: tl(
											"{count, plural, one {Failed to upload {formattedCount} file} other {Failed to upload {formattedCount} files}}",
											{
												count: filesToValidate.length,
												formattedCount: String(filesToValidate.length),
											}
										)
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
			tl,
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
							: tl("Failed to delete {name}", { name: fileToRemove.name })
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
		[files, tableMeta, rowIndex, columnId, readOnly, isPending, tl]
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

	return { addFiles, removeFile, clearAll };
}
