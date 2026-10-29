/**
 * Shared glyph value model for entity icons / avatars across the product
 * (agents, project folders, spaces, pages, meetings, …).
 *
 * The canonical kinds are `avatar` | `icon` | `emoji` | `dicebear`. Agents also
 * allow the `expressive` ghost avatar, marketplace `avatar_style` looks (see
 * avatar-parts.ts), and the legacy `dither` gradient. Hosts pick
 * an allowlist via
 * {@link GLYPH_PRESETS} so every surface offers the same options consistently.
 */

import type { GradientDirection } from "@ryu/ui/components/dither-kit/gradient.tsx";
import {
	type DitherColor,
	isDitherColor,
} from "@ryu/ui/components/dither-kit/palette.ts";
import { z } from "zod";
import {
	isNativeObjectLike,
	isNativeObjectReceiver,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import { isContributedPartId } from "./avatar-parts.ts";
import { type GhostAvatarSpec, parseGhostAvatar } from "./ghost-avatar.ts";

/** Every glyph kind the primitive understands. */
export type GlyphKind =
	| "avatar"
	| "icon"
	| "emoji"
	| "dicebear"
	| "expressive"
	| "avatar_style"
	| "dither";

/** Dither-gradient payload (agent-only / legacy). */
export interface GlyphDitherValue {
	direction: GradientDirection;
	from: DitherColor;
	/** Second palette colour, or null for a fade to transparent. */
	to: DitherColor | null;
}

/**
 * Discriminated glyph value. Primary kinds are mutually exclusive. Icons and
 * emojis may optionally carry a {@link GlyphDitherValue} as a background layer
 * (DiceBear and uploaded avatars do not mix with dither). `null` means "no
 * custom glyph; use the surface fallback".
 */
export type GlyphValue =
	| { kind: "avatar"; dataUrl: string }
	| { kind: "icon"; id: string; color?: string; dither?: GlyphDitherValue }
	| { kind: "emoji"; emoji: string; dither?: GlyphDitherValue }
	| { kind: "dicebear"; style: string; seed: string }
	| (GhostAvatarSpec & { kind: "expressive" })
	| GlyphAvatarStyleValue
	| { kind: "dither"; dither: GlyphDitherValue }
	| null;

/**
 * An avatar drawn from a plugin-contributed style. `parts` maps a region id to a
 * style option id, `none`, or a contributed accessory id; unpicked regions come
 * from `seed`. Renders the surface fallback when the style's plugin is off.
 */
export interface GlyphAvatarStyleValue {
	kind: "avatar_style";
	palette?: string;
	parts?: Record<string, string>;
	seed: string;
	style: string;
}

/** Dither payload when present — standalone dither, or icon/emoji background. */
export function glyphDitherOf(value: GlyphValue): GlyphDitherValue | undefined {
	if (!value) {
		return undefined;
	}
	if (value.kind === "dither") {
		return value.dither;
	}
	if (value.kind === "icon" || value.kind === "emoji") {
		return value.dither;
	}
	return undefined;
}

/** Preset allowlists so hosts don't invent their own subsets. */
export const GLYPH_PRESETS = {
	/**
	 * Notion-style entity icons: spaces, pages, meetings, project folders, etc.
	 * Exactly: avatar, icon, emoji, dicebear.
	 */
	entity: [
		"avatar",
		"icon",
		"emoji",
		"dicebear",
	] as const satisfies readonly GlyphKind[],
	/**
	 * Agent persona avatars — the shared four plus expressive ghost faces,
	 * marketplace avatar styles, and the legacy dither gradient so existing
	 * agent personas remain editable.
	 */
	agent: [
		"avatar",
		"icon",
		"emoji",
		"dicebear",
		"expressive",
		"avatar_style",
		"dither",
	] as const satisfies readonly GlyphKind[],
} as const;

export type GlyphPresetName = keyof typeof GLYPH_PRESETS;

/** Resolve a preset name or explicit allowlist into a kind array. */
export function resolveGlyphKinds(
	allowed: readonly GlyphKind[] | GlyphPresetName
): readonly GlyphKind[] {
	if (isNativeText(allowed)) {
		const preset: GlyphPresetName = allowed;
		return GLYPH_PRESETS[preset];
	}
	return allowed;
}

/** Which picker tab a stored value opens on (falls back to first allowed). */
export function tabForGlyphValue(
	value: GlyphValue,
	allowed: readonly GlyphKind[]
): GlyphKind {
	if (value && allowed.includes(value.kind)) {
		return value.kind;
	}
	return allowed[0] ?? "avatar";
}

/**
 * All DiceBear styles from https://www.dicebear.com/styles/ (API kebab-case ids).
 * Kept as a const list so the picker never depends on a network catalog fetch.
 */
export const DICEBEAR_STYLES = [
	// Minimalist
	"disco",
	"glass",
	"glyphs",
	"icons",
	"identicon",
	"initial-face",
	"initials",
	"rings",
	"shapes",
	"shape-grid",
	"stripes",
	"thumbs",
	"triangles",
	// Characters
	"adventurer",
	"adventurer-neutral",
	"avataaars",
	"avataaars-neutral",
	"big-ears",
	"big-ears-neutral",
	"big-smile",
	"bottts",
	"bottts-neutral",
	"croodles",
	"croodles-neutral",
	"dylan",
	"fun-emoji",
	"lorelei",
	"lorelei-neutral",
	"micah",
	"miniavs",
	"notionists",
	"notionists-neutral",
	"open-peeps",
	"personas",
	"pixel-art",
	"pixel-art-neutral",
	"toon-head",
] as const;

export type DicebearStyle = (typeof DICEBEAR_STYLES)[number];

export const DEFAULT_DICEBEAR_STYLE: DicebearStyle = "notionists";

/** DiceBear HTTP API major version (matches existing discussion-kit mocks). */
export const DICEBEAR_API_VERSION = "9.x";

const DICEBEAR_STYLE_SET: ReadonlySet<string> = new Set(DICEBEAR_STYLES);

/** Build a DiceBear SVG URL for an `<img src>`. */
export function dicebearUrl(
	style: string,
	seed: string,
	opts: { size?: number } = {}
): string {
	const params = new URLSearchParams({ seed: seed.slice(0, 256) || "ryu" });
	const safeStyle = DICEBEAR_STYLE_SET.has(style)
		? style
		: DEFAULT_DICEBEAR_STYLE;
	if (opts.size) {
		params.set("size", String(opts.size));
	}
	return `https://api.dicebear.com/${DICEBEAR_API_VERSION}/${safeStyle}/svg?${params}`;
}

/** Human label for a DiceBear style id (`notionists-neutral` → `Notionists Neutral`). */
export function dicebearStyleLabel(style: string): string {
	return style
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Curated icon tint swatches; `undefined` = inherit `currentColor` (theme-aware). */
export const GLYPH_ICON_COLORS: { label: string; value: string | undefined }[] =
	[
		{ label: "Default", value: undefined },
		{ label: "Red", value: "#ef4444" },
		{ label: "Orange", value: "#f97316" },
		{ label: "Amber", value: "#f59e0b" },
		{ label: "Green", value: "#22c55e" },
		{ label: "Teal", value: "#14b8a6" },
		{ label: "Blue", value: "#3b82f6" },
		{ label: "Indigo", value: "#6366f1" },
		{ label: "Purple", value: "#a855f7" },
		{ label: "Pink", value: "#ec4899" },
		{ label: "Gray", value: "#6b7280" },
		{ label: "Black", value: "#111827" },
	];

export function isGlyphIconColor<T>(value: T): value is T & string {
	return (
		isNativeText(value) &&
		GLYPH_ICON_COLORS.some((swatch) => swatch.value === value)
	);
}

const ICONIFY_API = "https://api.iconify.design";

/** A single Iconify search hit. */
export interface GlyphIconHit {
	id: string;
	previewUrl: string;
}

/** Restrict a remote icon id to one collection and one icon name. */
export function iconifyPath(iconId: string): string | null {
	const candidate = iconId.includes(":") ? iconId : `hugeicons:${iconId}`;
	const match = /^([a-z0-9_-]+):([a-z0-9_-]+)$/iu.exec(candidate);
	return match ? `${match[1]}/${match[2]}` : null;
}

/** Build an Iconify SVG URL, optionally tinted. */
export function glyphIconSvgUrl(
	id: string,
	opts: { color?: string; size?: number } = {}
): string {
	const path = iconifyPath(id) ?? "hugeicons/question-mark";
	const params = new URLSearchParams();
	if (opts.color) {
		params.set("color", opts.color);
	}
	if (opts.size) {
		params.set("width", String(opts.size));
		params.set("height", String(opts.size));
	}
	const qs = params.toString();
	return `${ICONIFY_API}/${path}.svg${qs ? `?${qs}` : ""}`;
}

// These are consumed JSON projections of the two actual Iconify endpoints,
// not a declaration of the entire provider response. Search never validates
// collection-only fields or unrelated additive provider metadata.
const iconifySearchProjection = z.object({
	icons: z.array(z.string()).nullish(),
});
const iconifyCollectionProjection = z.object({
	uncategorized: z.array(z.string()).nullish(),
	categories: z.preprocess(
		(value) => {
			if (value === undefined || value === null) {
				return [];
			}
			if (isNativeObjectLike(value)) {
				// SAFETY: the native Lodash object-like observation proves a non-null
				// object operand for Object.values, not the category entries' shapes.
				// The following complete array parser validates every consumed entry.
				// Observe own values before parsing so valid JSON keys such as __proto__
				// are retained rather than dropped by a record-result constructor.
				return Object.values(value as object);
			}
			return value;
		},
		z.array(z.array(z.string()))
	),
});

/**
 * Search Iconify across all collections. Empty query returns a Lucide starter
 * set so the grid isn't blank on first open.
 * Rejects malformed consumed response fields with a validation error; missing
 * or null optional lists retain their empty-list fallback. Unrelated provider
 * metadata is not validated, and valid icon order/duplicates are preserved.
 */
export async function searchGlyphIcons(
	query: string,
	limit = 64
): Promise<GlyphIconHit[]> {
	const q = query.trim();
	const url = q
		? `${ICONIFY_API}/search?query=${encodeURIComponent(q)}&limit=${limit}`
		: `${ICONIFY_API}/collection?prefix=lucide`;
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`icon search failed: ${resp.status}`);
	}

	let ids: string[];
	if (q) {
		const data = iconifySearchProjection.parse(await resp.json());
		ids = data.icons ?? [];
	} else {
		const data = iconifyCollectionProjection.parse(await resp.json());
		const names = [
			...(data.uncategorized ?? []),
			...Object.values(data.categories ?? {}).flat(),
		].slice(0, limit);
		ids = names.map((n) => `lucide:${n}`);
	}
	return ids.map((id) => ({
		id,
		previewUrl: glyphIconSvgUrl(id, { color: "#888888" }),
	}));
}

/** Random seed for a fresh DiceBear avatar. */
export function randomDicebearSeed(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 10; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}

function isGlyphKind<T>(value: T): value is T & GlyphKind {
	return (
		value === "avatar" ||
		value === "icon" ||
		value === "emoji" ||
		value === "dicebear" ||
		value === "expressive" ||
		value === "avatar_style" ||
		value === "dither"
	);
}

/**
 * Narrow unknown JSON (sidebar `row.raw.icon`, `shell.openTab` opts, …) to a
 * {@link GlyphValue}. Returns `undefined` when the value is missing or not a
 * recognisable glyph shape so callers can leave an existing tab icon untouched.
 * Explicit `null` means "no custom glyph" and is a valid {@link GlyphValue}.
 */
const glyphRecordInputSchema = z
	.object({
		kind: z.unknown().optional(),
		dataUrl: z.unknown().optional(),
		id: z.unknown().optional(),
		color: z.unknown().optional(),
		dither: z.unknown().optional(),
		emoji: z.unknown().optional(),
		style: z.unknown().optional(),
		seed: z.unknown().optional(),
	})
	.passthrough();

const glyphInputSchema = z
	.unknown()
	.transform((input): GlyphValue | undefined => {
		const parsed = glyphRecordInputSchema.safeParse(input);
		if (input === undefined) {
			return undefined;
		}
		if (input === null) {
			return null;
		}
		if (!(parsed.success && Object.hasOwn(parsed.data, "kind"))) {
			return undefined;
		}
		const data = parsed.data;
		const kind = data.kind;
		if (!isGlyphKind(kind)) {
			return undefined;
		}
		if (kind === "expressive") {
			const ghost = parseGhostAvatar(data);
			return ghost ? { ...ghost, kind: "expressive" } : undefined;
		}
		if (kind === "avatar") {
			return isNativeText(data.dataUrl)
				? { kind, dataUrl: data.dataUrl }
				: undefined;
		}
		if (kind === "icon") {
			if (!(isNativeText(data.id) && data.id.trim()) || data.id.length > 200) {
				return undefined;
			}
			const color = isGlyphIconColor(data.color) ? data.color : undefined;
			const dither = parseGlyphDither(data.dither);
			return {
				kind,
				id: data.id,
				...(color ? { color } : undefined),
				...(dither ? { dither } : undefined),
			};
		}
		if (kind === "emoji") {
			if (
				!(isNativeText(data.emoji) && data.emoji.trim()) ||
				data.emoji.length > 32
			) {
				return undefined;
			}
			const dither = parseGlyphDither(data.dither);
			return { kind, emoji: data.emoji, ...(dither ? { dither } : undefined) };
		}
		if (kind === "dicebear") {
			if (!(isNativeText(data.style) && isNativeText(data.seed))) {
				return undefined;
			}
			return {
				kind,
				style: DICEBEAR_STYLE_SET.has(data.style)
					? data.style
					: DEFAULT_DICEBEAR_STYLE,
				seed: data.seed.slice(0, 256),
			};
		}
		if (kind === "avatar_style") {
			return parseGlyphAvatarStyle(data);
		}
		if (kind === "dither") {
			const dither = parseGlyphDither(data.dither);
			return dither ? { kind, dither } : undefined;
		}
		return undefined;
	});

/** Normalize raw persisted values through the owning input schema. */
export function asGlyphValue(
	data: z.input<typeof glyphInputSchema>
): GlyphValue | undefined {
	return glyphInputSchema.parse(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		isNativeObjectReceiver(value) && value !== null && !Array.isArray(value)
	);
}

const AVATAR_STYLE_PART_KEY = /^[a-z0-9][a-z0-9._-]{0,47}$/;

function parseGlyphAvatarStyle(
	data: Record<string, unknown>
): GlyphAvatarStyleValue | undefined {
	if (!(isContributedPartId(data.style) && isNativeText(data.seed))) {
		return undefined;
	}
	const value: GlyphAvatarStyleValue = {
		kind: "avatar_style",
		style: data.style,
		seed: data.seed.slice(0, 256),
	};
	if (isNativeText(data.palette) && AVATAR_STYLE_PART_KEY.test(data.palette)) {
		value.palette = data.palette;
	}
	if (isRecord(data.parts)) {
		const parts: Record<string, string> = {};
		for (const [region, pick] of Object.entries(data.parts).slice(0, 16)) {
			if (
				AVATAR_STYLE_PART_KEY.test(region) &&
				isNativeText(pick) &&
				(AVATAR_STYLE_PART_KEY.test(pick) || isContributedPartId(pick))
			) {
				parts[region] = pick;
			}
		}
		if (Object.keys(parts).length) {
			value.parts = parts;
		}
	}
	return value;
}

const glyphDitherInputSchema = z
	.unknown()
	.transform((value): GlyphDitherValue | undefined => {
		if (
			!(
				isNativeObjectReceiver(value) &&
				value !== null &&
				!Array.isArray(value) &&
				"from" in value &&
				"direction" in value &&
				"to" in value &&
				isDitherColor(value.from)
			)
		) {
			return undefined;
		}
		const direction =
			value.direction === "down" ||
			value.direction === "left" ||
			value.direction === "right"
				? value.direction
				: value.direction === "up"
					? value.direction
					: null;
		if (!direction) {
			return undefined;
		}
		const to =
			value.to === null ? null : isDitherColor(value.to) ? value.to : undefined;
		return to === undefined ? undefined : { direction, from: value.from, to };
	});

function parseGlyphDither(
	value: z.input<typeof glyphDitherInputSchema>
): GlyphDitherValue | undefined {
	return glyphDitherInputSchema.parse(value);
}
