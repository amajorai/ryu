// Values such as URLs, email addresses, phone numbers, secrets, paths and
// commands are written left to right in every locale. Under a right-to-left
// interface an input without an explicit direction would run them right to
// left, so a path like `~/.ssh/id_ed25519` reads scrambled. Free-text fields
// get `dir="auto"` instead, so each value takes the direction of its first
// strong character (Arabic prose stays right to left, a Latin path does not).

export type InputDirection = "ltr" | "auto";

const LEFT_TO_RIGHT_TYPES: ReadonlySet<string> = new Set([
	"email",
	"password",
	"tel",
	"url",
]);

const LEFT_TO_RIGHT_VARIANTS: ReadonlySet<string> = new Set([
	"code",
	"code-caption",
	"verification-code",
]);

export function defaultInputDir({
	type,
	variant,
}: {
	type?: string | null;
	variant?: string | null;
}): InputDirection {
	if (type && LEFT_TO_RIGHT_TYPES.has(type.toLowerCase())) {
		return "ltr";
	}
	if (variant && LEFT_TO_RIGHT_VARIANTS.has(variant)) {
		return "ltr";
	}
	return "auto";
}
