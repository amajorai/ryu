"use client";

import "./ImageEditorDialog.css";

import {
	Add01Icon,
	AspectRatioIcon,
	BubbleChatIcon,
	Cancel01Icon,
	Delete01Icon,
	Image01Icon,
	PencilEdit01Icon,
	Refresh01Icon,
	Search01Icon,
	Settings01Icon,
	SmartPhone01Icon,
	SmartPhone02Icon,
	SmartPhoneLandscapeIcon,
	Square01Icon,
	Tv01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type BrowserImageEngine,
	type BrowserImageRuntimeStatus,
	type BrowserImageSegment,
	createBrowserLocalImageRuntime,
	isValidBrowserModelId,
} from "@ryu/browser-local-ai";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	type OverflowActionItem,
	OverflowActions,
} from "@ryu/ui/components/overflow-actions.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	DEFAULT_IMAGE_RESIZE_ENGINE,
	IMAGE_RESIZE_PRESETS,
	type ImageResizeAspect,
	type ImageResizeEngine,
	imageResizeAspectLabel,
	imageResizeDimensionsForEngine,
	localImageResizeDimensions,
} from "@/src/lib/api/image-resize.ts";
import type { ImageResizeRequest } from "@/src/lib/api/images.ts";
import {
	DEFAULT_IMAGE_EDITOR_MODELS,
	getImageEditorModelPreferences,
	type ImageEditorModelPreferences,
	saveImageEditorModelPreferences,
} from "@/src/lib/image-editor-models.ts";
import {
	fetchEditableImage,
	imageDimensionError,
	type NormalizedImagePoint,
	normalizedImagePoint,
} from "./image-editor-utils.ts";

const localImageRuntime = createBrowserLocalImageRuntime();

const IMAGE_RESIZE_PRESET_ICONS = {
	original: AspectRatioIcon,
	square: Square01Icon,
	landscape: SmartPhoneLandscapeIcon,
	portrait: SmartPhone01Icon,
	widescreen: Tv01Icon,
	story: SmartPhone02Icon,
} satisfies Record<ImageResizeAspect, typeof AspectRatioIcon>;

type ImageEditorTool = "select" | "markup" | "comment" | "erase";

type ImageMarkup =
	| {
			color: string;
			id: string;
			kind: "stroke";
			points: NormalizedImagePoint[];
	  }
	| {
			id: string;
			kind: "comment";
			point: NormalizedImagePoint;
			text: string;
	  };

type ImageEditorOperation =
	| { kind: "ai-resize" }
	| { kind: "segment" }
	| { kind: "background-removal" }
	| { kind: "reset" }
	| { kind: "export" }
	| null;

const IMAGE_EDITOR_OPERATION_LABELS = {
	"ai-resize": "Expanding image with AI…",
	segment: "Finding subjects…",
	"background-removal": "Removing background…",
	reset: "Restoring original image…",
	export: "Preparing PNG…",
} satisfies Record<Exclude<ImageEditorOperation, null>["kind"], string>;

export interface ImageEditorAsset {
	filename?: string;
	id: string;
	url: string;
}

export interface ImageEditorDialogProps {
	image: ImageEditorAsset | null;
	onAiResize?: (request: ImageResizeRequest) => Promise<Blob>;
	onClose: () => void;
	onOpenDrawesome?: (image: ImageEditorAsset) => void;
	onUseInChat?: (image: File) => void;
	open: boolean;
	runtime?: BrowserImageEngine;
}

interface ImageDimensions {
	height: number;
	width: number;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				reject(new Error("The browser could not export this image."));
				return;
			}
			resolve(blob);
		}, "image/png");
	});
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
	const bitmap = await createImageBitmap(blob);
	const dimensionError = imageDimensionError(bitmap.width, bitmap.height);
	if (dimensionError) {
		bitmap.close();
		throw new Error(dimensionError);
	}
	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) {
		bitmap.close();
		throw new Error("The browser could not prepare an image canvas.");
	}
	context.drawImage(bitmap, 0, 0);
	bitmap.close();
	return canvas;
}

async function createInferenceBlob(
	source: HTMLCanvasElement,
	maxSide: number
): Promise<Blob> {
	const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
	const width = Math.max(1, Math.round(source.width * scale));
	const height = Math.max(1, Math.round(source.height * scale));
	if (width === source.width && height === source.height) {
		return canvasToBlob(source);
	}
	const resized = document.createElement("canvas");
	resized.width = width;
	resized.height = height;
	const context = resized.getContext("2d");
	if (!context) {
		throw new Error("The browser could not prepare a smaller model input.");
	}
	context.drawImage(source, 0, 0, width, height);
	return canvasToBlob(resized);
}

interface PreparedLocalImageResize {
	denoisingStrength: number;
	height: number;
	image: Blob;
	mask?: Blob;
	width: number;
}

async function prepareLocalImageResize(
	source: HTMLCanvasElement,
	aspect: ImageResizeAspect
): Promise<PreparedLocalImageResize> {
	const { height, width } = localImageResizeDimensions(
		aspect,
		source.width,
		source.height
	);
	const imageCanvas = document.createElement("canvas");
	imageCanvas.width = width;
	imageCanvas.height = height;
	const imageContext = imageCanvas.getContext("2d");
	if (!imageContext) {
		throw new Error("The browser could not prepare the local image edit.");
	}
	imageContext.fillStyle = "#808080";
	imageContext.fillRect(0, 0, width, height);

	const scale = Math.min(width / source.width, height / source.height);
	const sourceWidth = source.width * scale;
	const sourceHeight = source.height * scale;
	const left = (width - sourceWidth) / 2;
	const top = (height - sourceHeight) / 2;
	imageContext.drawImage(source, left, top, sourceWidth, sourceHeight);
	const image = await canvasToBlob(imageCanvas);
	const hasExpandedArea = sourceWidth < width - 1 || sourceHeight < height - 1;
	if (!hasExpandedArea) {
		return { denoisingStrength: 0.3, height, image, width };
	}

	const maskCanvas = document.createElement("canvas");
	maskCanvas.width = width;
	maskCanvas.height = height;
	const maskContext = maskCanvas.getContext("2d");
	if (!maskContext) {
		throw new Error("The browser could not prepare the local resize mask.");
	}
	maskContext.fillStyle = "white";
	maskContext.fillRect(0, 0, width, height);
	maskContext.filter = `blur(${Math.max(8, Math.round(Math.min(width, height) * 0.012))}px)`;
	maskContext.fillStyle = "black";
	maskContext.fillRect(left, top, sourceWidth, sourceHeight);
	maskContext.filter = "none";
	const mask = await canvasToBlob(maskCanvas);
	return { denoisingStrength: 0.9, height, image, mask, width };
}

function canvasCopy(source: HTMLCanvasElement): HTMLCanvasElement {
	const copy = document.createElement("canvas");
	copy.width = source.width;
	copy.height = source.height;
	const context = copy.getContext("2d", { willReadFrequently: true });
	if (!context) {
		throw new Error("The browser could not create an image canvas.");
	}
	context.drawImage(source, 0, 0);
	return copy;
}

function getSegmentAtPoints(
	points: readonly NormalizedImagePoint[],
	segments: readonly BrowserImageSegment[]
): BrowserImageSegment | null {
	const hitCounts = new Map<string, number>();
	for (const segment of segments) {
		for (const point of points) {
			const x = Math.min(
				segment.width - 1,
				Math.floor(point.x * segment.width)
			);
			const y = Math.min(
				segment.height - 1,
				Math.floor(point.y * segment.height)
			);
			if (segment.mask[y * segment.width + x] === 1) {
				hitCounts.set(segment.id, (hitCounts.get(segment.id) ?? 0) + 1);
			}
		}
	}
	let best: BrowserImageSegment | null = null;
	let bestHits = 0;
	for (const segment of segments) {
		const hits = hitCounts.get(segment.id) ?? 0;
		if (hits > bestHits) {
			best = segment;
			bestHits = hits;
		}
	}
	return best;
}

function paintMask(
	context: CanvasRenderingContext2D,
	segment: BrowserImageSegment,
	color: readonly [number, number, number, number]
): void {
	const imageData = new ImageData(segment.width, segment.height);
	for (let pixel = 0; pixel < segment.mask.length; pixel += 1) {
		if (segment.mask[pixel] !== 1) {
			continue;
		}
		const offset = pixel * 4;
		imageData.data[offset] = color[0];
		imageData.data[offset + 1] = color[1];
		imageData.data[offset + 2] = color[2];
		imageData.data[offset + 3] = color[3];
	}
	const maskCanvas = document.createElement("canvas");
	maskCanvas.width = segment.width;
	maskCanvas.height = segment.height;
	const maskContext = maskCanvas.getContext("2d");
	if (!maskContext) {
		return;
	}
	maskContext.putImageData(imageData, 0, 0);
	context.drawImage(
		maskCanvas,
		0,
		0,
		context.canvas.width,
		context.canvas.height
	);
}

function drawMarkups(
	context: CanvasRenderingContext2D,
	markups: readonly ImageMarkup[],
	width: number,
	height: number
): void {
	for (let index = 0; index < markups.length; index += 1) {
		const markup = markups[index];
		if (!markup) {
			continue;
		}
		if (markup.kind === "stroke") {
			const [first, ...rest] = markup.points;
			if (!first) {
				continue;
			}
			context.beginPath();
			context.moveTo(first.x * width, first.y * height);
			for (const point of rest) {
				context.lineTo(point.x * width, point.y * height);
			}
			context.lineCap = "round";
			context.lineJoin = "round";
			context.lineWidth = Math.max(4, Math.min(width, height) * 0.008);
			context.strokeStyle = markup.color;
			context.stroke();
			continue;
		}

		const x = markup.point.x * width;
		const y = markup.point.y * height;
		const radius = Math.max(13, Math.min(width, height) * 0.022);
		context.beginPath();
		context.arc(x, y, radius, 0, Math.PI * 2);
		context.fillStyle = "#f97316";
		context.fill();
		context.lineWidth = Math.max(2, radius * 0.12);
		context.strokeStyle = "white";
		context.stroke();
		context.fillStyle = "white";
		context.font = `600 ${Math.max(12, radius * 0.9)}px sans-serif`;
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(String(index + 1), x, y);
		const fontSize = Math.max(14, Math.min(width, height) * 0.022);
		const comment = markup.text.slice(0, 80);
		context.font = `500 ${fontSize}px sans-serif`;
		context.textAlign = "left";
		const textWidth = context.measureText(comment).width;
		const boxX = Math.max(4, Math.min(width - textWidth - 16, x + radius + 5));
		const boxY = Math.max(fontSize, Math.min(height - fontSize, y));
		context.fillStyle = "rgba(17, 24, 39, 0.88)";
		context.fillRect(boxX, boxY - fontSize, textWidth + 12, fontSize * 2);
		context.fillStyle = "white";
		context.fillText(comment, boxX + 6, boxY);
	}
}

function safeBaseName(filename: string | undefined): string {
	const fileLeaf = filename?.split(/[\\/]/u).at(-1) ?? "image";
	const base = fileLeaf
		.replace(/\.[^.]+$/u, "")
		.replace(/[^\p{L}\p{N}._ -]/gu, "-")
		.trim();
	return base || "image";
}

function messageForStatus(
	status: BrowserImageRuntimeStatus | null
): string | null {
	if (!status) {
		return null;
	}
	return status.statusMessage;
}

export function ImageEditorDialog({
	image,
	onAiResize,
	onClose,
	onOpenDrawesome,
	onUseInChat,
	open,
	runtime = localImageRuntime,
}: ImageEditorDialogProps) {
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
			setEditorNotice(
				`AI resized to ${IMAGE_RESIZE_PRESETS.find((preset) => preset.id === resizeAspect)?.label ?? "the selected shape"}.`
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

	if (!image) {
		return null;
	}

	const statusMessage = messageForStatus(engineStatus);
	const busyLabel = operation
		? IMAGE_EDITOR_OPERATION_LABELS[operation.kind]
		: null;
	const primaryActions: OverflowActionItem[] = [
		{
			ariaLabel: "Markup brush",
			className:
				tool === "markup" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={PencilEdit01Icon} size={14} />,
			id: "markup",
			label: "Markup",
			pressed: tool === "markup",
			onClick: () => {
				setTool("markup");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		{
			ariaLabel: "Add comment",
			className:
				tool === "comment" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={BubbleChatIcon} size={14} />,
			id: "comment",
			label: "Comment",
			pressed: tool === "comment",
			onClick: () => {
				setTool("comment");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		{
			ariaLabel: "Remove background",
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Image01Icon} size={14} />,
			id: "remove-background",
			label: "Remove BG",
			onClick: () => void removeBackground(),
		},
		{
			ariaLabel: "Erase brush",
			className: tool === "erase" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Delete01Icon} size={14} />,
			id: "erase",
			label: "Erase",
			pressed: tool === "erase",
			onClick: () => {
				setTool("erase");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		{
			ariaLabel: "AI Resize",
			className: resizePanelOpen ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Square01Icon} size={14} />,
			id: "resize",
			label: "Resize",
			pressed: resizePanelOpen,
			onClick: () => {
				setResizePanelOpen((current) => !current);
				setPaddingPanelOpen(false);
				setModelSettingsOpen(false);
			},
		},
	];
	const overflowActions: OverflowActionItem[] = [
		{
			ariaLabel: "Select a detected subject",
			className:
				tool === "select" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Search01Icon} size={14} />,
			id: "select-subject",
			label: "Select subject",
			pressed: tool === "select",
			onClick: () => {
				setTool("select");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
				if (segments.length === 0) {
					void runSegmentation();
				}
			},
		},
		{
			ariaLabel: "Find subjects",
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Search01Icon} size={14} />,
			id: "find-subjects",
			label: "Find subjects",
			onClick: () => void runSegmentation(),
		},
		{
			ariaLabel: "Add transparent padding",
			className: paddingPanelOpen ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Add01Icon} size={14} />,
			id: "transparent-padding",
			label: "Transparent padding",
			pressed: paddingPanelOpen,
			onClick: () => {
				setPaddingPanelOpen((current) => !current);
				setResizePanelOpen(false);
				setModelSettingsOpen(false);
			},
		},
		{
			ariaLabel: "Reset image",
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Refresh01Icon} size={14} />,
			id: "reset",
			label: "Reset",
			onClick: () => void resetImage(),
		},
		{
			ariaLabel: "Image model settings",
			className: modelSettingsOpen
				? "bg-primary/10 text-foreground"
				: undefined,
			icon: <HugeiconsIcon icon={Settings01Icon} size={14} />,
			id: "models",
			label: "Models",
			pressed: modelSettingsOpen,
			onClick: () => {
				setModelSettingsOpen((current) => !current);
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		...(onOpenDrawesome
			? [
					{
						ariaLabel: "Open in Drawesome",
						id: "drawesome",
						label: "Drawesome",
						onClick: () => onOpenDrawesome(image),
					},
				]
			: []),
	];

	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					closeEditor();
				}
			}}
			open={open}
		>
			<DialogContent
				appearance="image-editor"
				mobileFullPage
				showCloseButton={false}
			>
				<DialogHeader className="sr-only">
					<DialogTitle>Edit image</DialogTitle>
					<DialogDescription>
						Select a subject, edit the image, or use AI Resize to expand its
						canvas.
					</DialogDescription>
				</DialogHeader>
				<div className="relative flex h-full min-h-0 flex-col bg-background">
					<header className="z-30 flex h-12 shrink-0 items-center justify-between gap-4 border-b bg-background/90 px-4 backdrop-blur-xl sm:px-6">
						<div className="min-w-0">
							<h2
								className="truncate font-medium text-sm"
								title={image.filename}
							>
								{image.filename?.trim() || "Untitled image"}
							</h2>
						</div>
						<Button
							aria-label="Close image editor"
							onClick={closeEditor}
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon icon={Cancel01Icon} size={16} />
						</Button>
					</header>

					{modelSettingsOpen && (
						<section
							aria-label="Local image model settings"
							className="absolute top-14 right-3 z-30 grid w-[min(35rem,calc(100vw-1.5rem))] gap-3 rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-xl backdrop-blur-xl sm:right-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
						>
							<label className="grid gap-1.5 text-xs">
								<span>Segmentation engine</span>
								<Input
									aria-label="Segmentation model id"
									autoCapitalize="off"
									autoComplete="off"
									onChange={(event) =>
										saveModelInput(
											"segmentationModelId",
											event.currentTarget.value
										)
									}
									spellCheck={false}
									value={models.segmentationModelId}
								/>
							</label>
							<label className="grid gap-1.5 text-xs">
								<span>Background removal engine</span>
								<Input
									aria-label="Background removal model id"
									autoCapitalize="off"
									autoComplete="off"
									onChange={(event) =>
										saveModelInput(
											"backgroundRemovalModelId",
											event.currentTarget.value
										)
									}
									spellCheck={false}
									value={models.backgroundRemovalModelId}
								/>
							</label>
							<div className="flex gap-2">
								<Button
									onClick={() => updateModels(DEFAULT_IMAGE_EDITOR_MODELS)}
									size="sm"
									variant="ghost"
								>
									Defaults
								</Button>
								<Button onClick={saveModels} size="sm" variant="secondary">
									Save models
								</Button>
							</div>
							<p className="text-muted-foreground text-xs sm:col-span-3">
								Models download once and are cached in this browser. Image
								pixels stay local during segmentation and background removal. AI
								Resize uses the image provider configured in Gateway.
							</p>
						</section>
					)}

					<main className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background">
						<div
							className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center overflow-hidden p-2 sm:p-6"
							data-image-editor-grid=""
						>
							{imageLoading && (
								<div className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">
									Loading image…
								</div>
							)}
							{dimensions && (
								<canvas
									aria-label="Image editor canvas"
									className={cn(
										"h-auto max-h-full w-full max-w-full touch-none rounded-md shadow-xl outline-none",
										tool === "select" && "cursor-crosshair",
										tool === "markup" && "cursor-crosshair",
										tool === "comment" && "cursor-copy",
										tool === "erase" && "cursor-cell"
									)}
									data-testid="image-editor-canvas"
									height={dimensions.height}
									onPointerCancel={() => {
										pointerToolRef.current = null;
										pointerPointsRef.current = [];
										setPointerPreview([]);
									}}
									onPointerDown={handlePointerDown}
									onPointerMove={handlePointerMove}
									onPointerUp={handlePointerUp}
									ref={imageCanvasRef}
									width={dimensions.width}
								/>
							)}
						</div>

						<nav
							aria-label="Image editing actions"
							className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-2"
						>
							<div className="pointer-events-auto max-w-full">
								<OverflowActions
									className="max-w-full"
									classNames={{
										label: "hidden sm:inline",
										track: "max-w-[calc(100vw-1rem)]",
									}}
									collapseOnAction
									overflowActions={overflowActions}
									primaryActions={primaryActions}
									size="sm"
								/>
							</div>
						</nav>

						{resizePanelOpen && (
							<section
								aria-label="AI resize options"
								className="absolute top-14 left-1/2 z-30 grid w-[min(30rem,calc(100vw-1.5rem))] -translate-x-1/2 gap-3 rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur-xl"
							>
								<div>
									<h3 className="font-medium text-sm">Resize with AI</h3>
									<p className="mt-1 text-muted-foreground text-xs">
										Choose a new frame. AI fills the added space without
										stretching the image.
									</p>
								</div>
								<div
									aria-label="Image resize engine"
									className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
									role="group"
								>
									<Button
										aria-pressed={resizeEngine === "local"}
										className="justify-center"
										onClick={() => setResizeEngine("local")}
										size="sm"
										variant={resizeEngine === "local" ? "outline" : "ghost"}
									>
										On this device
									</Button>
									<Button
										aria-pressed={resizeEngine === "gateway"}
										className="justify-center"
										onClick={() => setResizeEngine("gateway")}
										size="sm"
										variant={resizeEngine === "gateway" ? "outline" : "ghost"}
									>
										Gateway model
									</Button>
								</div>
								<ToggleGroup
									aria-label="Target aspect ratio and output size"
									className="grid w-full grid-cols-3"
									onValueChange={(values) => {
										const selectedPreset = IMAGE_RESIZE_PRESETS.find(
											(preset) => preset.id === values[0]
										);
										if (selectedPreset) {
											setResizeAspect(selectedPreset.id);
										}
									}}
									spacing={1.5}
									value={[resizeAspect]}
									variant="outline"
								>
									{resizePresetOptions.map(
										({ aspectLabel, dimensions: target, preset }) => (
											<ToggleGroupItem
												aria-label={`Resize to ${preset.label}, ${aspectLabel}, ${target.width} by ${target.height} pixels`}
												density="resize-preset"
												key={preset.id}
												size="sm"
												value={preset.id}
											>
												<HugeiconsIcon
													aria-hidden="true"
													icon={IMAGE_RESIZE_PRESET_ICONS[preset.id]}
													size={16}
												/>
												<span className="font-medium text-xs leading-4">
													{preset.label}
												</span>
												<span className="type-compact text-muted-foreground tabular-nums leading-3">
													{aspectLabel} · {target.width.toLocaleString()} ×{" "}
													{target.height.toLocaleString()} px
												</span>
											</ToggleGroupItem>
										)
									)}
								</ToggleGroup>
								<label className="grid gap-1.5 text-xs">
									<span>Optional guidance</span>
									<Textarea
										aria-label="AI resize guidance"
										maxLength={280}
										onChange={(event) =>
											setResizeInstructions(event.currentTarget.value)
										}
										placeholder="Continue the sky, keep the subject centered…"
										rows={2}
										value={resizeInstructions}
									/>
								</label>
								<p className="text-muted-foreground text-xs">
									{resizeEngine === "local"
										? "Uses your current local diffusion model; switch models in Store → Models. Your image stays on this device."
										: "Sends this image to the image model configured in Gateway; provider data policies and charges apply."}
								</p>
								<Button
									aria-label="Generate AI resize"
									disabled={!editorReady || isBusy || !onAiResize}
									onClick={() => void runAiResize()}
									size="sm"
								>
									AI Resize
								</Button>
							</section>
						)}

						{paddingPanelOpen && (
							<section
								aria-label="Transparent padding options"
								className="absolute top-14 left-1/2 z-30 grid w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2 gap-3 rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur-xl"
							>
								<h3 className="font-medium text-sm">Add blank padding</h3>
								<label className="grid gap-1 text-xs">
									<span>Transparent padding per side</span>
									<Input
										aria-label="Transparent padding per side"
										disabled={!editorReady || isBusy}
										inputMode="numeric"
										onChange={(event) =>
											setPaddingInput(event.currentTarget.value)
										}
										type="number"
										value={paddingInput}
									/>
								</label>
								<Button
									aria-label="Apply transparent padding"
									disabled={!editorReady || isBusy}
									onClick={expandCanvas}
									size="sm"
								>
									Add padding
								</Button>
							</section>
						)}

						{segments.length > 0 &&
							tool === "select" &&
							!(resizePanelOpen || paddingPanelOpen || modelSettingsOpen) && (
								<section
									aria-label="Detected subjects"
									className="absolute top-14 left-3 z-20 grid max-h-[min(55dvh,28rem)] w-56 gap-2 overflow-y-auto rounded-xl border bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur-xl sm:left-6"
									role="group"
								>
									<h3 className="font-medium text-xs">Detected subjects</h3>
									{segments.slice(0, 12).map((segment, index) => (
										<Button
											aria-label={`Select ${segment.label || `Subject ${index + 1}`}`}
											aria-pressed={segment.id === selectedSegmentId}
											className="min-w-0 justify-start"
											key={segment.id}
											onClick={() => setSelectedSegmentId(segment.id)}
											size="sm"
											variant={
												segment.id === selectedSegmentId ? "secondary" : "ghost"
											}
										>
											{segment.label || `Subject ${index + 1}`}
										</Button>
									))}
									<Button
										aria-label="Erase selected subject"
										disabled={!selectedSegment || isBusy}
										onClick={eraseSelectedSegment}
										size="sm"
										variant="outline"
									>
										Erase subject
									</Button>
								</section>
							)}

						{tool === "comment" && (
							<div className="absolute bottom-3 left-1/2 z-20 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur-xl">
								<label className="grid gap-1.5 text-xs">
									<span>Comment text</span>
									<Textarea
										aria-label="Comment text"
										maxLength={240}
										onChange={(event) =>
											setCommentInput(event.currentTarget.value)
										}
										placeholder="Write a note, then click the image"
										rows={2}
										value={commentInput}
									/>
								</label>
							</div>
						)}
					</main>

					<footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-6">
						<div className="min-w-0 text-xs">
							{imageLoading ? (
								<span role="status">Loading image…</span>
							) : dimensions ? (
								<span className="text-muted-foreground">
									{dimensions.width.toLocaleString()} ×{" "}
									{dimensions.height.toLocaleString()} px
								</span>
							) : (
								<span className="text-muted-foreground">Image unavailable</span>
							)}
							{busyLabel && (
								<span className="ml-3 text-muted-foreground" role="status">
									{busyLabel}
								</span>
							)}
							{editorNotice && !busyLabel && (
								<span className="ml-3 text-muted-foreground" role="status">
									{editorNotice}
								</span>
							)}
							{statusMessage && !busyLabel && !editorNotice && (
								<span className="ml-3 text-muted-foreground" role="status">
									{statusMessage}
								</span>
							)}
						</div>
						<div className="flex shrink-0 gap-2">
							{error && (
								<p
									className="max-w-sm self-center text-destructive text-xs"
									role="alert"
								>
									{error}
								</p>
							)}
							<Button
								aria-label="Download edited PNG"
								disabled={!editorReady || isBusy}
								onClick={() => void downloadImage()}
								size="sm"
								variant="outline"
							>
								Download PNG
							</Button>
							{onUseInChat && (
								<Button
									aria-label="Add edited image to chat"
									disabled={!editorReady || isBusy}
									onClick={() => void addEditedImageToChat()}
									size="sm"
								>
									Add to chat
								</Button>
							)}
						</div>
					</footer>
				</div>
			</DialogContent>
		</Dialog>
	);
}
