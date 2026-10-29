import type {
	BackgroundRemovalPipeline,
	ImageSegmentationPipeline,
	ProgressInfo,
	RawImage,
} from "@huggingface/transformers";

import { type BrowserImageTask, isValidBrowserModelId } from "./catalog.ts";

export type BrowserImageRuntimeStatus =
	| {
			modelId: string;
			phase: "loading";
			progress?: number;
			statusMessage: string;
			task: BrowserImageTask;
	  }
	| {
			modelId: string;
			phase: "running";
			statusMessage: string;
			task: BrowserImageTask;
	  }
	| {
			modelId: string;
			phase: "ready";
			statusMessage: string;
			task: BrowserImageTask;
	  }
	| {
			modelId: string;
			phase: "failed";
			statusMessage: string;
			task: BrowserImageTask;
	  };

export interface BrowserImageSegment {
	height: number;
	/** Stable for this model result; use the mask pixels rather than this id as authority. */
	id: string;
	label: string;
	mask: Uint8Array;
	score: number;
	width: number;
}

export interface BrowserImagePixels {
	data: Uint8ClampedArray;
	height: number;
	width: number;
}

export interface BrowserImageSegmentRequest {
	image: Blob;
	modelId: string;
}

export interface BrowserImageBackgroundRemovalRequest {
	image: Blob;
	modelId: string;
}

export type BrowserImageRuntimeListener = (
	status: BrowserImageRuntimeStatus
) => void;

export interface BrowserImageEngine {
	removeBackground(
		request: BrowserImageBackgroundRemovalRequest
	): Promise<BrowserImagePixels>;
	segment(request: BrowserImageSegmentRequest): Promise<BrowserImageSegment[]>;
	subscribe(listener: BrowserImageRuntimeListener): () => void;
}

function statusKey(task: BrowserImageTask, modelId: string): string {
	return `${task}:${modelId}`;
}

function progressFrom(value: ProgressInfo): number | undefined {
	return "progress" in value
		? Math.max(0, Math.min(100, value.progress))
		: undefined;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The image model failed.";
}

function validateModelId(modelId: string): void {
	if (!isValidBrowserModelId(modelId)) {
		throw new Error("Use a Hugging Face model id in the form org/model.");
	}
}

/** Convert a Transformers.js mask into a compact one-byte-per-pixel binary map. */
export function normalizeBrowserImageMask(image: RawImage): Uint8Array {
	const pixelCount = image.width * image.height;
	if (
		!Number.isSafeInteger(pixelCount) ||
		pixelCount < 1 ||
		image.data.length < pixelCount * image.channels
	) {
		throw new Error("The segmentation model returned an invalid mask.");
	}

	let maximum = 0;
	for (let pixel = 0; pixel < pixelCount; pixel += 1) {
		maximum = Math.max(maximum, image.data[pixel * image.channels] ?? 0);
	}
	const threshold = maximum <= 1 ? 0.5 : 127;
	const mask = new Uint8Array(pixelCount);
	for (let pixel = 0; pixel < pixelCount; pixel += 1) {
		mask[pixel] = (image.data[pixel * image.channels] ?? 0) > threshold ? 1 : 0;
	}
	return mask;
}

/** Normalize grayscale, RGB, and RGBA model output to an explicit RGBA buffer. */
export function normalizeBrowserImagePixels(
	image: RawImage
): BrowserImagePixels {
	const pixelCount = image.width * image.height;
	if (
		!Number.isSafeInteger(pixelCount) ||
		pixelCount < 1 ||
		image.data.length < pixelCount * image.channels
	) {
		throw new Error("The background-removal model returned invalid pixels.");
	}

	const rgba = new Uint8ClampedArray(pixelCount * 4);
	for (let pixel = 0; pixel < pixelCount; pixel += 1) {
		const sourceIndex = pixel * image.channels;
		const targetIndex = pixel * 4;
		const red = image.data[sourceIndex] ?? 0;
		if (image.channels < 3) {
			rgba[targetIndex] = red;
			rgba[targetIndex + 1] = red;
			rgba[targetIndex + 2] = red;
			rgba[targetIndex + 3] =
				image.channels === 2 ? (image.data[sourceIndex + 1] ?? 255) : 255;
			continue;
		}
		rgba[targetIndex] = red;
		rgba[targetIndex + 1] = image.data[sourceIndex + 1] ?? red;
		rgba[targetIndex + 2] = image.data[sourceIndex + 2] ?? red;
		rgba[targetIndex + 3] =
			image.channels === 4 ? (image.data[sourceIndex + 3] ?? 255) : 255;
	}
	return { data: rgba, height: image.height, width: image.width };
}

/** Local Transformers.js image engines. Image blobs are passed directly to the model. */
export class BrowserLocalImageRuntime implements BrowserImageEngine {
	private readonly listeners = new Set<BrowserImageRuntimeListener>();
	private readonly statuses = new Map<string, BrowserImageRuntimeStatus>();
	private readonly segmentationPipelines = new Map<
		string,
		Promise<ImageSegmentationPipeline>
	>();
	private readonly backgroundPipelines = new Map<
		string,
		Promise<BackgroundRemovalPipeline>
	>();

	getStatus(
		task: BrowserImageTask,
		modelId: string
	): BrowserImageRuntimeStatus | undefined {
		return this.statuses.get(statusKey(task, modelId));
	}

	subscribe(listener: BrowserImageRuntimeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private publish(status: BrowserImageRuntimeStatus): void {
		this.statuses.set(statusKey(status.task, status.modelId), status);
		for (const listener of this.listeners) {
			listener(status);
		}
	}

	private async createSegmentationPipeline(
		modelId: string
	): Promise<ImageSegmentationPipeline> {
		validateModelId(modelId);
		const transformers = await import("@huggingface/transformers");
		transformers.env.useBrowserCache = true;
		transformers.env.useFSCache = false;
		transformers.env.useWasmCache = true;
		const devices: "wasm"[] = ["wasm"];
		let lastError: unknown;
		for (const device of devices) {
			this.publish({
				modelId,
				phase: "loading",
				statusMessage: `Preparing segmentation on ${device}.`,
				task: "image-segmentation",
			});
			try {
				return await transformers.pipeline("image-segmentation", modelId, {
					device,
					progress_callback: (info: ProgressInfo) => {
						const progress = progressFrom(info);
						this.publish({
							modelId,
							phase: "loading",
							progress,
							statusMessage:
								progress === undefined
									? `Downloading segmentation model files on ${device}…`
									: `Downloading segmentation model (${Math.round(progress)}%).`,
							task: "image-segmentation",
						});
					},
				});
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(
			`The segmentation model could not be prepared: ${errorMessage(lastError)}`
		);
	}

	private async createBackgroundRemovalPipeline(
		modelId: string
	): Promise<BackgroundRemovalPipeline> {
		validateModelId(modelId);
		const transformers = await import("@huggingface/transformers");
		transformers.env.useBrowserCache = true;
		transformers.env.useFSCache = false;
		transformers.env.useWasmCache = true;
		const devices: "wasm"[] = ["wasm"];
		let lastError: unknown;
		for (const device of devices) {
			this.publish({
				modelId,
				phase: "loading",
				statusMessage: `Preparing background removal on ${device}.`,
				task: "background-removal",
			});
			try {
				return await transformers.pipeline("background-removal", modelId, {
					device,
					progress_callback: (info: ProgressInfo) => {
						const progress = progressFrom(info);
						this.publish({
							modelId,
							phase: "loading",
							progress,
							statusMessage:
								progress === undefined
									? `Downloading background-removal model files on ${device}…`
									: `Downloading background-removal model (${Math.round(progress)}%).`,
							task: "background-removal",
						});
					},
				});
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(
			`The background-removal model could not be prepared: ${errorMessage(lastError)}`
		);
	}

	private getSegmentationPipeline(
		modelId: string
	): Promise<ImageSegmentationPipeline> {
		let loading = this.segmentationPipelines.get(modelId);
		if (!loading) {
			loading = this.createSegmentationPipeline(modelId)
				.then((pipeline) => {
					this.publish({
						modelId,
						phase: "ready",
						statusMessage: "Segmentation model ready in this browser.",
						task: "image-segmentation",
					});
					return pipeline;
				})
				.catch((error) => {
					this.segmentationPipelines.delete(modelId);
					this.publish({
						modelId,
						phase: "failed",
						statusMessage: errorMessage(error),
						task: "image-segmentation",
					});
					throw error;
				});
			this.segmentationPipelines.set(modelId, loading);
		}
		return loading;
	}

	private getBackgroundRemovalPipeline(
		modelId: string
	): Promise<BackgroundRemovalPipeline> {
		let loading = this.backgroundPipelines.get(modelId);
		if (!loading) {
			loading = this.createBackgroundRemovalPipeline(modelId)
				.then((pipeline) => {
					this.publish({
						modelId,
						phase: "ready",
						statusMessage: "Background-removal model ready in this browser.",
						task: "background-removal",
					});
					return pipeline;
				})
				.catch((error) => {
					this.backgroundPipelines.delete(modelId);
					this.publish({
						modelId,
						phase: "failed",
						statusMessage: errorMessage(error),
						task: "background-removal",
					});
					throw error;
				});
			this.backgroundPipelines.set(modelId, loading);
		}
		return loading;
	}

	async segment({
		image,
		modelId,
	}: BrowserImageSegmentRequest): Promise<BrowserImageSegment[]> {
		validateModelId(modelId);
		if (image.size < 1) {
			throw new Error("Choose a non-empty image to segment.");
		}
		try {
			const segmenter = await this.getSegmentationPipeline(modelId);
			this.publish({
				modelId,
				phase: "running",
				statusMessage: "Finding subjects…",
				task: "image-segmentation",
			});
			const predictions = await segmenter(image, { threshold: 0.45 });
			const segments = predictions.slice(0, 32).map((prediction, index) => ({
				id: `${modelId}:${index}`,
				label: prediction.label?.trim() || `Subject ${index + 1}`,
				mask: normalizeBrowserImageMask(prediction.mask),
				score: prediction.score ?? 0,
				height: prediction.mask.height,
				width: prediction.mask.width,
			}));
			this.publish({
				modelId,
				phase: "ready",
				statusMessage: `${segments.length} subject${segments.length === 1 ? "" : "s"} found.`,
				task: "image-segmentation",
			});
			return segments;
		} catch (error) {
			this.publish({
				modelId,
				phase: "failed",
				statusMessage: errorMessage(error),
				task: "image-segmentation",
			});
			throw error;
		}
	}

	async removeBackground({
		image,
		modelId,
	}: BrowserImageBackgroundRemovalRequest): Promise<BrowserImagePixels> {
		validateModelId(modelId);
		if (image.size < 1) {
			throw new Error("Choose a non-empty image for background removal.");
		}
		try {
			const remover = await this.getBackgroundRemovalPipeline(modelId);
			this.publish({
				modelId,
				phase: "running",
				statusMessage: "Removing background…",
				task: "background-removal",
			});
			const result = await remover(image);
			const pixels = normalizeBrowserImagePixels(result);
			this.publish({
				modelId,
				phase: "ready",
				statusMessage: "Background removed.",
				task: "background-removal",
			});
			return pixels;
		} catch (error) {
			this.publish({
				modelId,
				phase: "failed",
				statusMessage: errorMessage(error),
				task: "background-removal",
			});
			throw error;
		}
	}
}

export function createBrowserLocalImageRuntime(): BrowserLocalImageRuntime {
	return new BrowserLocalImageRuntime();
}
