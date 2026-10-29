import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";

/**
 * A loadable image URL for an agent's avatar, for hosts that cannot rasterize
 * one themselves (the extension's background worker has no DOM). Same rules as
 * Core's push (`apps/core/src/notify/run_push.rs`) and the mobile app
 * (`apps/native/lib/notification-avatar-plan.ts`): uploaded image, DiceBear,
 * emoji (Twemoji), then the agent's initial on its avatar colour. Only the
 * first letter is sent to the initials service.
 */
export interface AvatarUrlSource {
	avatarGlyph?: GlyphValue | null;
	avatarUrl?: string | null;
	id: string;
	name: string;
}

const DICEBEAR_BASE = "https://api.dicebear.com/9.x";
const TWEMOJI_BASE =
	"https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";
const DICEBEAR_STYLE_RE = /^[a-z][a-z-]{0,39}$/u;
const HEX_COLOR_RE = /^#([0-9a-f]{6})$/iu;
const AVATAR_SIZE = "192";
const MONOGRAM_COLORS = [
	"ef4444",
	"f97316",
	"f59e0b",
	"22c55e",
	"14b8a6",
	"3b82f6",
	"6366f1",
	"a855f7",
	"ec4899",
] as const;
const DITHER_HEX: Record<string, string> = {
	green: "28d26e",
	blue: "358ff3",
	purple: "966eff",
	pink: "f05abe",
	orange: "ff9632",
	red: "f04646",
	grey: "5c5c64",
};

export function twemojiCode(emoji: string): string | null {
	const points = Array.from(emoji.trim(), (char) => char.codePointAt(0) ?? 0);
	if (points.length === 0 || points.length > 16) {
		return null;
	}
	const zwj = points.includes(0x20_0d);
	return points
		.filter((point) => zwj || point !== 0xfe_0f)
		.map((point) => point.toString(16))
		.join("-");
}

function monogramColor(seed: string): string {
	let hash = 0;
	for (const char of seed) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
	}
	return MONOGRAM_COLORS[hash % MONOGRAM_COLORS.length] ?? MONOGRAM_COLORS[0];
}

function initialsUrl(source: AvatarUrlSource, glyph: GlyphValue): string {
	const iconColor =
		glyph?.kind === "icon" && glyph.color
			? HEX_COLOR_RE.exec(glyph.color)?.[1]?.toLowerCase()
			: undefined;
	const dither =
		glyph && "dither" in glyph && glyph.dither
			? DITHER_HEX[glyph.dither.from]
			: undefined;
	const params = new URLSearchParams({
		seed: Array.from(source.name.trim())[0]?.toUpperCase() ?? "R",
		size: AVATAR_SIZE,
		backgroundColor:
			iconColor ?? dither ?? monogramColor(source.id || source.name),
	});
	return `${DICEBEAR_BASE}/initials/png?${params}`;
}

export function agentAvatarUrl(source: AvatarUrlSource): string {
	const glyph: GlyphValue =
		source.avatarGlyph ??
		(source.avatarUrl ? { kind: "avatar", dataUrl: source.avatarUrl } : null);
	if (glyph?.kind === "avatar") {
		const url = safeMediaUrl(glyph.dataUrl);
		if (url && (url.startsWith("data:image/") || url.startsWith("https://"))) {
			return url;
		}
	}
	if (glyph?.kind === "dicebear" && DICEBEAR_STYLE_RE.test(glyph.style)) {
		const params = new URLSearchParams({
			seed: glyph.seed.slice(0, 256) || "ryu",
			size: AVATAR_SIZE,
		});
		return `${DICEBEAR_BASE}/${glyph.style}/png?${params}`;
	}
	if (glyph?.kind === "emoji") {
		const code = twemojiCode(glyph.emoji);
		if (code) {
			return `${TWEMOJI_BASE}/${code}.png`;
		}
	}
	return initialsUrl(source, glyph);
}
