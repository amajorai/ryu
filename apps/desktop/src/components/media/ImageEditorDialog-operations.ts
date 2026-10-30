"use client";

import type { BrowserImageEngine } from "@ryu/browser-local-ai";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback } from "react";
import { IMAGE_RESIZE_PRESETS } from "@/src/lib/api/image-resize.ts";
import type { ImageResizeRequest } from "@/src/lib/api/images.ts";
import {
	blobToCanvas,
	createInferenceBlob,
	prepareLocalImageResize,
} from "./ImageEditorDialog-canvas.ts";
import type { ImageEditorState } from "./ImageEditorDialog-state.ts";
import { imageDimensionError } from "./image-editor-utils.ts";

export function useImageEditorOperations(
	state: ImageEditorState,
	{
		onAiResize,
		onClose,
		runtime,
	}: {
		onAiResize?: (request: ImageResizeRequest) => Promise<Blob>;
		onClose: () => void;
		runtime: BrowserImageEngine;
	}
) {
	const tl = useLiteralMessages();
	const {
		aiResizeAbortRef,
		attachmentExportAbortRef,
		dimensions,
		installCanvas,
		isBusy,
		models,
		originalBlobRef,
		paddingInput,
		resizeAspect,
		resizeEngine,
		resizeInstructions,
		saveModels,
		segments,
		selectedSegmentId,
		setCommentInput,
		setEditorNotice,
		setEngineStatus,
		setError,
		setMarkups,
		setModelSettingsOpen,
		setOperation,
		setPaddingPanelOpen,
		setResizePanelOpen,
		setRevision,
		setSegments,
		setSelectedSegmentId,
		setTool,
		workingCanvasRef,
	} = state;

	const runSegmentation = useCallback(async () => {
		const working = workingCanvasRef.current;
		if (!working || isBusy || !saveModels()) {
			return;
		}
		setOperation({ kind: "segment" });
		setError(null);
		setEditorNotice(null);
		try {
			const imageBlob = await createInferenceBlob(working, 1024);
			const found = await runtime.segment({
				image: imageBlob,
				modelId: models.segmentationModelId,
			});
			setSegments(found);
			setSelectedSegmentId(found[0]?.id ?? null);
			if (found.length === 0) {
				setError("No subjects were found. Try another segmentation model.");
			}
		} catch (runError) {
			setError(
				runError instanceof Error
					? runError.message
					: "The segmentation engine could not process this image."
			);
		} finally {
			setOperation(null);
		}
	}, [isBusy, models.segmentationModelId, runtime, saveModels]);

	const removeBackground = useCallback(async () => {
		const working = workingCanvasRef.current;
		if (!working || isBusy || !saveModels()) {
			return;
		}
		setOperation({ kind: "background-removal" });
		setError(null);
		setEditorNotice(null);
		try {
			const imageBlob = await createInferenceBlob(working, 2048);
			const output = await runtime.removeBackground({
				image: imageBlob,
				modelId: models.backgroundRemovalModelId,
			});
			const outputDimensionError = imageDimensionError(
				output.width,
				output.height
			);
			if (
				outputDimensionError ||
				output.data.length !== output.width * output.height * 4
			) {
				throw new Error(
					"The background-removal model returned invalid image pixels."
				);
			}
			const maskCanvas = document.createElement("canvas");
			maskCanvas.width = output.width;
			maskCanvas.height = output.height;
			const maskContext = maskCanvas.getContext("2d");
			if (!maskContext) {
				throw new Error("The browser could not prepare the background mask.");
			}
			const outputPixels = maskContext.createImageData(
				output.width,
				output.height
			);
			outputPixels.data.set(output.data);
			maskContext.putImageData(outputPixels, 0, 0);
			const next = document.createElement("canvas");
			next.width = working.width;
			next.height = working.height;
			const context = next.getContext("2d", { willReadFrequently: true });
			if (!context) {
				throw new Error("The browser could not apply the background mask.");
			}
			context.drawImage(maskCanvas, 0, 0, next.width, next.height);
			installCanvas(next);
		} catch (runError) {
			setError(
				runError instanceof Error
					? runError.message
					: "The background-removal engine could not process this image."
			);
		} finally {
			setOperation(null);
		}
	}, [
		installCanvas,
		isBusy,
		models.backgroundRemovalModelId,
		runtime,
		saveModels,
	]);

	const eraseSelectedSegment = useCallback(() => {
		const working = workingCanvasRef.current;
		const selected = segments.find(
			(segment) => segment.id === selectedSegmentId
		);
		if (!(working && selected) || isBusy) {
			return;
		}
		const maskCanvas = document.createElement("canvas");
		maskCanvas.width = selected.width;
		maskCanvas.height = selected.height;
		const maskContext = maskCanvas.getContext("2d");
		if (!maskContext) {
			setError("The browser could not prepare the selected subject mask.");
			return;
		}
		const maskPixels = new ImageData(selected.width, selected.height);
		for (let pixel = 0; pixel < selected.mask.length; pixel += 1) {
			if (selected.mask[pixel] === 1) {
				maskPixels.data[pixel * 4 + 3] = 255;
			}
		}
		maskContext.putImageData(maskPixels, 0, 0);
		const context = working.getContext("2d", { willReadFrequently: true });
		if (!context) {
			setError("The browser could not erase the selected subject.");
			return;
		}
		context.save();
		context.globalCompositeOperation = "destination-out";
		context.drawImage(maskCanvas, 0, 0, working.width, working.height);
		context.restore();
		setSegments([]);
		setSelectedSegmentId(null);
		setRevision((current) => current + 1);
		setError(null);
	}, [isBusy, segments, selectedSegmentId]);

	const runAiResize = useCallback(async () => {
		const current = workingCanvasRef.current;
		if (
			!(current && dimensions && onAiResize) ||
			isBusy ||
			aiResizeAbortRef.current
		) {
			return;
		}

		const controller = new AbortController();
		aiResizeAbortRef.current = controller;
		setOperation({ kind: "ai-resize" });
		setError(null);
		setEditorNotice(null);
		try {
			const prepared =
				resizeEngine === "local"
					? await prepareLocalImageResize(current, resizeAspect)
					: null;
			const image =
				prepared?.image ?? (await createInferenceBlob(current, 1536));
			if (
				controller.signal.aborted ||
				aiResizeAbortRef.current !== controller
			) {
				return;
			}
			const resized = await onAiResize({
				aspect: resizeAspect,
				denoisingStrength: prepared?.denoisingStrength ?? 0.3,
				engine: resizeEngine,
				height: prepared?.height ?? dimensions.height,
				image,
				...(prepared?.mask ? { mask: prepared.mask } : undefined),
				instructions: resizeInstructions,
				signal: controller.signal,
				width: prepared?.width ?? dimensions.width,
			});
			if (controller.signal.aborted) {
				return;
			}
			const next = await blobToCanvas(resized);
			if (
				controller.signal.aborted ||
				aiResizeAbortRef.current !== controller
			) {
				return;
			}
			installCanvas(next);
			setMarkups([]);
			setCommentInput("");
			setTool("select");
			setResizePanelOpen(false);
			const shape = IMAGE_RESIZE_PRESETS.find(
				(preset) => preset.id === resizeAspect
			)?.label;
			setEditorNotice(
				shape === undefined
					? tl("AI resized to the selected shape.")
					: tl("AI resized to {shape}.", { shape })
			);
		} catch (resizeError) {
			if (!controller.signal.aborted) {
				setError(
					resizeError instanceof Error
						? resizeError.message
						: "The selected image model could not resize this image."
				);
			}
		} finally {
			if (aiResizeAbortRef.current === controller) {
				aiResizeAbortRef.current = null;
				setOperation(null);
			}
		}
	}, [
		dimensions,
		installCanvas,
		isBusy,
		onAiResize,
		resizeAspect,
		resizeEngine,
		resizeInstructions,
		tl,
	]);

	const closeEditor = useCallback(() => {
		aiResizeAbortRef.current?.abort();
		aiResizeAbortRef.current = null;
		attachmentExportAbortRef.current?.abort();
		attachmentExportAbortRef.current = null;
		onClose();
	}, [onClose]);

	const expandCanvas = useCallback(() => {
		const current = workingCanvasRef.current;
		const padding = Number(paddingInput);
		if (!current || isBusy) {
			return;
		}
		if (!Number.isSafeInteger(padding) || padding < 1 || padding > 1024) {
			setError("Canvas padding must be a whole number from 1 to 1,024 pixels.");
			return;
		}
		const width = current.width + padding * 2;
		const height = current.height + padding * 2;
		const dimensionError = imageDimensionError(width, height);
		if (dimensionError) {
			setError(dimensionError);
			return;
		}
		const next = document.createElement("canvas");
		next.width = width;
		next.height = height;
		const context = next.getContext("2d", { willReadFrequently: true });
		if (!context) {
			setError("The browser could not expand this image.");
			return;
		}
		context.drawImage(current, padding, padding);
		const oldWidth = current.width;
		const oldHeight = current.height;
		setMarkups((currentMarkups) =>
			currentMarkups.map((markup) => {
				if (markup.kind === "stroke") {
					return {
						...markup,
						points: markup.points.map((point) => ({
							x: (point.x * oldWidth + padding) / width,
							y: (point.y * oldHeight + padding) / height,
						})),
					};
				}
				return {
					...markup,
					point: {
						x: (markup.point.x * oldWidth + padding) / width,
						y: (markup.point.y * oldHeight + padding) / height,
					},
				};
			})
		);
		installCanvas(next);
		setError(null);
		setPaddingPanelOpen(false);
		setEditorNotice("Transparent padding added.");
	}, [installCanvas, isBusy, paddingInput]);

	const resetImage = useCallback(async () => {
		const original = originalBlobRef.current;
		if (!original || isBusy) {
			return;
		}
		setOperation({ kind: "reset" });
		setError(null);
		setEngineStatus(null);
		setEditorNotice(null);
		setResizePanelOpen(false);
		setPaddingPanelOpen(false);
		setModelSettingsOpen(false);
		setTool("select");
		try {
			installCanvas(await blobToCanvas(original));
			setMarkups([]);
		} catch (resetError) {
			setError(
				resetError instanceof Error
					? resetError.message
					: "Could not restore the original image."
			);
		} finally {
			setOperation(null);
		}
	}, [installCanvas, isBusy]);

	return {
		runSegmentation,
		removeBackground,
		eraseSelectedSegment,
		runAiResize,
		closeEditor,
		expandCanvas,
		resetImage,
	};
}

export type ImageEditorOperations = ReturnType<typeof useImageEditorOperations>;
