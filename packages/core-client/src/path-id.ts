// packages/core-client/src/path-id.ts
//
// Record IDs that a companion frame or other untrusted caller supplies end up in
// Core URL paths fetched with the node bearer. Keep each ID inside one path
// segment so a `../`, `?` or `#` in it cannot steer the request onto another
// Core route.

/** Encode an opaque record ID as exactly one URL path segment. */
export function encodePathId(id: string): string {
	// URL parsers normalize these even when encodeURIComponent is used.
	if (id === "." || id === "..") {
		throw new Error("ID cannot be a URL dot segment");
	}
	return encodeURIComponent(id);
}

// URL parsers drop these three before they split the path, so `.<TAB>.` is `..`.
const PARSER_DROPPED_CHARACTERS = /[\t\n\r]/g;
// Query and fragment text is never resolved as path segments.
const PATH_END = /[?#]/;
// HTTP URL parsers read a backslash as a slash.
const SEGMENT_SEPARATOR = /[/\\]/;
// `.` and `..`, also written with `%2e` for either dot.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Refuse a Core path that holds a dot segment. The HTTP client of a runtime may
 * resolve `..` before it sends the request, which would move a call made with
 * the node bearer onto another Core route. A path builder that puts a
 * caller-supplied value into the path still encodes it with
 * {@link encodePathId}; this is the net under all of them.
 */
export function assertNoDotSegment(path: string): void {
	const [pathOnly = ""] = path
		.replace(PARSER_DROPPED_CHARACTERS, "")
		.split(PATH_END, 1);
	for (const segment of pathOnly.split(SEGMENT_SEPARATOR)) {
		if (DOT_SEGMENT.test(segment)) {
			throw new Error("Core path cannot hold a URL dot segment");
		}
	}
}

/**
 * Encode the record ID of an app that Core serves through a mount (quests,
 * meetings, teams) as one path segment, and refuse a separator in it first.
 *
 * {@link encodePathId} is not enough there. Core decodes the path tail of a
 * mount once and matches the decoded path against the routes the app declares,
 * so a slash that left the client as `%2F` is a separator again at Core and
 * the request can match another route of the same app with the same method. A
 * backslash is refused as well, because HTTP URL parsers read it as a slash.
 * The IDs these apps mint hold neither character.
 *
 * A plain word needs no separator to leave the record: the app also serves
 * static routes one segment under its mount (`/recaps` of meetings deletes
 * every recap), and Core prefers a static route to the `:id` route. So the
 * caller passes `routeNames`, the one-segment static paths of the app's
 * manifest (an empty list for a position that has none beside it), and an ID
 * equal to one of them is refused. Core compares these segments byte for
 * byte, so this is plain equality. The list comes from the manifest and is
 * not a rule about the shape of an ID: no ID the apps mint equals a route
 * name, while a shape rule could refuse the IDs of an older version.
 */
export function encodeMountPathId(
	id: string,
	routeNames: readonly string[]
): string {
	if (SEGMENT_SEPARATOR.test(id)) {
		throw new Error("ID cannot hold a path separator");
	}
	if (routeNames.includes(id)) {
		throw new Error("ID cannot be a route name of the app");
	}
	return encodePathId(id);
}
