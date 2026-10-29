import { z } from "zod";

/**
 * Accept same-site paths, HTTP(S) resources, and browser-created blob URLs.
 * Safe image/audio/video data URLs are supported for locally generated
 * attachments. Reject scriptable/file/custom schemes before binding a media
 * value to an href, src, or iframe.
 */
export const safeMediaUrlSchema = z
	.string()
	.transform((value): string | null => {
		const trimmed = value.trim();
		const hasControlCharacter = Array.from(trimmed).some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 0x20 || codePoint === 0x7f;
		});
		if (!trimmed || hasControlCharacter || trimmed.includes("\\")) {
			return null;
		}
		if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
			return trimmed;
		}
		if (
			/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+);/iu.test(
				trimmed
			)
		) {
			return trimmed;
		}
		try {
			const url = new URL(trimmed);
			return ["http:", "https:", "blob:"].includes(url.protocol)
				? url.href
				: null;
		} catch {
			return null;
		}
	});

/** Native SDKs may supply Blob objects; only validated URL strings render. */
export function safeMediaUrl(
	value: Parameters<typeof safeMediaUrlSchema.safeParse>[0]
): string | null {
	const parsed = safeMediaUrlSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
