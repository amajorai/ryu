import { ImageLightbox } from "@ryu/blocks/desktop/agent-elements/image-lightbox.tsx";
import type {
	BrowserImageEngine,
	BrowserImageRuntimeListener,
	BrowserImageSegment,
} from "@ryu/browser-local-ai";
import { Button } from "@ryu/ui/components/button.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";

import {
	type ImageEditorAsset,
	ImageEditorDialog,
} from "../../src/components/media/ImageEditorDialog.tsx";
import { fetchEditableImage } from "../../src/components/media/image-editor-utils.ts";
import {
	buildImageResizePrompt,
	type ImageResizeAspect,
	localImageResizeDimensions,
} from "../../src/lib/api/image-resize.ts";
import type { ImageResizeRequest } from "../../src/lib/api/images.ts";
import { generateImageResize } from "../../src/lib/api/images.ts";
import "../../src/index.css";

function createSampleImageUrl(width = 640, height = 480): string {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Could not draw the sample image.");
	}
	context.fillStyle = "#e5e7eb";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = "#bf4f42";
	context.fillRect(190, 95, 260, 290);
	context.fillStyle = "#7c2d28";
	context.fillRect(250, 155, 140, 165);
	return canvas.toDataURL("image/png");
}

async function createFakeAiResize(request: ImageResizeRequest): Promise<Blob> {
	const source = await createImageBitmap(request.image);
	const ratioByAspect = {
		square: 1,
		landscape: 3 / 2,
		portrait: 2 / 3,
		widescreen: 16 / 9,
		story: 9 / 16,
	} satisfies Record<Exclude<ImageResizeAspect, "original">, number>;
	const ratio =
		request.aspect === "original"
			? request.width / request.height
			: ratioByAspect[request.aspect];
	const width = ratio >= 1 ? 960 : Math.round(960 * ratio);
	const height = ratio >= 1 ? Math.round(960 / ratio) : 960;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) {
		source.close();
		throw new Error("Could not draw the mock AI-resized image.");
	}
	context.fillStyle = "#e5e7eb";
	context.fillRect(0, 0, width, height);
	const scale = Math.min(width / source.width, height / source.height);
	const sourceWidth = source.width * scale;
	const sourceHeight = source.height * scale;
	context.drawImage(
		source,
		(width - sourceWidth) / 2,
		(height - sourceHeight) / 2,
		sourceWidth,
		sourceHeight
	);
	source.close();
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) {
				resolve(blob);
			} else {
				reject(new Error("Could not export the mock AI-resized image."));
			}
		}, "image/png");
	});
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (isNativeText(reader.result)) {
				resolve(reader.result);
				return;
			}
			reject(new Error("Could not encode the local image fixture."));
		};
		reader.onerror = () =>
			reject(
				reader.error ?? new Error("Could not read the local image fixture.")
			);
		reader.readAsDataURL(blob);
	});
}

function firstBase64Image(value: { images: string[] }): string {
	const image = value.images[0];
	if (!image) {
		throw new Error("The local image model returned no output image.");
	}
	return image;
}

async function resizeBlob(
	blob: Blob,
	width: number,
	height: number
): Promise<Blob> {
	const source = await createImageBitmap(blob);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) {
		source.close();
		throw new Error("Could not prepare the live local image-model input.");
	}
	context.drawImage(source, 0, 0, width, height);
	source.close();
	return new Promise((resolve, reject) => {
		canvas.toBlob((result) => {
			if (result) {
				resolve(result);
				return;
			}
			reject(new Error("Could not export the live local image-model input."));
		}, "image/png");
	});
}

async function createLiveLocalAiResize(
	request: ImageResizeRequest
): Promise<Blob> {
	if (request.engine !== "local") {
		throw new Error("This live proof only allows the on-device image model.");
	}
	const { height, width } = localImageResizeDimensions(
		request.aspect,
		request.width,
		request.height,
		1024
	);
	const resizedInput = await resizeBlob(request.image, width, height);
	const image = await blobToDataUrl(resizedInput);
	const resizedMask = request.mask
		? await resizeBlob(request.mask, width, height)
		: undefined;
	const mask = resizedMask ? await blobToDataUrl(resizedMask) : undefined;
	const response = await fetch("/__local-sdcpp/sdapi/v1/img2img", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			batch_size: 1,
			cfg_scale: 7,
			denoising_strength: request.denoisingStrength,
			height,
			init_images: [image],
			...(mask ? { inpainting_mask_invert: false, mask } : undefined),
			prompt: buildImageResizePrompt(
				request.aspect,
				request.width,
				request.height,
				request.instructions
			),
			seed: 42,
			steps: 8,
			width,
		}),
		signal: request.signal,
	});
	if (!response.ok) {
		throw new Error(`Local image model failed with status ${response.status}.`);
	}
	const imageBytes = Uint8Array.from(
		atob(
			firstBase64Image(
				z.object({ images: z.array(z.string()) }).parse(await response.json())
			)
		),
		(character) => character.charCodeAt(0)
	);
	return new Blob([imageBytes], { type: "image/png" });
}

function createFakeRuntime(): BrowserImageEngine {
	const listeners = new Set<BrowserImageRuntimeListener>();
	const publish = (status: Parameters<BrowserImageRuntimeListener>[0]) => {
		for (const listener of listeners) {
			listener(status);
		}
	};
	return {
		async segment({ modelId }): Promise<BrowserImageSegment[]> {
			publish({
				modelId,
				phase: "running",
				statusMessage: "Finding subjects…",
				task: "image-segmentation",
			});
			const width = 64;
			const height = 48;
			const mask = new Uint8Array(width * height);
			for (let y = 9; y < 39; y += 1) {
				for (let x = 17; x < 47; x += 1) {
					mask[y * width + x] = 1;
				}
			}
			publish({
				modelId,
				phase: "ready",
				statusMessage: "1 subject found.",
				task: "image-segmentation",
			});
			return [
				{
					id: "proof-subject",
					label: "Sample subject",
					mask,
					score: 0.98,
					width,
					height,
				},
			];
		},
		async removeBackground({ modelId }) {
			const width = 640;
			const height = 480;
			const data = new Uint8ClampedArray(width * height * 4);
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const offset = (y * width + x) * 4;
					data[offset] = 191;
					data[offset + 1] = 79;
					data[offset + 2] = 66;
					data[offset + 3] =
						x >= 170 && x < 470 && y >= 70 && y < 410 ? 255 : 0;
				}
			}
			publish({
				modelId,
				phase: "ready",
				statusMessage: "Background removed.",
				task: "background-removal",
			});
			return { data, height, width };
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function ImageEditorProof() {
	const useProductionApi = new URLSearchParams(window.location.search).has(
		"production-api"
	);
	const useLiveModels = new URLSearchParams(window.location.search).has(
		"live-models"
	);
	const useLiveLocalModel = new URLSearchParams(window.location.search).has(
		"live-local-model"
	);
	const image = useMemo<ImageEditorAsset>(
		() => ({
			filename: "sample.png",
			id: "image-editor-proof",
			url: useLiveModels
				? "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/portrait-of-woman_small.jpg"
				: createSampleImageUrl(),
		}),
		[useLiveModels]
	);
	const originRef = useRef<HTMLButtonElement | null>(null);
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const [editingImage, setEditingImage] = useState<ImageEditorAsset | null>(
		null
	);
	const [attachedFilename, setAttachedFilename] = useState("");
	const [attachmentCount, setAttachmentCount] = useState(0);
	const [runtime] = useState<BrowserImageEngine | undefined>(() =>
		new URLSearchParams(window.location.search).has("live-models")
			? undefined
			: createFakeRuntime()
	);

	return (
		<div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 bg-background p-8 text-foreground">
			<div>
				<p className="text-muted-foreground text-xs uppercase tracking-wider">
					Ryu chat media
				</p>
				<h1 className="mt-1 font-semibold text-2xl">Image editor proof</h1>
			</div>
			<div className="flex items-start gap-4 rounded-2xl border bg-card p-5">
				<img
					alt="Sample image with a subject on a plain background"
					className="size-24 rounded-lg object-cover"
					src={image.url}
				/>
				<div className="grid gap-3">
					<p className="font-medium text-sm">sample.png</p>
					<Button
						data-testid="open-sample-image"
						onClick={() => setLightboxOpen(true)}
						ref={originRef}
						size="sm"
						variant="outline"
					>
						Open image
					</Button>
				</div>
			</div>
			{attachedFilename && (
				<p
					className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
					data-testid="attached-file"
				>
					Attached to composer: {attachedFilename}
				</p>
			)}
			{useProductionApi && (
				<>
					<Button
						data-testid="replace-editor-image"
						onClick={() =>
							setEditingImage({
								filename: "replacement.png",
								id: "replacement-image",
								url: createSampleImageUrl(320, 200),
							})
						}
					>
						Replace editor image
					</Button>
					<output data-testid="attachment-count">{attachmentCount}</output>
				</>
			)}
			<ImageLightbox
				images={[image]}
				onAnnotate={setEditingImage}
				onClose={() => setLightboxOpen(false)}
				open={lightboxOpen}
				originRef={originRef}
			/>
			<ImageEditorDialog
				image={editingImage}
				onAiResize={
					useProductionApi
						? async (request) => {
								const url = await generateImageResize(
									{
										url: "https://image-node.example.test",
										token: "image-node-fixture-token",
									},
									request
								);
								return fetchEditableImage(url, request.signal);
							}
						: useLiveLocalModel
							? createLiveLocalAiResize
							: createFakeAiResize
				}
				onClose={() => setEditingImage(null)}
				onUseInChat={(file) => {
					setAttachedFilename(file.name);
					setAttachmentCount((count) => count + 1);
				}}
				open={editingImage !== null}
				runtime={runtime}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Image editor proof root is missing.");
}
createRoot(root).render(<ImageEditorProof />);
