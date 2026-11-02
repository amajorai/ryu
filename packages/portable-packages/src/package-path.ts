/**
 * Host-independent rules for a portable package file path. Core enforces the
 * same rules when it extracts a `.ryupack` (`apps/core/src/portable_packages/
 * archive.rs`), so publish preflight refuses what a node would refuse.
 *
 * `:` introduces a Windows drive prefix (`C:`) or an NTFS alternate data
 * stream, and Windows treats device names such as `CON` or `nul.txt` as
 * devices, so those are rejected on every platform.
 */
const WINDOWS_FORBIDDEN_CHARS = /[:<>"|?*]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_RESERVED_NAMES = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
	...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function isPortableComponent(part: string): boolean {
	if (part === "" || part === "." || part === "..") {
		return false;
	}
	if (WINDOWS_FORBIDDEN_CHARS.test(part) || CONTROL_CHARS.test(part)) {
		return false;
	}
	const stem = (part.split(".")[0] ?? part).trimEnd().toUpperCase();
	return !WINDOWS_RESERVED_NAMES.has(stem);
}

/** Whether an already `/`-normalised package path is safe on every host. */
export function isPortablePackagePath(normalized: string): boolean {
	return (
		normalized !== "" &&
		!normalized.startsWith("/") &&
		normalized.split("/").every(isPortableComponent)
	);
}
