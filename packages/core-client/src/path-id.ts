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
