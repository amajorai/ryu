// apps/mcp/src/tool-path-id.ts
//
// An id that an MCP host's model writes into a tool call becomes one segment of
// a Core path that is fetched with the node token. An id that carries a path
// character could aim that request at another Core route, outside the tool
// list this server offers, so it is refused before any request is built.
//
// This is a local copy of `isSafePathId` in packages/app-host/src/frame-rpc.ts
// (the rule for quest ids that come from an app frame). It is copied, not
// imported, because this package does not depend on @ryuhq/app-host. Keep the
// two in step.

const PATH_CHARACTERS: ReadonlySet<string> = new Set([
	"/",
	"\\",
	"?",
	"#",
	"%",
]);
const SPACE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * True when an id can sit in a Core path as one segment for every HTTP client:
 * no path, query, fragment or escape character, no dot segment, and no space or
 * control character (URL parsers drop tab, CR and LF, so `.<TAB>.` reads `..`).
 */
export function isSafePathId(id: string): boolean {
	if (id === "" || id === "." || id === "..") {
		return false;
	}
	for (const character of id) {
		const code = character.codePointAt(0) ?? 0;
		if (
			code <= SPACE_CODE ||
			code === DELETE_CODE ||
			PATH_CHARACTERS.has(character)
		) {
			return false;
		}
	}
	return true;
}

/**
 * Return `id` when it is a safe path segment, otherwise throw. `tool` and
 * `argument` name the tool call in the error the MCP host reads.
 */
export function requirePathId(
	tool: string,
	argument: string,
	id: string
): string {
	if (!isSafePathId(id)) {
		throw new Error(
			`${tool} requires ${argument} without path characters (no "/", "\\", "?", "#", "%", space or control character, and not "." or "..")`
		);
	}
	return id;
}
