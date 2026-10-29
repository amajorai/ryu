import { z } from "zod";

const navigationTextSchema = z.string();

/** Return a normalized URL only when it uses an explicitly allowed web scheme. */
export function safeHttpUrl(
	value: Parameters<typeof navigationTextSchema.safeParse>[0]
): string | null {
	const parsed = navigationTextSchema.safeParse(value);
	if (!(parsed.success && parsed.data.trim())) {
		return null;
	}
	try {
		const url = new URL(parsed.data.trim());
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

/** Allow a same-origin path/fragment or an explicitly web URL for navigation. */
export function safeNavigationUrl(
	value: Parameters<typeof navigationTextSchema.safeParse>[0]
): string | null {
	const parsed = navigationTextSchema.safeParse(value);
	if (!(parsed.success && parsed.data.trim())) {
		return null;
	}
	const trimmed = parsed.data.trim();
	const hasControlCharacter = Array.from(trimmed).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || codePoint === 0x7f;
	});
	if (hasControlCharacter || trimmed.includes("\\")) {
		return null;
	}
	if (trimmed.startsWith("#")) {
		return trimmed;
	}
	if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
		return trimmed;
	}
	return safeHttpUrl(trimmed);
}
