import {
	isNativeNumber,
	isNativeObject,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import type { UIMessage } from "ai";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";

/** Attachment normalization receives modern SDK messages and older persisted
 * messages. This is its input projection, not a claim that historical parts
 * satisfy the current full UIMessage union. Every other authored field stays on the complete SDK surface. */
export interface AttachmentMessageInput extends Omit<UIMessage, "parts"> {
	experimental_attachments?: NativeSdkValue;
	parts?: readonly NativeSdkValue[];
}

export interface MessageAttachment {
	filename: string;
	id: string;
	isImage: boolean;
	mimeType?: string;
	size?: number;
	url?: string;
}

/** A read projection of live/legacy SDK attachment cells, not a file DTO.
 * Every cell stays opaque until the existing text/finite-size observation. */
interface AttachmentObservation {
	contentType?: NativeSdkValue;
	data?: NativeSdkValue;
	fileName?: NativeSdkValue;
	filename?: NativeSdkValue;
	image?: NativeSdkValue;
	mediaType?: NativeSdkValue;
	mimeType?: NativeSdkValue;
	name?: NativeSdkValue;
	size?: NativeSdkValue;
	type?: NativeSdkValue;
	url?: NativeSdkValue;
}
const attachmentObservationSchema =
	z.custom<AttachmentObservation>(isNativeObjectLike);
function isRecord(value: NativeSdkValue): value is AttachmentObservation {
	return nativeSdkSchemaAdmits(attachmentObservationSchema, value);
}
/** Old SDK messages can carry this optional opaque side slot. Callable SDK
 * receivers remain admissible; unrelated message fields are never examined. */
interface LegacyAttachmentObservation {
	experimental_attachments?: NativeSdkValue;
}
const legacyAttachmentObservationSchema =
	z.custom<LegacyAttachmentObservation>(isNativeObject);

function stringValue(value: NativeSdkValue): string | undefined {
	return isNativeText(value) && value.length > 0 ? value : undefined;
}

function finiteSize(value: NativeSdkValue): number | undefined {
	return isNativeNumber(value) && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function extensionForMimeType(mimeType: string | undefined): string {
	const subtype = mimeType?.split("/")[1]?.split(";")[0]?.split("+")[0];
	if (!subtype) {
		return "bin";
	}
	if (subtype === "jpeg") {
		return "jpg";
	}
	if (subtype === "svg+xml") {
		return "svg";
	}
	return subtype.replace(/[^a-z0-9]/gi, "") || "bin";
}

function fallbackFilename(
	mimeType: string | undefined,
	isImage: boolean,
	index: number
): string {
	if (isImage) {
		return `image-${index + 1}.${extensionForMimeType(mimeType)}`;
	}
	return "Attachment";
}

function toDataUrl(value: string | undefined, mimeType: string | undefined) {
	if (!value) {
		return undefined;
	}
	const candidate =
		/^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith("//")
			? value
			: mimeType
				? `data:${mimeType};base64,${value}`
				: value;
	return safeMediaUrl(candidate) ?? undefined;
}

function attachmentFromRecord(
	record: AttachmentObservation,
	id: string,
	index: number
): MessageAttachment | null {
	const type = stringValue(record.type);
	const mimeType =
		stringValue(record.mediaType) ??
		stringValue(record.mimeType) ??
		stringValue(record.contentType);

	if (type === "image") {
		const url = toDataUrl(
			stringValue(record.url) ??
				stringValue(record.image) ??
				stringValue(record.data),
			mimeType ?? "image/*"
		);
		return {
			filename:
				stringValue(record.filename) ??
				stringValue(record.fileName) ??
				stringValue(record.name) ??
				fallbackFilename(mimeType, true, index),
			id,
			isImage: true,
			mimeType,
			size: finiteSize(record.size),
			url,
		};
	}

	if (type === "data-image") {
		const nested = isRecord(record.data) ? record.data : record;
		const nestedMimeType =
			stringValue(nested.mimeType) ?? stringValue(nested.mediaType) ?? mimeType;
		const url = toDataUrl(
			stringValue(nested.url) ?? stringValue(nested.data),
			nestedMimeType ?? "image/*"
		);
		return {
			filename:
				stringValue(record.filename) ??
				stringValue(record.fileName) ??
				stringValue(record.name) ??
				fallbackFilename(nestedMimeType, true, index),
			id,
			isImage: true,
			mimeType: nestedMimeType,
			size: finiteSize(record.size),
			url,
		};
	}

	if (type !== "file") {
		return null;
	}

	const isImage = mimeType?.startsWith("image/") ?? false;
	return {
		filename:
			stringValue(record.filename) ??
			stringValue(record.fileName) ??
			stringValue(record.name) ??
			fallbackFilename(mimeType, isImage, index),
		id,
		isImage,
		mimeType,
		size: finiteSize(record.size),
		url: toDataUrl(
			stringValue(record.url) ?? stringValue(record.data),
			mimeType
		),
	};
}

function attachmentFromExperimental(
	value: NativeSdkValue,
	id: string,
	index: number
): MessageAttachment | null {
	if (!isRecord(value)) {
		return null;
	}
	const mimeType =
		stringValue(value.contentType) ??
		stringValue(value.mimeType) ??
		stringValue(value.mediaType);
	const isImage = mimeType?.startsWith("image/") ?? false;
	return {
		filename:
			stringValue(value.filename) ??
			stringValue(value.fileName) ??
			stringValue(value.name) ??
			fallbackFilename(mimeType, isImage, index),
		id,
		isImage,
		mimeType,
		size: finiteSize(value.size),
		url: toDataUrl(stringValue(value.url), mimeType),
	};
}

/** Normalize every attachment shape used by persisted and streamed messages. */
export function getMessageAttachments(
	message: AttachmentMessageInput
): MessageAttachment[] {
	const attachments: MessageAttachment[] = [];
	const seen = new Set<string>();

	const push = (attachment: MessageAttachment | null) => {
		if (!attachment) {
			return;
		}
		const dedupeKey = `${attachment.filename}:${attachment.url ?? ""}:${attachment.mimeType ?? ""}`;
		if (seen.has(dedupeKey)) {
			return;
		}
		seen.add(dedupeKey);
		attachments.push(attachment);
	};

	for (const [index, part] of (message.parts ?? []).entries()) {
		push(
			attachmentFromRecord(
				isRecord(part) ? part : {},
				`${message.id}-part-${index}`,
				index
			)
		);
	}

	const rawExperimental = nativeSdkSchemaAdmits(
		legacyAttachmentObservationSchema,
		message
	)
		? message.experimental_attachments
		: undefined;
	if (Array.isArray(rawExperimental)) {
		for (const [index, attachment] of rawExperimental.entries()) {
			push(
				attachmentFromExperimental(
					attachment,
					`${message.id}-experimental-${index}`,
					index
				)
			);
		}
	}

	return attachments;
}
