"use client";

import { useCallback } from "react";
import {
	type ImageEditorModelPreferences,
	saveImageEditorModelPreferences,
} from "@/src/lib/image-editor-models.ts";
import {
	canvasCopy,
	canvasToBlob,
	drawMarkups,
	getSegmentAtPoints,
	safeBaseName,
} from "./ImageEditorDialog-canvas.ts";
import type { ImageEditorOperations } from "./ImageEditorDialog-operations.ts";
import type { ImageEditorState } from "./ImageEditorDialog-state.ts";
import type { ImageEditorAsset } from "./ImageEditorDialog-types.ts";
import {
	type NormalizedImagePoint,
	normalizedImagePoint,
} from "./image-editor-utils.ts";

export function useImageEditorInteractions(
	state: ImageEditorState,
	{
		closeEditor,
		image,
		onUseInChat,
	}: {
		closeEditor: ImageEditorOperations["closeEditor"];
		image: ImageEditorAsset | null;
		onUseInChat?: (image: File) => void;
	}
) {
	const {
		attachmentExportAbortRef,
		commentInput,
		isBusy,
		markups,
		pointerPointsRef,
		pointerToolRef,
		segments,
		setCommentInput,
		setEditorNotice,
		setError,
		setMarkups,
		setModels,
		setOperation,
		setPointerPreview,
		setRevision,
		setSegments,
		setSelectedSegmentId,
		setTool,
		tool,
		workingCanvasRef,
	} = state;

	const eraseStroke = useCallback((points: readonly NormalizedImagePoint[]) => {
		const working = workingCanvasRef.current;
		const [first, ...rest] = points;
		if (!(working && first)) {
			return;
		}
		const context = working.getContext("2d", { willReadFrequently: true });
		if (!context) {
			setError("The browser could not erase this area.");
			return;
		}
		context.save();
		context.globalCompositeOperation = "destination-out";
		context.lineCap = "round";
		context.lineJoin = "round";
		context.lineWidth = Math.max(
			20,
			Math.min(working.width, working.height) * 0.035
		);
		context.beginPath();
		context.moveTo(first.x * working.width, first.y * working.height);
		if (rest.length === 0) {
			context.lineTo(first.x * working.width + 0.01, first.y * working.height);
		} else {
			for (const point of rest) {
				context.lineTo(point.x * working.width, point.y * working.height);
			}
		}
		context.stroke();
		context.restore();
		setSegments([]);
		setSelectedSegmentId(null);
		setRevision((current) => current + 1);
	}, []);

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLCanvasElement>) => {
			const point = normalizedImagePoint(
				event.clientX,
				event.clientY,
				event.currentTarget.getBoundingClientRect()
			);
			if (!point) {
				return;
			}
			if (tool === "comment") {
				const text = commentInput.trim();
				if (!text) {
					setError("Write a comment before placing it on the image.");
					return;
				}
				setMarkups((current) => [
					...current,
					{ id: crypto.randomUUID(), kind: "comment", point, text },
				]);
				setCommentInput("");
				setTool("select");
				setEditorNotice("Comment added.");
				setError(null);
				return;
			}
			pointerToolRef.current = tool;
			pointerPointsRef.current = [point];
			setPointerPreview([point]);
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		[commentInput, tool]
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLCanvasElement>) => {
			if (!pointerToolRef.current) {
				return;
			}
			const point = normalizedImagePoint(
				event.clientX,
				event.clientY,
				event.currentTarget.getBoundingClientRect()
			);
			if (!point) {
				return;
			}
			const previous = pointerPointsRef.current.at(-1);
			if (
				previous &&
				Math.hypot(point.x - previous.x, point.y - previous.y) < 0.004
			) {
				return;
			}
			pointerPointsRef.current = [...pointerPointsRef.current, point];
			setPointerPreview(pointerPointsRef.current);
		},
		[]
	);

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLCanvasElement>) => {
			const activeTool = pointerToolRef.current;
			if (!activeTool) {
				return;
			}
			pointerToolRef.current = null;
			const points = pointerPointsRef.current;
			pointerPointsRef.current = [];
			setPointerPreview([]);
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			if (activeTool === "select") {
				const match = getSegmentAtPoints(points, segments);
				setSelectedSegmentId(match?.id ?? null);
				setError(
					match || segments.length === 0
						? null
						: "Highlight across a detected subject to select it."
				);
				return;
			}
			if (activeTool === "erase") {
				eraseStroke(points);
				return;
			}
			if (points.length > 0) {
				setMarkups((current) => [
					...current,
					{
						color: "#ff654f",
						id: crypto.randomUUID(),
						kind: "stroke",
						points,
					},
				]);
				setEditorNotice("Markup added.");
			}
		},
		[eraseStroke, segments]
	);

	const buildEditedFile = useCallback(async (): Promise<File> => {
		const working = workingCanvasRef.current;
		if (!working) {
			throw new Error("The image is not ready to export.");
		}
		const output = canvasCopy(working);
		const context = output.getContext("2d");
		if (!context) {
			throw new Error("The browser could not prepare the exported image.");
		}
		drawMarkups(context, markups, output.width, output.height);
		const baseName = safeBaseName(image?.filename);
		return new File([await canvasToBlob(output)], `${baseName}-edited.png`, {
			lastModified: Date.now(),
			type: "image/png",
		});
	}, [image?.filename, markups]);

	const downloadImage = useCallback(async () => {
		setOperation({ kind: "export" });
		setError(null);
		try {
			const file = await buildEditedFile();
			const url = URL.createObjectURL(file);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = file.name;
			anchor.rel = "noopener noreferrer";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
		} catch (exportError) {
			setError(
				exportError instanceof Error
					? exportError.message
					: "Could not export this image."
			);
		} finally {
			setOperation(null);
		}
	}, [buildEditedFile]);

	const addEditedImageToChat = useCallback(async () => {
		if (!onUseInChat || isBusy || attachmentExportAbortRef.current) {
			return;
		}
		const controller = new AbortController();
		attachmentExportAbortRef.current = controller;
		setOperation({ kind: "export" });
		setError(null);
		try {
			const file = await buildEditedFile();
			if (
				controller.signal.aborted ||
				attachmentExportAbortRef.current !== controller
			) {
				return;
			}
			onUseInChat(file);
			closeEditor();
		} catch (exportError) {
			if (!controller.signal.aborted) {
				setError(
					exportError instanceof Error
						? exportError.message
						: "Could not attach this image to chat."
				);
			}
		} finally {
			if (attachmentExportAbortRef.current === controller) {
				attachmentExportAbortRef.current = null;
				setOperation(null);
			}
		}
	}, [buildEditedFile, closeEditor, isBusy, onUseInChat]);

	const saveModelInput = useCallback(
		(key: keyof ImageEditorModelPreferences, value: string) => {
			setModels((current) => ({ ...current, [key]: value.trim() }));
		},
		[]
	);

	const updateModels = useCallback((next: ImageEditorModelPreferences) => {
		setModels(next);
		if (saveImageEditorModelPreferences(next)) {
			setError(null);
		} else {
			setError("Model choices could not be saved in this browser.");
		}
	}, []);

	return {
		eraseStroke,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		buildEditedFile,
		downloadImage,
		addEditedImageToChat,
		saveModelInput,
		updateModels,
	};
}

export type ImageEditorController = ImageEditorState &
	ImageEditorOperations &
	ReturnType<typeof useImageEditorInteractions>;
