/** Targets supported by the workspace file tree's default Open action. */
export const DEFAULT_FILE_OPENER_VALUES = [
	"system",
	"vscode",
	"cursor",
	"zed",
] as const;

export type DefaultFileOpener = (typeof DEFAULT_FILE_OPENER_VALUES)[number];

export function isDefaultFileOpener(value: string): value is DefaultFileOpener {
	// SAFETY: The assertion changes only the declared includes search parameter.
	// Native includes compares this original string with the four authored opener
	// literals; its boolean result establishes the domain, without coercing the
	// search value or treating it as an opener before the comparison.
	return DEFAULT_FILE_OPENER_VALUES.includes(value as DefaultFileOpener);
}

export function normalizeDefaultFileOpener(
	value: string | null
): DefaultFileOpener {
	return value && isDefaultFileOpener(value) ? value : "system";
}
