"use client";

import {
	type BrowserImageEngine,
	type BrowserImageRuntimeStatus,
	type BrowserImageSegment,
	isValidBrowserModelId,
} from "@ryu/browser-local-ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	DEFAULT_IMAGE_RESIZE_ENGINE,
	IMAGE_RESIZE_PRESETS,
	type ImageResizeAspect,
	type ImageResizeEngine,
	imageResizeAspectLabel,
	imageResizeDimensionsForEngine,
} from "@/src/lib/api/image-resize.ts";
import {
	getImageEditorModelPreferences,
	saveImageEditorModelPreferences,
} from "@/src/lib/image-editor-models.ts";
import {
	blobToCanvas,
	drawMarkups,
	paintMask,
} from "./ImageEditorDialog-canvas.ts";
import type {
	ImageDimensions,
	ImageEditorAsset,
	ImageEditorOperation,
	ImageEditorTool,
	ImageMarkup,
} from "./ImageEditorDialog-types.ts";
import {
	fetchEditableImage,
	type NormalizedImagePoint,
} from "./image-editor-utils.ts";

export function useImageEditorState({
	image,
	open,
	runtime,
}: {
	image: ImageEditorAsset | null;
	open: boolean;
	runtime: BrowserImageEngine;
}) {
	const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const workingCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const originalBlobRef = useRef<Blob | null>(null);
	const aiResizeAbortRef = useRef<AbortController | null>(null);
	const attachmentExportAbortRef = useRef<AbortController | null>(null);
	const pointerPointsRef = useRef<NormalizedImagePoint[]>([]);
	const pointerToolRef = useRef<ImageEditorTool | null>(null);
	const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
	const [paddingInput, setPaddingInput] = useState("80");
	const [resizeAspect, setResizeAspect] =
		useState<ImageResizeAspect>("original");
	const [resizeEngine, setResizeEngine] = useState<ImageResizeEngine>(
		DEFAULT_IMAGE_RESIZE_ENGINE
	);
	const resizePresetOptions = useMemo(() => {
		if (!dimensions) {
			return [];
		}
		return IMAGE_RESIZE_PRESETS.map((preset) => ({
			aspectLabel: imageResizeAspectLabel(
				preset.id,
				dimensions.width,
				dimensions.height
			),
			dimensions: imageResizeDimensionsForEngine(
				resizeEngine,
				preset.id,
				dimensions.width,
				dimensions.height
			),
			preset,
		}));
	}, [dimensions, resizeEngine]);
	const [resizeInstructions, setResizeInstructions] = useState("");
	const [commentInput, setCommentInput] = useState("");
	const [markups, setMarkups] = useState<ImageMarkup[]>([]);
	const [segments, setSegments] = useState<BrowserImageSegment[]>([]);
	const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
		null
	);
	const [pointerPreview, setPointerPreview] = useState<NormalizedImagePoint[]>(
		[]
	);
	const [tool, setTool] = useState<ImageEditorTool>("select");
	const [imageLoading, setImageLoading] = useState(false);
	const [operation, setOperation] = useState<ImageEditorOperation>(null);
	const [engineStatus, setEngineStatus] =
		useState<BrowserImageRuntimeStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editorNotice, setEditorNotice] = useState<string | null>(null);
	const [models, setModels] = useState(getImageEditorModelPreferences);
	const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
	const [resizePanelOpen, setResizePanelOpen] = useState(false);
	const [paddingPanelOpen, setPaddingPanelOpen] = useState(false);
	const [revision, setRevision] = useState(0);
	const editorReady = !imageLoading && dimensions !== null;
	const isBusy = operation !== null;
	const selectedSegment = useMemo(
		() => segments.find((segment) => segment.id === selectedSegmentId) ?? null,
		[segments, selectedSegmentId]
	);

	useEffect(() => runtime.subscribe(setEngineStatus), [runtime]);

	useEffect(() => {
		if (!(open && image)) {
			return;
		}
		aiResizeAbortRef.current?.abort();
		aiResizeAbortRef.current = null;
		attachmentExportAbortRef.current?.abort();
		attachmentExportAbortRef.current = null;
		const controller = new AbortController();
		let cancelled = false;
		setImageLoading(true);
		setError(null);
		setEngineStatus(null);
		setEditorNotice(null);
		setDimensions(null);
		setSegments([]);
		setSelectedSegmentId(null);
		setMarkups([]);
		setTool("select");
		setModelSettingsOpen(false);
		setResizePanelOpen(false);
		setPaddingPanelOpen(false);
		setResizeInstructions("");
		setOperation(null);
		setModels(getImageEditorModelPreferences());
		fetchEditableImage(image.url, controller.signal)
			.then(async (blob) => ({ blob, canvas: await blobToCanvas(blob) }))
			.then(({ blob, canvas }) => {
				if (cancelled) {
					return;
				}
				originalBlobRef.current = blob;
				workingCanvasRef.current = canvas;
				setDimensions({ height: canvas.height, width: canvas.width });
				setRevision((current) => current + 1);
			})
			.catch((loadError) => {
				if (!cancelled) {
					setError(
						loadError instanceof Error
							? loadError.message
							: "Could not open this image in the editor."
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setImageLoading(false);
				}
			});
		return () => {
			cancelled = true;
			controller.abort();
			aiResizeAbortRef.current?.abort();
			attachmentExportAbortRef.current?.abort();
		};
	}, [image, open]);

	useEffect(() => {
		const preview = imageCanvasRef.current;
		const working = workingCanvasRef.current;
		if (!(preview && working)) {
			return;
		}
		preview.width = working.width;
		preview.height = working.height;
		const context = preview.getContext("2d");
		if (!context) {
			return;
		}
		context.clearRect(0, 0, preview.width, preview.height);
		context.drawImage(working, 0, 0);
		if (tool === "select") {
			for (const segment of segments.slice(0, 100)) {
				const selected = segment.id === selectedSegmentId;
				paintMask(
					context,
					segment,
					selected ? [32, 190, 150, 110] : [70, 145, 255, 45]
				);
			}
		}
		drawMarkups(context, markups, preview.width, preview.height);
		if (pointerPreview.length > 0 && tool === "select") {
			const [first, ...rest] = pointerPreview;
			if (first) {
				context.beginPath();
				context.moveTo(first.x * preview.width, first.y * preview.height);
				for (const point of rest) {
					context.lineTo(point.x * preview.width, point.y * preview.height);
				}
				context.lineCap = "round";
				context.lineJoin = "round";
				context.lineWidth = Math.max(
					12,
					Math.min(preview.width, preview.height) * 0.035
				);
				context.strokeStyle = "rgba(250, 204, 21, 0.72)";
				context.stroke();
			}
		}
	}, [markups, pointerPreview, revision, segments, selectedSegmentId, tool]);

	const installCanvas = useCallback((canvas: HTMLCanvasElement) => {
		workingCanvasRef.current = canvas;
		setDimensions({ height: canvas.height, width: canvas.width });
		setSegments([]);
		setSelectedSegmentId(null);
		setRevision((current) => current + 1);
	}, []);

	const saveModels = useCallback(() => {
		if (!isValidBrowserModelId(models.segmentationModelId)) {
			setError("Enter a valid segmentation model id in the form org/model.");
			return false;
		}
		if (!isValidBrowserModelId(models.backgroundRemovalModelId)) {
			setError(
				"Enter a valid background-removal model id in the form org/model."
			);
			return false;
		}
		if (!saveImageEditorModelPreferences(models)) {
			setError("Model choices could not be saved in this browser.");
			return false;
		}
		setError(null);
		return true;
	}, [models]);

	return {
		imageCanvasRef,
		workingCanvasRef,
		originalBlobRef,
		aiResizeAbortRef,
		attachmentExportAbortRef,
		pointerPointsRef,
		pointerToolRef,
		dimensions,
		setDimensions,
		paddingInput,
		setPaddingInput,
		resizeAspect,
		setResizeAspect,
		resizeEngine,
		setResizeEngine,
		resizePresetOptions,
		resizeInstructions,
		setResizeInstructions,
		commentInput,
		setCommentInput,
		markups,
		setMarkups,
		segments,
		setSegments,
		selectedSegmentId,
		setSelectedSegmentId,
		pointerPreview,
		setPointerPreview,
		tool,
		setTool,
		imageLoading,
		setImageLoading,
		operation,
		setOperation,
		engineStatus,
		setEngineStatus,
		error,
		setError,
		editorNotice,
		setEditorNotice,
		models,
		setModels,
		modelSettingsOpen,
		setModelSettingsOpen,
		resizePanelOpen,
		setResizePanelOpen,
		paddingPanelOpen,
		setPaddingPanelOpen,
		revision,
		setRevision,
		editorReady,
		isBusy,
		selectedSegment,
		installCanvas,
		saveModels,
	};
}

export type ImageEditorState = ReturnType<typeof useImageEditorState>;
