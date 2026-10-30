"use client";

import { type DragEvent, useCallback, useState } from "react";

export function useFileCellDragHandlers(
	addFiles: (newFiles: File[], skipUpload?: boolean) => Promise<void>
) {
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [isDragging, setIsDragging] = useState(false);

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

	return {
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
	};
}
