import type { UIMessage } from "ai";

export interface MessageAttachment {
	filename: string;
	id: string;
	isImage: boolean;
	mimeType?: string;
	size?: number;
	url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteSize(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
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
	if (
		value.startsWith("data:") ||
		value.startsWith("blob:") ||
		value.startsWith("http")
	) {
		return value;
	}
	return mimeType ? `data:${mimeType};base64,${value}` : value;
}

function attachmentFromRecord(
	record: Record<string, unknown>,
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
	value: unknown,
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
export function getMessageAttachments(message: UIMessage): MessageAttachment[] {
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

	const rawExperimental = (message as { experimental_attachments?: unknown })
		.experimental_attachments;
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
