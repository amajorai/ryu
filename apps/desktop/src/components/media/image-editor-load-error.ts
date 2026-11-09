import { formatMessage, type LiteralMessage } from "@ryu/i18n";

/**
 * Why an image could not be opened in the editor. These are the English
 * catalog sources; the error keeps the source and its values so the dialog
 * can translate the whole sentence instead of showing the formatted English.
 */
export const EDITABLE_IMAGE_ERRORS = {
	unsafeUrl: "This image URL is not safe to open in the editor.",
	status: "Could not load this image ({status}).",
	unsupportedType: "The editor supports PNG, JPEG, WebP, AVIF, and GIF images.",
	tooLarge: "This image is larger than the 32 MB editor limit.",
	noBody: "The image response did not include a readable body.",
} as const;

type EditableImageErrorSource =
	(typeof EDITABLE_IMAGE_ERRORS)[keyof typeof EDITABLE_IMAGE_ERRORS];

/** A load refusal whose message is a catalog source plus its values. */
export class EditableImageError extends Error {
	readonly source: EditableImageErrorSource;
	readonly values: Record<string, string | number>;

	constructor(
		source: EditableImageErrorSource,
		values: Record<string, string | number> = {}
	) {
		super(formatMessage(source, values));
		this.name = "EditableImageError";
		this.source = source;
		this.values = values;
	}
}

/**
 * The text to show when opening an image fails, in the UI language.
 *
 * Known refusals are translated: an `EditableImageError` by its source, and a
 * plain `Error` the editor threw itself (its message is a catalog source, or
 * was already translated, which the translator passes through). A browser
 * error (a fetch `TypeError`, a decode `DOMException`) carries the browser's
 * own English, so it becomes the translated fallback sentence instead.
 */
export function imageLoadErrorText(tl: LiteralMessage, error: unknown): string {
	if (error instanceof EditableImageError) {
		// Label tables skip sources with placeholders, so the status sentence is
		// spelled out here as a literal the extractor reads.
		if (error.source === EDITABLE_IMAGE_ERRORS.status) {
			return tl("Could not load this image ({status}).", error.values);
		}
		return tl(error.source, error.values);
	}
	if (
		error instanceof Error &&
		Object.getPrototypeOf(error) === Error.prototype &&
		error.message
	) {
		return tl(error.message);
	}
	return tl("Could not open this image in the editor.");
}
