import {
	isDitherColor,
	PALETTE,
	rgb,
} from "@ryu/ui/components/dither-kit/palette.ts";
import {
	dicebearUrl,
	type GlyphValue,
	glyphIconSvgUrl,
} from "@ryu/ui/components/glyph.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";

/**
 * The parts of an agent a notification needs to show who sent it. Matches the
 * fields `AgentSummary` already carries, so callers pass the summary as is.
 */
export interface NotificationSender {
	avatarGlyph?: GlyphValue;
	avatarUrl?: string | null;
	id: string;
	/** Static brand mark for agents without a custom avatar (engine logo). */
	logoSrc?: string | null;
	name: string;
}

/** Square edge, in pixels, of the rendered avatar. Large enough for HiDPI banners. */
export const NOTIFICATION_AVATAR_SIZE = 192;
const IMAGE_LOAD_TIMEOUT_MS = 2500;
const NEUTRAL_BACKGROUND = "#e5e7eb";
const RYU_LOGO_SRC = "/assets/logos/ryu_light.svg";
const MONOGRAM_COLORS = [
	"#ef4444",
	"#f97316",
	"#f59e0b",
	"#22c55e",
	"#14b8a6",
	"#3b82f6",
	"#6366f1",
	"#a855f7",
	"#ec4899",
] as const;

/** What to draw for a sender, before any pixels exist. Pure, so it is unit-tested. */
export type AvatarPlan =
	| { kind: "image"; src: string; background: string | null }
	| { kind: "emoji"; emoji: string; background: string }
	| { kind: "monogram"; letter: string; background: string };

function monogramColor(seed: string): string {
	let hash = 0;
	for (const character of seed) {
		hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
	}
	return MONOGRAM_COLORS[hash % MONOGRAM_COLORS.length] ?? MONOGRAM_COLORS[0];
}

function monogram(sender: NotificationSender): AvatarPlan {
	const letter = Array.from(sender.name.trim())[0]?.toUpperCase() ?? "R";
	return {
		kind: "monogram",
		letter,
		background: monogramColor(sender.id || sender.name),
	};
}

function ditherBackground(glyph: GlyphValue): string | null {
	const from = glyph && "dither" in glyph ? glyph.dither?.from : undefined;
	return isDitherColor(from) ? rgb(PALETTE[from].fill) : null;
}

/**
 * Pick the bitmap source for a sender in the same priority order the chat UI
 * renders avatars (`AgentAvatar`): uploaded image → emoji → icon → DiceBear →
 * engine logo. Animated sources (the expressive ghost, a bare dither) have no
 * still image, so they become a monogram tinted with the avatar's colour.
 */
export function planAgentAvatar(sender: NotificationSender): AvatarPlan {
	const glyph =
		sender.avatarGlyph ??
		(sender.avatarUrl
			? { kind: "avatar" as const, dataUrl: sender.avatarUrl }
			: null);
	switch (glyph?.kind) {
		case "avatar": {
			const src = safeMediaUrl(glyph.dataUrl);
			return src ? { kind: "image", src, background: null } : monogram(sender);
		}
		case "emoji":
			return {
				kind: "emoji",
				emoji: glyph.emoji,
				background: ditherBackground(glyph) ?? NEUTRAL_BACKGROUND,
			};
		case "icon":
			return {
				kind: "image",
				src: glyphIconSvgUrl(glyph.id, {
					color: glyph.color ?? "#111827",
					size: NOTIFICATION_AVATAR_SIZE,
				}),
				background: ditherBackground(glyph) ?? NEUTRAL_BACKGROUND,
			};
		case "dicebear":
			return {
				kind: "image",
				src: dicebearUrl(glyph.style, glyph.seed, {
					size: NOTIFICATION_AVATAR_SIZE,
				}),
				background: NEUTRAL_BACKGROUND,
			};
		case "expressive":
		case "dither": {
			const plan = monogram(sender);
			const tint = ditherBackground(glyph);
			return tint ? { ...plan, background: tint } : plan;
		}
		default:
			return {
				kind: "image",
				src: safeMediaUrl(sender.logoSrc ?? RYU_LOGO_SRC) ?? RYU_LOGO_SRC,
				background: "#ffffff",
			};
	}
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		// Remote avatars (DiceBear, Iconify, https uploads) must be CORS-clean or
		// the canvas taints and `toDataURL` throws; both services send `*`.
		if (!(src.startsWith("data:") || src.startsWith("/"))) {
			image.crossOrigin = "anonymous";
		}
		const timer = setTimeout(
			() => reject(new Error("avatar load timed out")),
			IMAGE_LOAD_TIMEOUT_MS
		);
		image.onload = () => {
			clearTimeout(timer);
			resolve(image);
		};
		image.onerror = () => {
			clearTimeout(timer);
			reject(new Error("avatar failed to load"));
		};
		image.src = src;
	});
}

function circleClip(context: CanvasRenderingContext2D, size: number): void {
	context.beginPath();
	context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
	context.closePath();
	context.clip();
}

async function paint(
	context: CanvasRenderingContext2D,
	plan: AvatarPlan,
	size: number
): Promise<void> {
	circleClip(context, size);
	if (plan.background) {
		context.fillStyle = plan.background;
		context.fillRect(0, 0, size, size);
	}
	if (plan.kind === "image") {
		const image = await loadImage(plan.src);
		// Uploaded photos fill the circle; logos and icons sit inset on their tile.
		const inset = plan.background ? size * 0.18 : 0;
		const edge = size - inset * 2;
		const scale = Math.max(
			edge / (image.naturalWidth || edge),
			edge / (image.naturalHeight || edge)
		);
		const width = (image.naturalWidth || edge) * scale;
		const height = (image.naturalHeight || edge) * scale;
		context.drawImage(
			image,
			(size - width) / 2,
			(size - height) / 2,
			width,
			height
		);
		return;
	}
	context.textAlign = "center";
	context.textBaseline = "middle";
	if (plan.kind === "emoji") {
		context.font = `${Math.round(size * 0.56)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
		context.fillText(plan.emoji, size / 2, size / 2 + size * 0.04);
		return;
	}
	context.fillStyle = "#ffffff";
	context.font = `600 ${Math.round(size * 0.46)}px system-ui,-apple-system,"Segoe UI",sans-serif`;
	context.fillText(plan.letter, size / 2, size / 2 + size * 0.03);
}

async function rasterize(plan: AvatarPlan): Promise<string | null> {
	if (typeof document === "undefined") {
		return null;
	}
	const canvas = document.createElement("canvas");
	canvas.width = NOTIFICATION_AVATAR_SIZE;
	canvas.height = NOTIFICATION_AVATAR_SIZE;
	const context = canvas.getContext("2d");
	if (!context) {
		return null;
	}
	await paint(context, plan, NOTIFICATION_AVATAR_SIZE);
	const dataUrl = canvas.toDataURL("image/png");
	return dataUrl.startsWith("data:image/png") ? dataUrl : null;
}

const cache = new Map<string, Promise<string | null>>();
const CACHE_LIMIT = 64;

function cacheKey(plan: AvatarPlan): string {
	return JSON.stringify(plan);
}

/**
 * Render a sender's avatar as a circular PNG data URL for an OS notification,
 * or `null` when no canvas is available. A remote image that fails to load or
 * taints the canvas degrades to the monogram, so a notification never waits
 * on — or loses — its picture because of the network.
 */
export function agentNotificationImage(
	sender: NotificationSender
): Promise<string | null> {
	const plan = planAgentAvatar(sender);
	const key = cacheKey(plan);
	const hit = cache.get(key);
	if (hit) {
		return hit;
	}
	const pending = rasterize(plan)
		.catch(() =>
			plan.kind === "monogram" ? null : rasterize(monogram(sender))
		)
		.catch(() => null);
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) {
			cache.delete(oldest);
		}
	}
	cache.set(key, pending);
	return pending;
}

export function resetAgentNotificationImageCacheForTests(): void {
	cache.clear();
}
