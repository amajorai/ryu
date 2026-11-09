import type { LiteralMessage } from "@ryu/i18n";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { formatLocalNumber } from "@/src/lib/locale-format.ts";
import {
	EDITABLE_IMAGE_ERRORS,
	EditableImageError,
} from "./image-editor-load-error.ts";

export const MAX_EDITABLE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_EDITABLE_IMAGE_PIXELS = 40_000_000;
export const MAX_EDITABLE_IMAGE_SIDE = 16_000;

const EDITABLE_IMAGE_TYPES = new Set([
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

export interface NormalizedImagePoint {
	x: number;
	y: number;
}

export function isEditableImageType(mimeType: string): boolean {
	return EDITABLE_IMAGE_TYPES.has(mimeType.trim().toLowerCase());
}

export function imageDimensionError(
	tl: LiteralMessage,
	width: number,
	height: number
): string | null {
	if (
		!(Number.isSafeInteger(width) && Number.isSafeInteger(height)) ||
		width < 1 ||
		height < 1
	) {
		return "Image width and height must be positive whole numbers.";
	}
	if (width > MAX_EDITABLE_IMAGE_SIDE || height > MAX_EDITABLE_IMAGE_SIDE) {
		return tl("Image dimensions must stay below {maxSide} px per side.", {
			maxSide: formatLocalNumber(MAX_EDITABLE_IMAGE_SIDE),
		});
	}
	if (width * height > MAX_EDITABLE_IMAGE_PIXELS) {
		return "This image is too large to edit safely in the browser.";
	}
	return null;
}

export function normalizedImagePoint(
	clientX: number,
	clientY: number,
	imageRect: Pick<DOMRect, "left" | "top" | "width" | "height">
): NormalizedImagePoint | null {
	if (imageRect.width <= 0 || imageRect.height <= 0) {
		return null;
	}
	return {
		x: Math.max(0, Math.min(1, (clientX - imageRect.left) / imageRect.width)),
		y: Math.max(0, Math.min(1, (clientY - imageRect.top) / imageRect.height)),
	};
}

async function readBoundedImage(
	response: Response,
	mimeType: string
): Promise<Blob> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > MAX_EDITABLE_IMAGE_BYTES
	) {
		throw new EditableImageError(EDITABLE_IMAGE_ERRORS.tooLarge);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		throw new EditableImageError(EDITABLE_IMAGE_ERRORS.noBody);
	}
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > MAX_EDITABLE_IMAGE_BYTES) {
				await reader.cancel();
				throw new EditableImageError(EDITABLE_IMAGE_ERRORS.tooLarge);
			}
			chunks.push(new Uint8Array(value));
		}
	} finally {
		reader.releaseLock();
	}
	return new Blob(chunks, { type: mimeType });
}

/** Fetch only media URLs allowed by the shared renderer, without external cookies. */
export async function fetchEditableImage(
	url: string,
	signal?: AbortSignal
): Promise<Blob> {
	const safeUrl = safeMediaUrl(url);
	if (!safeUrl) {
		throw new EditableImageError(EDITABLE_IMAGE_ERRORS.unsafeUrl);
	}
	const response = await fetch(safeUrl, {
		credentials: "same-origin",
		signal,
	});
	if (!response.ok) {
		throw new EditableImageError(EDITABLE_IMAGE_ERRORS.status, {
			status: response.status,
		});
	}
	const mimeType =
		response.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase() ?? "";
	if (!isEditableImageType(mimeType)) {
		throw new EditableImageError(EDITABLE_IMAGE_ERRORS.unsupportedType);
	}
	return readBoundedImage(response, mimeType);
}
