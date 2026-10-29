import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";

const nativeTextSchema = z.string();
const nativeImageStatusSchema = z.enum([
	"queued",
	"generating",
	"refining",
	"complete",
	"error",
]);
const nativeVideoStatusSchema = z.enum([
	"queued",
	"generating",
	"rendering",
	"complete",
	"error",
]);

import {
	type NativeCoreErrorObservation,
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "./native-sdk-observation.ts";

interface NativeMediaFields {
	data?: NativeSdkValue;
	fileName?: NativeSdkValue;
	filename?: NativeSdkValue;
	image?: NativeSdkValue;
	mediaType?: NativeSdkValue;
	message?: NativeSdkValue;
	mimeType?: NativeSdkValue;
	name?: NativeSdkValue;
	poster?: NativeSdkValue;
	prompt?: NativeSdkValue;
	status?: NativeSdkValue;
	statusText?: NativeSdkValue;
	text?: NativeSdkValue;
	title?: NativeSdkValue;
	type?: NativeSdkValue;
	url?: NativeSdkValue;
}
function isNativeText(value: NativeSdkValue): value is string {
	return nativeSdkSchemaAdmits(nativeTextSchema, value);
}
function isImageGenerationStatus(
	value: NativeSdkValue
): value is ImageGenerationStatus {
	return nativeSdkSchemaAdmits(nativeImageStatusSchema, value);
}
function isVideoGenerationStatus(
	value: NativeSdkValue
): value is VideoGenerationStatus {
	return nativeSdkSchemaAdmits(nativeVideoStatusSchema, value);
}
type ImageGenerationStatus =
	| "queued"
	| "generating"
	| "refining"
	| "complete"
	| "error";
type VideoGenerationStatus =
	| "queued"
	| "generating"
	| "rendering"
	| "complete"
	| "error";
interface ImageGenerationPartData {
	prompt?: string;
	status: ImageGenerationStatus;
	statusText?: string;
	url?: string;
}
interface VideoGenerationPartData {
	poster?: string;
	prompt?: string;
	status: VideoGenerationStatus;
	statusText?: string;
	url?: string;
}
export function isRecord(value: NativeSdkValue): value is NativeMediaFields {
	return nativeSdkSchemaAdmits(nativeSdkObjectSchema, value);
}
export function isTextPart(
	part: NativeSdkValue
): part is { type: "text"; text: string } {
	return isRecord(part) && part.type === "text" && isNativeText(part.text);
}
export function isErrorPart(
	part: NativeSdkValue
): part is NativeCoreErrorObservation {
	return isRecord(part) && part.type === "error" && isNativeText(part.message);
}
export function getAssistantImageMeta(
	part: NativeSdkValue
): { filename?: string; url: string } | null {
	if (!isRecord(part)) {
		return null;
	}
	const type = part.type;
	const media = isNativeText(part.mediaType)
		? part.mediaType
		: isNativeText(part.mimeType)
			? part.mimeType
			: undefined;
	const filename = isNativeText(part.filename)
		? part.filename
		: isNativeText(part.fileName)
			? part.fileName
			: isNativeText(part.name)
				? part.name
				: undefined;

	const rawUrl =
		type === "image"
			? isNativeText(part.url)
				? part.url
				: isNativeText(part.image)
					? part.image
					: undefined
			: type === "data-image" && isRecord(part.data)
				? isNativeText(part.data.url)
					? part.data.url
					: undefined
				: isNativeText(part.url)
					? part.url
					: undefined;
	const rawData =
		type === "file" && isNativeText(part.data) ? part.data : undefined;
	const url =
		rawUrl ?? (rawData && media ? `data:${media};base64,${rawData}` : null);
	if (
		!(
			url &&
			(type === "image" || type === "data-image" || media?.startsWith("image/"))
		)
	) {
		return null;
	}
	return { filename, url };
}
export function getImageGenerationPart(
	part: NativeSdkValue
): ImageGenerationPartData | null {
	if (!isRecord(part) || part.type !== "data-image-generation") {
		return null;
	}
	const data = isRecord(part.data) ? part.data : {};
	const status =
		isNativeText(data.status) && isImageGenerationStatus(data.status)
			? data.status
			: "generating";
	return {
		prompt: isNativeText(data.prompt) ? data.prompt : undefined,
		status,
		statusText: isNativeText(data.statusText) ? data.statusText : undefined,
		url: isNativeText(data.url) ? data.url : undefined,
	};
}
export function getVideoGenerationPart(
	part: NativeSdkValue
): VideoGenerationPartData | null {
	if (!isRecord(part) || part.type !== "data-video-generation") {
		return null;
	}
	const data = isRecord(part.data) ? part.data : {};
	const status =
		isNativeText(data.status) && isVideoGenerationStatus(data.status)
			? data.status
			: "generating";
	return {
		poster: isNativeText(data.poster) ? data.poster : undefined,
		prompt: isNativeText(data.prompt) ? data.prompt : undefined,
		status,
		statusText: isNativeText(data.statusText) ? data.statusText : undefined,
		url: isNativeText(data.url) ? data.url : undefined,
	};
}

export function nativeOptionalSdkText(
	value: NativeSdkValue
): string | undefined {
	return isNativeText(value) ? value : undefined;
}
