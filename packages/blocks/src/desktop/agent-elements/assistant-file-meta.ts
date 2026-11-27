// Which assistant `file` parts draw as a file card, and with what name, type,
// size and URL.
//
// `getAssistantFileMeta` admits only URLs that are safe to bind to an `href`
// or a `src`, so it refuses a `data:` URL of a document type (a PDF, a
// spreadsheet, a zip). The file card never binds its URL to the page: it
// decodes the bytes and hands them to the browser as a download. So a base64
// `data:` URL of any type that is not an image, a video or an audio clip is
// admitted here as well.

import { z } from "zod";
import { baseMime } from "./file-card-logic.ts";
import {
	getAssistantFileMeta,
	nativeSdkNumber,
} from "./utils/live-file-media.ts";
import { nativeSdkSchemaAdmits } from "./utils/native-sdk-admission.ts";
import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "./utils/native-sdk-observation.ts";

export interface AssistantFileMeta {
	filename: string;
	media: string;
	size?: number;
	url: string;
}

/** Name shown when the part carries none (the same word the chip used). */
const UNNAMED_FILE = "Attachment";

/** A base64 `data:` URL with a plain `type/subtype` and nothing after the payload. */
const BASE64_DATA_URL =
	/^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+=-]+)*;base64,[A-Za-z0-9+/]*={0,2}$/u;

interface FilePartObservation {
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
const filePartObservation = z.custom<FilePartObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
const textSchema = z.string();

function textOf(value: NativeSdkValue): string | undefined {
	return nativeSdkSchemaAdmits(textSchema, value) && value ? value : undefined;
}

/** True for the types the transcript already draws with a player or a viewer. */
function isInlineMedia(media: string): boolean {
	return (
		media.startsWith("image/") ||
		media.startsWith("video/") ||
		media.startsWith("audio/")
	);
}

/**
 * The file card's view of an assistant `file` part, or `null` when the part is
 * not a file, is inline media, or carries no usable URL.
 */
export function assistantFileCardMeta(
	rawPart: NativeSdkValue
): AssistantFileMeta | null {
	const safe = getAssistantFileMeta(rawPart);
	if (safe) {
		return safe;
	}
	const observed = filePartObservation.safeParse(rawPart);
	if (!observed.success || observed.data.type !== "file") {
		return null;
	}
	const part = observed.data;
	const media = baseMime(textOf(part.mediaType) ?? textOf(part.mimeType));
	if (!media || isInlineMedia(media)) {
		return null;
	}
	const data = textOf(part.data);
	const url =
		textOf(part.url) ?? (data ? `data:${media};base64,${data}` : undefined);
	if (!(url && BASE64_DATA_URL.test(url))) {
		return null;
	}
	return {
		filename:
			textOf(part.filename) ??
			textOf(part.fileName) ??
			textOf(part.name) ??
			UNNAMED_FILE,
		media,
		size: nativeSdkNumber(part.size) ? part.size : undefined,
		url,
	};
}
