// Pure rules for the transcript file card: which name a download may suggest,
// what the type badge reads, which files preview inline, and how large a data
// URL's payload is. No React and no package imports, so every rule is unit
// tested on its own.

/** Longest download name the card suggests (most file systems allow 255). */
export const MAX_DOWNLOAD_NAME_LENGTH = 120;
/** Name used when nothing safe is left of the agent's title. */
export const FALLBACK_DOWNLOAD_NAME = "download";

const PATH_SEPARATORS = /[\\/]/u;
// Characters Windows refuses in a file name; the same set is harmless to drop
// on macOS and Linux.
const RESERVED_CHARACTERS = /[<>:"|?*]/gu;
const WHITESPACE_RUN = /\s+/gu;
const LEADING_DOTS = /^[.\s]+/u;
const TRAILING_DOTS = /[.\s]+$/u;
// Device names Windows resolves in any folder, with or without an extension.
// COM and LPT also count with a superscript one, two or three (U+00B9, U+00B2,
// U+00B3) in place of the digit, and the console has the two names CONIN$ and
// CONOUT$.
const WINDOWS_DEVICE_NAME =
	/^(?:con|prn|aux|nul|(?:com|lpt)[\d\u00B2\u00B3\u00B9]|conin\$|conout\$)(?:\.|$)/iu;
// Characters that draw nothing. The Unicode format class holds the zero width
// characters and direction marks (U+200B to U+200F), the word joiner and the
// invisible operators (U+2060 to U+2064), the Arabic letter mark (U+061C), the
// soft hyphen and the byte order mark. The fillers are blank letters and
// symbols outside that class: the Braille blank (U+2800) and the Hangul
// fillers (U+3164, U+115F, U+1160, U+FFA0). A run of them can push the real
// ending of a name out of sight in a save dialog.
const INVISIBLE_CHARACTERS = /[\p{Cf}\u115F\u1160\u2800\u3164\uFFA0]/gu;
// The first half of a character outside the basic plane, left alone by a cut.
const LONE_FIRST_HALF_AT_END = /[\uD800-\uDBFF]$/u;
const EXTENSION = /\.([a-z0-9]{1,10})$/iu;
const BASE64_PADDING = /=+$/u;

const MIME_EXTENSION: Record<string, string> = {
	"application/gzip": "gz",
	"application/json": "json",
	"application/msword": "doc",
	"application/pdf": "pdf",
	"application/vnd.ms-excel": "xls",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"pptx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"docx",
	"application/xml": "xml",
	"application/zip": "zip",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/svg+xml": "svg",
	"image/webp": "webp",
	"text/css": "css",
	"text/csv": "csv",
	"text/html": "html",
	"text/javascript": "js",
	"text/markdown": "md",
	"text/plain": "txt",
	"video/mp4": "mp4",
};

/** Raster formats an `<img>` paints without running any script. */
const INLINE_IMAGE_MIMES = new Set([
	"image/avif",
	"image/bmp",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);
/** The same formats by the ending of a name, with the type each decodes as. */
const INLINE_IMAGE_EXTENSION_MIME: Record<string, string> = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
};
const TEXT_EXTENSIONS = new Set([
	"css",
	"csv",
	"html",
	"js",
	"json",
	"md",
	"py",
	"rs",
	"ts",
	"tsx",
	"txt",
	"xml",
	"yaml",
	"yml",
]);

/** The MIME type without parameters, lower case ("text/csv; charset=utf-8"). */
export function baseMime(mime: string | null | undefined): string {
	return mime?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Lower-case extension of a file name, without the dot; "" when none. */
export function fileExtension(name: string | null | undefined): string {
	return EXTENSION.exec(name?.trim() ?? "")?.[1]?.toLowerCase() ?? "";
}

/** The extension a MIME type is saved with; "" when the type is not known. */
export function extensionForMime(mime: string | null | undefined): string {
	// Own keys only: the agent chooses the type, and "constructor" is a member
	// of every object.
	const type = baseMime(mime);
	if (!Object.hasOwn(MIME_EXTENSION, type)) {
		return "";
	}
	return MIME_EXTENSION[type] ?? "";
}

/** `value` without the characters a save dialog does not draw. */
function withoutUnseenCharacters(value: string): string {
	let out = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		// C0 controls, DEL, C1 controls, and the bidi overrides that can make
		// "exe.pdf" read as "fdp.exe" in a save dialog.
		const control =
			code < 32 ||
			(code >= 127 && code <= 159) ||
			(code >= 0x20_2a && code <= 0x20_2e) ||
			(code >= 0x20_66 && code <= 0x20_69);
		if (!control) {
			out += character;
		}
	}
	return out.replace(INVISIBLE_CHARACTERS, "");
}

/**
 * The file name a download suggests to the browser. The agent chooses the
 * title, so it is reduced to a bare name first: only the last path segment,
 * no drive letter or reserved character, no control, bidi override or
 * invisible character, no leading dot (hidden file), no trailing dot or space,
 * no Windows device name, and a bounded length. The folder is never part of it:
 * the browser or the desktop web view decides where the file goes.
 */
export function safeDownloadName(
	name: string | null | undefined,
	mime?: string | null
): string {
	const lastSegment =
		withoutUnseenCharacters(name ?? "")
			.split(PATH_SEPARATORS)
			.at(-1) ?? "";
	let safe = lastSegment
		.replace(RESERVED_CHARACTERS, "")
		.replace(WHITESPACE_RUN, " ")
		.replace(LEADING_DOTS, "")
		.replace(TRAILING_DOTS, "");
	if (WINDOWS_DEVICE_NAME.test(safe)) {
		safe = `_${safe}`;
	}
	const extension = fileExtension(safe);
	if (!safe) {
		safe = FALLBACK_DOWNLOAD_NAME;
	}
	const mimeExtension = extensionForMime(mime);
	if (!extension && mimeExtension) {
		safe = `${safe}.${mimeExtension}`;
	}
	if (safe.length <= MAX_DOWNLOAD_NAME_LENGTH) {
		return safe;
	}
	// Keep the extension when the name has to be cut.
	const kept = fileExtension(safe);
	const tail = kept ? `.${kept}` : "";
	// The limit counts UTF-16 units, so a cut can land inside a character
	// outside the basic plane; its lone first half is dropped.
	const stem = safe
		.slice(0, MAX_DOWNLOAD_NAME_LENGTH - tail.length)
		.replace(LONE_FIRST_HALF_AT_END, "");
	return `${stem.replace(TRAILING_DOTS, "")}${tail}`;
}

/**
 * The short type badge: the upper-case extension ("PDF", "DOCX"), taken from
 * the name, else from the MIME type. `null` means the caller shows its own
 * translated word for a plain file.
 */
export function fileTypeBadge(
	name: string | null | undefined,
	mime?: string | null
): string | null {
	const extension = fileExtension(name) || extensionForMime(mime);
	return extension ? extension.toUpperCase() : null;
}

export type FilePreviewKind = "image" | "pdf";

/**
 * The raster type an inline image preview is decoded as: the card's own type,
 * else the type of the name's ending when the card has no type. "" when the
 * file gets no image preview. The preview gives its bytes this type, never the
 * type they arrived with.
 */
export function previewImageMime(
	name: string | null | undefined,
	mime?: string | null
): string {
	const type = baseMime(mime);
	if (type) {
		return INLINE_IMAGE_MIMES.has(type) ? type : "";
	}
	const extension = fileExtension(name);
	if (!Object.hasOwn(INLINE_IMAGE_EXTENSION_MIME, extension)) {
		return "";
	}
	return INLINE_IMAGE_EXTENSION_MIME[extension] ?? "";
}

/**
 * Which inline preview a file gets. Only formats that paint without running
 * code: raster images and PDF. SVG and HTML are left to the sandboxed
 * artifact frame, and office files keep the card with Download and Open.
 */
export function filePreviewKind(
	name: string | null | undefined,
	mime?: string | null
): FilePreviewKind | null {
	const type = baseMime(mime);
	const extension = fileExtension(name);
	if (type === "application/pdf" || (!type && extension === "pdf")) {
		return "pdf";
	}
	return previewImageMime(name, mime) ? "image" : null;
}

/** True when the bytes read as text a side panel can show. */
export function isTextLikeFile(
	name: string | null | undefined,
	mime?: string | null
): boolean {
	const type = baseMime(mime);
	if (type) {
		return (
			type.startsWith("text/") ||
			type === "application/json" ||
			type === "application/xml" ||
			type.endsWith("+json") ||
			type.endsWith("+xml")
		);
	}
	return TEXT_EXTENSIONS.has(fileExtension(name));
}

/**
 * Payload size of a `data:` URL in bytes, or `undefined` for any other URL.
 * Core sends inline attachments as base64 data URLs without a size field.
 */
export function dataUrlByteSize(url: string): number | undefined {
	if (!url.startsWith("data:")) {
		return;
	}
	const comma = url.indexOf(",");
	if (comma === -1) {
		return;
	}
	const header = url.slice(0, comma);
	const payload = url.slice(comma + 1);
	if (!header.endsWith(";base64")) {
		try {
			return new TextEncoder().encode(decodeURIComponent(payload)).length;
		} catch {
			return;
		}
	}
	const unpadded = payload.replace(BASE64_PADDING, "");
	return Math.floor((unpadded.length * 3) / 4);
}
