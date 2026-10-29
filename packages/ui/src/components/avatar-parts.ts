/**
 * Plugin-contributed avatar parts: accessories that dress a region of the Ryu
 * ghost or of an avatar style (`contributes.avatar_accessories`), and whole avatar
 * styles with their own palettes and regions (`contributes.avatar_styles`).
 *
 * The wire contract is owned by `crates/core/kernel-contracts/src/avatar.rs`; Core
 * validates every manifest against it. This module re-checks the same grammar at
 * the client boundary so a stale cache or an older Core can never hand the
 * renderer anything outside the inert shape vocabulary.
 */

import { z } from "zod";

/** Target id addressing the built-in Ryu ghost. */
export const GHOST_AVATAR_TARGET = "ghost";

/** Costume regions of the ghost an accessory may dress (mirrors Core). */
export const GHOST_AVATAR_REGIONS = [
	"eyes",
	"brows",
	"mouth",
	"ears",
	"headwear",
	"glasses",
	"accessory",
	"pattern",
] as const;
export type GhostAvatarRegion = (typeof GHOST_AVATAR_REGIONS)[number];

/** A namespaced contributed id: `<plugin-id>:<local-id>`. */
export type ContributedPartId = `${string}:${string}`;

const CONTRIBUTED_ID =
	/^(?:@[A-Za-z0-9._-]{1,128}\/)?[A-Za-z0-9._-]{1,128}:[a-z0-9][a-z0-9._-]{0,95}$/;

/** True when an avatar selection names a plugin-contributed part or style. */
export function isContributedPartId(
	value: unknown
): value is ContributedPartId {
	return typeof value === "string" && CONTRIBUTED_ID.test(value);
}

const MAX_COORDINATE = 10_000;
const MAX_GEOMETRY = 8 * 1024;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-eE \t\n\r]+$/;
const POINT_LIST = /^[0-9.,+\-eE \t\n\r]+$/;
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const TRANSFORM_FUNCTIONS = new Set([
	"translate",
	"rotate",
	"scale",
	"skewX",
	"skewY",
	"matrix",
]);
const PAINT_TOKENS = new Set([
	"none",
	"currentColor",
	"ink",
	"palette.base",
	"palette.light",
	"palette.deep",
]);

/** The paint vocabulary: tokens or hex. Never `url(...)` or free CSS. */
export function isAvatarPaint(value: string): boolean {
	return PAINT_TOKENS.has(value) || HEX_COLOR.test(value);
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/** SVG transform list of numeric functions only. */
export function isAvatarTransform(value: string): boolean {
	if (!value.trim() || value.length > 256) {
		return false;
	}
	let rest = value.trim();
	while (rest) {
		const open = rest.indexOf("(");
		const close = rest.indexOf(")");
		if (open < 0 || close < open) {
			return false;
		}
		const name = rest.slice(0, open).replace(/^[\s,]+|[\s,]+$/g, "");
		const args = rest.slice(open + 1, close);
		if (
			!(
				TRANSFORM_FUNCTIONS.has(name) &&
				args.trim() &&
				/^[0-9.,+\-eE \t]+$/.test(args)
			)
		) {
			return false;
		}
		rest = rest.slice(close + 1).replace(/^[\s,]+/, "");
	}
	return true;
}

const coordinate = z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const length = z.number().finite().min(0).max(MAX_COORDINATE);
const label = z
	.string()
	.max(128)
	.refine((value) => value.trim().length > 0 && !hasControlCharacters(value));
const description = z
	.string()
	.max(512)
	.refine((value) => !hasControlCharacters(value));
const paint = z.string().refine(isAvatarPaint);
const layer = z.enum(["front", "behind"]).default("front");

const avatarShapeSchema = z
	.object({
		type: z.enum([
			"path",
			"circle",
			"ellipse",
			"rect",
			"polygon",
			"polyline",
			"line",
		]),
		d: z.string().max(MAX_GEOMETRY).regex(PATH_DATA).optional(),
		points: z.string().max(MAX_GEOMETRY).regex(POINT_LIST).optional(),
		cx: coordinate.optional(),
		cy: coordinate.optional(),
		r: length.optional(),
		rx: length.optional(),
		ry: length.optional(),
		x: coordinate.optional(),
		y: coordinate.optional(),
		width: length.optional(),
		height: length.optional(),
		x1: coordinate.optional(),
		y1: coordinate.optional(),
		x2: coordinate.optional(),
		y2: coordinate.optional(),
		fill: paint.optional(),
		stroke: paint.optional(),
		strokeWidth: z.number().finite().min(0).max(100).optional(),
		strokeLinecap: z.enum(["butt", "round", "square"]).optional(),
		strokeLinejoin: z.enum(["miter", "round", "bevel"]).optional(),
		opacity: z.number().finite().min(0).max(1).optional(),
		transform: z.string().refine(isAvatarTransform).optional(),
	})
	.refine((shape) => {
		switch (shape.type) {
			case "path":
				return Boolean(shape.d?.trim()) && shape.points === undefined;
			case "polygon":
			case "polyline":
				return Boolean(shape.points?.trim()) && shape.d === undefined;
			case "circle":
				return shape.r !== undefined;
			case "ellipse":
				return shape.rx !== undefined && shape.ry !== undefined;
			case "rect":
				return shape.width !== undefined && shape.height !== undefined;
			default:
				return shape.d === undefined && shape.points === undefined;
		}
	});
export type AvatarShape = z.output<typeof avatarShapeSchema>;

const shapes = z.array(avatarShapeSchema).max(64);
const pluginId = z.string().min(1).max(128);

export const avatarAccessorySchema = z
	.object({
		id: z.string().refine(isContributedPartId),
		label,
		description: description.optional(),
		target: z
			.string()
			.refine(
				(value) => value === GHOST_AVATAR_TARGET || isContributedPartId(value)
			),
		region: z.string().regex(LOCAL_ID),
		layer,
		shapes: shapes.min(1),
		plugin: pluginId.optional(),
	})
	.refine(
		(accessory) =>
			accessory.target !== GHOST_AVATAR_TARGET ||
			GHOST_AVATAR_REGIONS.some((region) => region === accessory.region)
	)
	.refine(
		(accessory) =>
			accessory.plugin === undefined ||
			accessory.id.startsWith(`${accessory.plugin}:`)
	);
export type AvatarAccessory = z.output<typeof avatarAccessorySchema>;

const hex = z.string().regex(HEX_COLOR);
const avatarStylePaletteSchema = z.object({
	id: z.string().regex(LOCAL_ID),
	label,
	base: hex,
	light: hex,
	deep: hex,
	ink: hex.optional(),
});
export type AvatarStylePalette = z.output<typeof avatarStylePaletteSchema>;

const avatarStyleRegionSchema = z.object({
	id: z.string().regex(LOCAL_ID),
	label,
	layer,
	optional: z.boolean().default(false),
	options: z
		.array(
			z.object({
				id: z
					.string()
					.regex(LOCAL_ID)
					.refine((id) => id !== "none"),
				label,
				shapes: shapes.min(1),
			})
		)
		.min(1)
		.max(64),
});
export type AvatarStyleRegion = z.output<typeof avatarStyleRegionSchema>;

export const avatarStyleSchema = z
	.object({
		id: z.string().refine(isContributedPartId),
		label,
		description: description.optional(),
		viewBox: z.tuple([coordinate, coordinate, length, length]),
		palettes: z.array(avatarStylePaletteSchema).min(1).max(16),
		base: shapes.default([]),
		regions: z.array(avatarStyleRegionSchema).max(16).default([]),
		plugin: pluginId.optional(),
	})
	.refine(
		(style) =>
			style.viewBox[2] > 0 &&
			style.viewBox[3] > 0 &&
			(style.base.length > 0 || style.regions.length > 0)
	)
	.refine(
		(style) =>
			style.plugin === undefined || style.id.startsWith(`${style.plugin}:`)
	);
export type AvatarStyle = z.output<typeof avatarStyleSchema>;

/** Everything enabled plugins contribute to the avatar system. */
export interface AvatarContributions {
	accessories: AvatarAccessory[];
	styles: AvatarStyle[];
}

export const EMPTY_AVATAR_CONTRIBUTIONS: AvatarContributions = {
	accessories: [],
	styles: [],
};

function parseRows<T>(
	value: unknown,
	schema: z.ZodType<T>,
	idOf: (row: T) => string,
	limit: number
): T[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const rows: T[] = [];
	for (const entry of value.slice(0, limit)) {
		const parsed = schema.safeParse(entry);
		if (!parsed.success || seen.has(idOf(parsed.data))) {
			continue;
		}
		seen.add(idOf(parsed.data));
		rows.push(parsed.data);
	}
	return rows;
}

/** Parse untrusted contribution rows once at the API or cache boundary. */
export function parseAvatarContributions(
	accessories: unknown,
	styles: unknown
): AvatarContributions {
	return {
		accessories: parseRows(
			accessories,
			avatarAccessorySchema,
			(row) => row.id,
			1024
		),
		styles: parseRows(styles, avatarStyleSchema, (row) => row.id, 256),
	};
}

/** Accessories that dress one region of a target (`ghost` or a style id). */
export function accessoriesFor(
	contributions: AvatarContributions,
	target: string,
	region: string
): AvatarAccessory[] {
	return contributions.accessories.filter(
		(accessory) => accessory.target === target && accessory.region === region
	);
}

/** Colours a part's paint tokens resolve against. */
export interface AvatarPaintPalette {
	base: string;
	deep: string;
	ink: string;
	light: string;
}

const DEFAULT_INK = "#0a0710";

/** Resolve a validated paint to an SVG colour value. */
export function resolveAvatarPaint(
	value: string | undefined,
	palette: AvatarPaintPalette
): string | undefined {
	switch (value) {
		case undefined:
			return undefined;
		case "ink":
			return palette.ink;
		case "palette.base":
			return palette.base;
		case "palette.light":
			return palette.light;
		case "palette.deep":
			return palette.deep;
		default:
			return value;
	}
}

/** A persisted selection for a contributed avatar style. */
export interface AvatarStyleSelection {
	palette?: string;
	/** Explicit region picks: a style option id, `none`, or an accessory id. */
	parts?: Record<string, string>;
	seed: string;
	style: string;
}

/** One drawn part of a resolved style. */
export interface ResolvedAvatarPart {
	id: string;
	region: string;
	shapes: AvatarShape[];
}

export interface ResolvedAvatarStyle {
	behind: ResolvedAvatarPart[];
	front: ResolvedAvatarPart[];
	palette: AvatarPaintPalette;
	paletteId: string;
	/** The option or accessory id each region resolved to (`none` when empty). */
	picks: Record<string, string>;
}

/** FNV-1a: a small stable hash so a seed always resolves to the same look. */
function seededIndex(seed: string, salt: string, count: number): number {
	let hash = 0x81_1c_9d_c5;
	for (const character of `${seed}\u0000${salt}`) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return (hash >>> 0) % count;
}

/**
 * Resolve a style selection into drawable layers. Unpicked regions are chosen
 * from the seed, like a DiceBear style; an explicit pick may be one of the
 * style's own options, `none` for an optional region, or an accessory another
 * plugin contributed for that region. Unknown picks fall back to the seed.
 */
export function resolveAvatarStyle(
	style: AvatarStyle,
	selection: Pick<AvatarStyleSelection, "parts" | "palette" | "seed">,
	accessories: readonly AvatarAccessory[] = []
): ResolvedAvatarStyle {
	const paletteRow =
		style.palettes.find((palette) => palette.id === selection.palette) ??
		style.palettes[
			seededIndex(selection.seed, "palette", style.palettes.length)
		] ??
		style.palettes[0];
	const palette: AvatarPaintPalette = {
		base: paletteRow?.base ?? "#cccccc",
		light: paletteRow?.light ?? "#ffffff",
		deep: paletteRow?.deep ?? "#333333",
		ink: paletteRow?.ink ?? DEFAULT_INK,
	};
	const behind: ResolvedAvatarPart[] = [];
	const front: ResolvedAvatarPart[] = [];
	const picks: Record<string, string> = {};
	for (const region of style.regions) {
		const pick = selection.parts?.[region.id];
		const accessory = isContributedPartId(pick)
			? accessories.find(
					(row) =>
						row.id === pick &&
						row.target === style.id &&
						row.region === region.id
				)
			: undefined;
		if (accessory) {
			picks[region.id] = accessory.id;
			const part = {
				id: accessory.id,
				region: region.id,
				shapes: accessory.shapes,
			};
			(accessory.layer === "behind" || region.layer === "behind"
				? behind
				: front
			).push(part);
			continue;
		}
		if (pick === "none" && region.optional) {
			picks[region.id] = "none";
			continue;
		}
		let option = region.options.find((row) => row.id === pick);
		if (!option) {
			const count = region.options.length + (region.optional ? 1 : 0);
			option = region.options[seededIndex(selection.seed, region.id, count)];
		}
		if (!option) {
			picks[region.id] = "none";
			continue;
		}
		picks[region.id] = option.id;
		(region.layer === "behind" ? behind : front).push({
			id: option.id,
			region: region.id,
			shapes: option.shapes,
		});
	}
	return {
		behind,
		front,
		palette,
		paletteId: paletteRow?.id ?? "",
		picks,
	};
}
