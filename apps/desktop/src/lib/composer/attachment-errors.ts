// apps/desktop/src/lib/composer/attachment-errors.ts
//
// Why a composer could not read a text attachment, as a code plus values. The
// reader (`readTextAttachment`) runs outside React and has no translator, so it
// throws an `AttachmentError`; the composer turns it into a whole translated
// sentence with the size in the user's number format through
// `attachmentErrorMessage`. The error's own `message` is the code, so nothing
// English leaks into a toast if a caller ever shows it raw.

import { formatByteSize } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";

/** What went wrong reading a text attachment. */
export type AttachmentErrorCode = "too-large" | "not-text";

export interface AttachmentErrorValues {
	/** The size cap, for `too-large`. */
	readonly maxBytes?: number;
	/** The file's name, as the user picked it. */
	readonly name: string;
}

/** A coded failure to read a text attachment; render it with {@link attachmentErrorMessage}. */
export class AttachmentError extends Error {
	readonly code: AttachmentErrorCode;
	readonly values: AttachmentErrorValues;

	constructor(code: AttachmentErrorCode, values: AttachmentErrorValues) {
		super(code);
		this.name = "AttachmentError";
		this.code = code;
		this.values = values;
	}
}

/** The file is bigger than the composer inlines. */
export function attachmentTooLarge(
	name: string,
	maxBytes: number
): AttachmentError {
	return new AttachmentError("too-large", { name, maxBytes });
}

/** The file's head is not NUL-free UTF-8. */
export function attachmentNotText(name: string): AttachmentError {
	return new AttachmentError("not-text", { name });
}

/**
 * The toast description for a failed attachment read: a coded error becomes a
 * whole translated sentence, another `Error` keeps its message, and anything
 * else says the file could not be read.
 */
export function attachmentErrorMessage(
	err: unknown,
	name: string,
	tl: LiteralMessage
): string {
	if (err instanceof AttachmentError) {
		if (err.code === "too-large") {
			return tl("{name} is too large to attach (max {size}).", {
				name: err.values.name,
				size: formatByteSize(err.values.maxBytes ?? 0, undefined, {
					trimZeros: true,
				}),
			});
		}
		return tl("{name} doesn't look like a text file.", {
			name: err.values.name,
		});
	}
	return err instanceof Error
		? err.message
		: tl("Could not read {name}", { name });
}

/** The constructors and renderer `attachments.ts` uses, under one import. */
export const attachmentErrors = {
	message: attachmentErrorMessage,
	notText: attachmentNotText,
	tooLarge: attachmentTooLarge,
} as const;
