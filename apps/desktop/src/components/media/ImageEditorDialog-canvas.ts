import type {
	BrowserImageRuntimeStatus,
	BrowserImageSegment,
} from "@ryu/browser-local-ai";
import {
	type ImageResizeAspect,
	localImageResizeDimensions,
} from "@/src/lib/api/image-resize.ts";
import type { ImageMarkup } from "./ImageEditorDialog-types.ts";
import {
	imageDimensionError,
	type NormalizedImagePoint,
} from "./image-editor-utils.ts";

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
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

export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
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

export async function createInferenceBlob(
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

export async function prepareLocalImageResize(
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

export function canvasCopy(source: HTMLCanvasElement): HTMLCanvasElement {
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

export function getSegmentAtPoints(
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

export function paintMask(
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

export function drawMarkups(
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

export function safeBaseName(filename: string | undefined): string {
	const fileLeaf = filename?.split(/[\\/]/u).at(-1) ?? "image";
	const base = fileLeaf
		.replace(/\.[^.]+$/u, "")
		.replace(/[^\p{L}\p{N}._ -]/gu, "-")
		.trim();
	return base || "image";
}

export function messageForStatus(
	status: BrowserImageRuntimeStatus | null
): string | null {
	if (!status) {
		return null;
	}
	return status.statusMessage;
}
