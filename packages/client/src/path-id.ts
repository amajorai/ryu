/**
 * A path id the service would resolve onto another route: `""`, `"."` or
 * `".."` (`DELETE /v1/boxes/b/previews/..` is `DELETE /v1/boxes/b`). Raised
 * before any request, with the `code` and `status` Messaging and Managed
 * Agents use for the same refusal.
 */
export class RyuPathIdError extends Error {
	readonly code = "invalid_id";
	readonly status = 0;

	constructor(service: string) {
		super(
			`Ryu ${service}: a path id must be a non-empty id other than "." or "..".`
		);
		this.name = "RyuPathIdError";
	}
}

/** Whether `value` is an empty, `.` or `..` path id. */
export function isUnsafePathId(value: string): boolean {
	return value === "" || value === "." || value === "..";
}

/** Encodes one path id, refusing `""`, `"."` and `".."` with {@link RyuPathIdError}. */
export function encodePathId(service: string, value: string): string {
	if (isUnsafePathId(value)) {
		throw new RyuPathIdError(service);
	}
	return encodeURIComponent(value);
}

const LEADING_SEPARATOR = /^[/\\]/u;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/iu;
/** The WHATWG URL parser (what `fetch` uses) separates path segments on both. */
const PATH_SEPARATOR = /[/\\]/u;
/** The URL parser drops these anywhere in a URL. */
const STRIPPED_CHARACTERS = /[\t\n\r]/gu;

/** Trims C0 controls and spaces, which the URL parser trims from the ends of a URL. */
function trimUrlEdges(part: string): string {
	let start = 0;
	let end = part.length;
	while (start < end && part.charCodeAt(start) <= 0x20) {
		start += 1;
	}
	while (end > start && part.charCodeAt(end - 1) <= 0x20) {
		end -= 1;
	}
	return part.slice(start, end);
}

/**
 * Refuses a whole request path (`/v1/boxes/b/previews/t?x=1`) with an empty,
 * `.` or `..` segment before any request, with {@link RyuPathIdError}. The
 * transport runs it on every path, so an id that reaches a path without
 * {@link encodePathId} is refused too. Segments are read the way the URL
 * parser reads them: `\` separates, tab/CR/LF vanish, and `%2e` is a dot.
 */
export function assertSafeRequestPath(service: string, path: string): void {
	if (!isSafeRequestPath(path)) {
		throw new RyuPathIdError(service);
	}
}

/**
 * Whether no segment of `path` is empty, `.` or `..`; see {@link assertSafeRequestPath}.
 * `path` is the request path relative to the origin (`/v1/boxes/b?x=1`), not a
 * full URL: the `//` after a scheme reads as an empty segment, and so does a
 * trailing slash (`/v1/boxes/` is refused).
 */
export function isSafeRequestPath(path: string): boolean {
	const segments = (path.split(/[?#]/u, 1)[0] ?? "")
		.replace(STRIPPED_CHARACTERS, "")
		.replace(LEADING_SEPARATOR, "")
		.split(PATH_SEPARATOR)
		.map(trimUrlEdges);
	return !segments.some((part) => part === "" || DOT_SEGMENT.test(part));
}
