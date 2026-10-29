import { z } from "zod";

const nativeTextSchema = z.string();

import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";
import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "./native-sdk-observation.ts";

interface NativeFileObservation {
	data?: NativeSdkValue;
	fileName?: NativeSdkValue;
	filename?: NativeSdkValue;
	mediaType?: NativeSdkValue;
	mimeType?: NativeSdkValue;
	name?: NativeSdkValue;
	size?: NativeSdkValue;
	type?: NativeSdkValue;
	url?: NativeSdkValue;
}
const fileObservation = z.custom<NativeFileObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
const finiteNumber = z.number();
const nanNumber = z.nan();
const positiveInfinity = z.literal(Number.POSITIVE_INFINITY);
const negativeInfinity = z.literal(Number.NEGATIVE_INFINITY);
export function nativeSdkNumber(value: NativeSdkValue): value is number {
	return (
		nativeSdkSchemaAdmits(finiteNumber, value) ||
		nativeSdkSchemaAdmits(nanNumber, value) ||
		nativeSdkSchemaAdmits(positiveInfinity, value) ||
		nativeSdkSchemaAdmits(negativeInfinity, value)
	);
}
export function getAssistantVideoUrl(rawPart: NativeSdkValue): string | null {
	const observed = fileObservation.safeParse(rawPart);
	if (!observed.success || observed.data.type !== "file") {
		return null;
	}
	const filePart = observed.data;
	const rawMedia = filePart.mediaType ?? filePart.mimeType;
	if (rawMedia === null || rawMedia === undefined) {
		return null;
	}
	const media = nativeTextSchema.parse(rawMedia);
	if (!media.startsWith("video/")) {
		return null;
	}
	if (filePart.url) {
		return safeMediaUrl(filePart.url);
	}
	if (filePart.data) {
		return safeMediaUrl(`data:${media};base64,${filePart.data}`);
	}
	return null;
}
export function getAssistantFileMeta(
	rawPart: NativeSdkValue
): { filename: string; media: string; size?: number; url: string } | null {
	const observed = fileObservation.safeParse(rawPart);
	if (!observed.success || observed.data.type !== "file") {
		return null;
	}
	const filePart = observed.data;
	const rawMedia = filePart.mediaType ?? filePart.mimeType;
	if (!rawMedia) {
		return null;
	}
	const media = nativeTextSchema.parse(rawMedia);
	if (media.startsWith("image/") || media.startsWith("video/")) {
		return null;
	}
	const url = safeMediaUrl(
		filePart.url ??
			(filePart.data ? `data:${media};base64,${filePart.data}` : undefined)
	);
	if (url) {
		return {
			filename: nativeTextSchema.parse(
				filePart.filename ?? filePart.fileName ?? filePart.name ?? "Attachment"
			),
			media,
			size: nativeSdkNumber(filePart.size) ? filePart.size : undefined,
			url,
		};
	}
	return null;
}
