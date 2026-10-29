// apps/desktop/src/lib/wallpaper.ts
//
// One device-level wallpaper preference shared by the OS desktop and the
// startup account/node chooser. It is deliberately NOT per account: the chooser
// renders before an account is picked and reloads the app afterwards, so the
// backdrop has to be readable without knowing who is signed in.
//
// Modes:
// - `random`  → a fresh pick from the curated gallery (optionally one set) each
//               session. Shuffling rerolls the session pick without persisting.
// - `preset`  → a curated gallery image by id.
// - `image`   → any other image: an Unsplash/Openverse search hit, a pasted
//               https link, or an upload downscaled into a `data:` URL.
// - `backdrop` → an animated or patterned background from the universal
//               backdrop registry (@ryu/ui backdrop), with its custom params.

import {
	type BackdropParams,
	resolveBackdropParams,
} from "@ryu/ui/components/backdrop/params.ts";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import type { PluginBackground } from "@/src/lib/api/plugin-contribution-boundary.ts";
import { hasControlCharacters } from "@/src/lib/api/plugin-contribution-boundary.ts";
import {
	backdropByAvailableId,
	getAvailableBackdrops,
	isPluginBackgroundId,
	loadPluginBackgrounds,
	usePluginBackgrounds,
} from "./plugin-backgrounds.ts";

export interface OsWallpaper {
	/** Photographer credit for search results, shown next to the preview. */
	attribution?: string;
	/** HTTPS page credited by a marketplace background. */
	attributionUrl?: string;
	/** Set when the wallpaper is a registry backdrop instead of an image. */
	backdrop?: WallpaperBackdropChoice;
	id: string;
	label: string;
	set: string;
	url: string;
}

export type WallpaperMode = "random" | "preset" | "image" | "backdrop";

export interface WallpaperBackdropChoice {
	id: string;
	params: BackdropParams;
}

export interface WallpaperPreference {
	backdrop: WallpaperBackdropChoice | null;
	image: {
		attribution: string | null;
		label: string;
		sourceUrl: string | null;
		url: string;
	} | null;
	mode: WallpaperMode;
	presetId: string | null;
	/** Gallery set the random mode and shuffle draw from (`all` for every set). */
	set: string;
}

export const WALLPAPER_STORAGE_KEY = "ryu:wallpaper";
export const ALL_WALLPAPER_SETS = "all";

export const DEFAULT_WALLPAPER_PREFERENCE: WallpaperPreference = {
	backdrop: null,
	image: null,
	mode: "random",
	presetId: null,
	set: ALL_WALLPAPER_SETS,
};

function unsplash(photo: string): string {
	return `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=2400&q=85`;
}

/** Curated Unsplash gallery. URLs are remote by design; every surface keeps a
 * solid color and gradient underneath as the offline fallback. */
export const OS_WALLPAPERS: readonly OsWallpaper[] = [
	{
		id: "golden-gate-day",
		label: "Golden Gate",
		set: "Golden Gate",
		url: unsplash("photo-1501594907352-04cda38ebc29"),
	},
	{
		id: "golden-gate-dusk",
		label: "Golden Gate dusk",
		set: "Golden Gate",
		url: unsplash("photo-1449034446853-66c86144b0ad"),
	},
	{
		id: "misty-valley",
		label: "Misty valley",
		set: "Open air",
		url: unsplash("photo-1470770841072-f978cf4d019e"),
	},
	{
		id: "mountain-lake",
		label: "Mountain lake",
		set: "Open air",
		url: unsplash("photo-1464822759023-fed622ff2c3b"),
	},
	{
		id: "cloud-peak",
		label: "Cloud peak",
		set: "Open air",
		url: unsplash("photo-1505765050516-f72dcac9c60e"),
	},
	{
		id: "yosemite",
		label: "Yosemite",
		set: "Open air",
		url: unsplash("photo-1506744038136-46273834b3fb"),
	},
	{
		id: "canyon-road",
		label: "Canyon road",
		set: "Open air",
		url: unsplash("photo-1500530855697-b586d89ba3ee"),
	},
	{
		id: "deep-forest",
		label: "Deep forest",
		set: "Quiet places",
		url: unsplash("photo-1511497584788-876760111969"),
	},
	{
		id: "golden-trees",
		label: "Golden trees",
		set: "Quiet places",
		url: unsplash("photo-1470252649378-9c29740c9fa8"),
	},
	{
		id: "forest-path",
		label: "Forest path",
		set: "Quiet places",
		url: unsplash("photo-1441974231531-c6227db76b6e"),
	},
	{
		id: "fairy-glen",
		label: "Fairy glen",
		set: "Quiet places",
		url: unsplash("photo-1472214103451-9374bd1c798e"),
	},
	{
		id: "lake-dock",
		label: "Lake dock",
		set: "Quiet places",
		url: unsplash("photo-1439066615861-d1af74d74000"),
	},
	{
		id: "shoreline",
		label: "Shoreline",
		set: "Coast",
		url: unsplash("photo-1507525428034-b723cf961d3e"),
	},
	{
		id: "still-water",
		label: "Still water",
		set: "Coast",
		url: unsplash("photo-1518837695005-2083093ee35b"),
	},
	{
		id: "night-ridge",
		label: "Night ridge",
		set: "After hours",
		url: unsplash("photo-1500534623283-312aade485b7"),
	},
	{
		id: "milky-way",
		label: "Milky Way",
		set: "After hours",
		url: unsplash("photo-1419242902214-272b3f66ee7a"),
	},
	{
		// Kept under its original id so saved choices still resolve.
		id: "alpine-blue",
		label: "Neon street",
		set: "After hours",
		url: unsplash("photo-1519608487953-e999c86e7455"),
	},
	{
		id: "harbor-lights",
		label: "Harbor lights",
		set: "After hours",
		url: unsplash("photo-1514565131-fce0801e5785"),
	},
	{
		id: "skyline",
		label: "Skyline",
		set: "Cities",
		url: unsplash("photo-1477959858617-67f85cf4f1df"),
	},
	{
		id: "deep-blue",
		label: "Deep blue",
		set: "Gradients",
		url: unsplash("photo-1557683316-973673baf926"),
	},
	{
		id: "aurora-glow",
		label: "Aurora glow",
		set: "Gradients",
		url: unsplash("photo-1579546929518-9e396f3cc809"),
	},
	{
		id: "liquid-wave",
		label: "Liquid wave",
		set: "Gradients",
		url: unsplash("photo-1618005182384-a83a8bd57fbe"),
	},
];

export const WALLPAPER_SETS: readonly string[] = [
	...new Set(OS_WALLPAPERS.map((item) => item.set)),
];

/** A smaller copy of a gallery or Unsplash image for picker thumbnails. */
export function wallpaperThumbnailUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "images.unsplash.com") {
			return url;
		}
		parsed.searchParams.set("w", "480");
		parsed.searchParams.set("q", "70");
		return parsed.toString();
	} catch {
		return url;
	}
}

/** Unsplash search hits come back at ~1080px; ask imgix for a desktop-size copy. */
export function wallpaperFullSizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "images.unsplash.com") {
			return url;
		}
		parsed.searchParams.set("w", "2400");
		parsed.searchParams.set("q", "85");
		parsed.searchParams.set("fit", "max");
		return parsed.toString();
	} catch {
		return url;
	}
}

export function wallpapersInSet(set: string): readonly OsWallpaper[] {
	if (set === ALL_WALLPAPER_SETS) {
		return OS_WALLPAPERS;
	}
	const pool = OS_WALLPAPERS.filter((item) => item.set === set);
	return pool.length > 0 ? pool : OS_WALLPAPERS;
}

export function randomWallpaper(
	wallpapers: readonly OsWallpaper[],
	currentId?: string,
	random: () => number = Math.random
): OsWallpaper {
	const choices = wallpapers.filter((wallpaper) => wallpaper.id !== currentId);
	const pool = choices.length > 0 ? choices : wallpapers;
	return pool[Math.floor(random() * pool.length)] ?? OS_WALLPAPERS[0];
}

const wallpaperTextSchema = z.string().min(1).nullable().catch(null);
const wallpaperStoredRootSchema = z.union([
	z.record(z.string(), z.json()),
	z.array(z.json()),
]);
const wallpaperStoredImageSchema = z
	.object({
		attribution: wallpaperTextSchema,
		label: z.string().min(1).catch("Your wallpaper"),
		sourceUrl: wallpaperTextSchema,
		url: z.string().min(1),
	})
	.nullable()
	.catch(null);
const wallpaperStoredPreferenceSchema = z.object({
	set: z
		.string()
		.refine(
			(value) => value === ALL_WALLPAPER_SETS || WALLPAPER_SETS.includes(value)
		)
		.catch(ALL_WALLPAPER_SETS),
	presetId: wallpaperTextSchema,
	mode: z.string().catch("random"),
	image: wallpaperStoredImageSchema,
	backdrop: z.json().optional(),
});
const wallpaperStoredBackdropSchema = z.object({
	id: z.string(),
	params: z.json().optional(),
});
const wallpaperStoredParamKeySchema = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
	.refine((value) => value !== "constructor" && value !== "prototype");
const wallpaperStoredParamTextSchema = z
	.string()
	.max(128)
	.refine((value) => !hasControlCharacters(value));
const wallpaperStoredParamContract = z.union([
	wallpaperStoredParamTextSchema,
	z.number(),
	z.boolean(),
	z.array(wallpaperStoredParamTextSchema).max(16),
]);
const wallpaperStoredParamValueSchema = z.custom<
	z.output<typeof wallpaperStoredParamContract>
>((value) => wallpaperStoredParamContract.safeParse(value).success);
const wallpaperStoredParamsSchema = z.record(z.string(), z.json());

/** Parse a stored preference, falling back to defaults for anything malformed. */
export function parseWallpaperPreference(
	raw: string | null,
	pluginBackgrounds = loadPluginBackgrounds()
): WallpaperPreference {
	if (!raw) {
		return DEFAULT_WALLPAPER_PREFERENCE;
	}
	let root: z.output<typeof wallpaperStoredRootSchema>;
	try {
		root = wallpaperStoredRootSchema.parse(JSON.parse(raw));
	} catch {
		return DEFAULT_WALLPAPER_PREFERENCE;
	}
	const parsed = wallpaperStoredPreferenceSchema.parse(
		Array.isArray(root) ? {} : root
	);
	const { set, presetId, image } = parsed;
	const backdrop = parseBackdropChoice(parsed.backdrop, pluginBackgrounds);
	if (
		parsed.mode === "preset" &&
		presetId &&
		OS_WALLPAPERS.some((item) => item.id === presetId)
	) {
		return { backdrop, image, mode: "preset", presetId, set };
	}
	if (parsed.mode === "image" && image) {
		return { backdrop, image, mode: "image", presetId, set };
	}
	if (parsed.mode === "backdrop" && backdrop) {
		return { backdrop, image, mode: "backdrop", presetId, set };
	}
	return { backdrop, image, mode: "random", presetId, set };
}

/** A stored backdrop choice, re-validated against the registry's schema. */
function parseStoredBackdropParams(
	raw: Parameters<typeof wallpaperStoredParamsSchema.parse>[0]
): BackdropParams {
	const parsed = wallpaperStoredParamsSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}
	const params: BackdropParams = {};
	for (const [key, value] of Object.entries(parsed.data)) {
		if (!wallpaperStoredParamKeySchema.safeParse(key).success) {
			continue;
		}
		const parameter = wallpaperStoredParamValueSchema.safeParse(value);
		if (parameter.success) {
			params[key] = parameter.data;
		}
	}
	return params;
}

function parseBackdropChoice(
	raw: Parameters<typeof wallpaperStoredBackdropSchema.parse>[0],
	pluginBackgrounds: ReturnType<typeof loadPluginBackgrounds>
): WallpaperBackdropChoice | null {
	const parsed = wallpaperStoredBackdropSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const choice = parsed.data;
	const definition = backdropByAvailableId(choice.id, pluginBackgrounds);
	if (!definition) {
		return isPluginBackgroundId(choice.id)
			? { id: choice.id, params: parseStoredBackdropParams(choice.params) }
			: null;
	}
	return {
		id: definition.id,
		params: resolveBackdropParams(definition.params, choice.params),
	};
}

/**
 * The wallpaper to show for a preference. `sessionPick` is the random-mode
 * choice for this session, so every surface in one window agrees.
 */
export function resolveWallpaper(
	preference: WallpaperPreference,
	sessionPick: OsWallpaper,
	pluginBackgrounds = loadPluginBackgrounds()
): OsWallpaper {
	if (preference.mode === "backdrop" && preference.backdrop) {
		const definition = backdropByAvailableId(
			preference.backdrop.id,
			pluginBackgrounds
		);
		if (definition) {
			const attribution: Pick<OsWallpaper, "attribution" | "attributionUrl"> =
				{};
			if (definition.attribution) {
				attribution.attribution = definition.attribution;
			}
			if (definition.attributionUrl) {
				attribution.attributionUrl = definition.attributionUrl;
			}
			return {
				...attribution,
				backdrop: preference.backdrop,
				id: `backdrop:${definition.id}`,
				label: definition.label,
				set: definition.category,
				url: "",
			};
		}
	}
	if (preference.mode === "image" && preference.image) {
		return {
			attribution: preference.image.attribution ?? undefined,
			id: "custom",
			label: preference.image.label,
			set: "Custom",
			url: preference.image.url,
		};
	}
	if (preference.mode === "preset") {
		const preset = OS_WALLPAPERS.find(
			(item) => item.id === preference.presetId
		);
		if (preset) {
			return preset;
		}
	}
	return sessionPick;
}

/** Drop a selected marketplace background after a successful refresh removes it. */
export function clearUnavailableBackdrop(
	preference: WallpaperPreference,
	availableBackgrounds: readonly PluginBackground[]
): WallpaperPreference {
	if (
		preference.mode !== "backdrop" ||
		!preference.backdrop ||
		backdropByAvailableId(preference.backdrop.id, availableBackgrounds)
	) {
		return preference;
	}
	return { ...preference, backdrop: null, mode: "random" };
}

// ---- store ----------------------------------------------------------------

const listeners = new Set<() => void>();
/** This window's random-mode pick, shared by every surface that renders it. */
let sessionPick: OsWallpaper = randomWallpaper(OS_WALLPAPERS);

function readRaw(): string | null {
	try {
		return localStorage.getItem(WALLPAPER_STORAGE_KEY);
	} catch {
		return null;
	}
}

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

function readSessionPick(): OsWallpaper {
	return sessionPick;
}

/** Keep the session pick inside the chosen set so random mode honors it. */
function syncSessionPick(set: string): void {
	const pool = wallpapersInSet(set);
	if (!pool.includes(sessionPick)) {
		sessionPick = randomWallpaper(pool);
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	const onStorage = (event: StorageEvent) => {
		if (event.key === WALLPAPER_STORAGE_KEY) {
			listener();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

export function readWallpaperPreference(): WallpaperPreference {
	return parseWallpaperPreference(readRaw());
}

/**
 * Persist a preference. Throws when storage refuses the write (an upload that
 * still exceeds the quota) so the caller can tell the user.
 */
export function writeWallpaperPreference(
	preference: WallpaperPreference
): void {
	localStorage.setItem(WALLPAPER_STORAGE_KEY, JSON.stringify(preference));
	notify();
}

export function useWallpaper() {
	const raw = useSyncExternalStore(subscribe, readRaw, () => null);
	const pluginBackgrounds = usePluginBackgrounds();
	const pick = useSyncExternalStore(
		subscribe,
		readSessionPick,
		readSessionPick
	);
	const preference = useMemo(
		() => parseWallpaperPreference(raw, pluginBackgrounds),
		[pluginBackgrounds, raw]
	);
	const wallpaper = useMemo(
		() => resolveWallpaper(preference, pick, pluginBackgrounds),
		[pick, pluginBackgrounds, preference]
	);

	const update = useCallback((next: Partial<WallpaperPreference>) => {
		const merged = { ...readWallpaperPreference(), ...next };
		syncSessionPick(merged.set);
		writeWallpaperPreference(merged);
	}, []);

	const shuffle = useCallback(() => {
		const current = readWallpaperPreference();
		const pool = wallpapersInSet(current.set);
		if (current.mode === "preset") {
			const next = randomWallpaper(pool, current.presetId ?? undefined);
			writeWallpaperPreference({ ...current, presetId: next.id });
			return;
		}
		// Random and custom-image modes reroll the session pick only; shuffling
		// never silently discards a saved choice.
		sessionPick = randomWallpaper(pool, sessionPick.id);
		if (current.mode === "backdrop" && current.backdrop) {
			// Shuffle to another backdrop in the same category, at its defaults.
			const category = backdropByAvailableId(
				current.backdrop.id,
				pluginBackgrounds
			)?.category;
			const pool = getAvailableBackdrops(pluginBackgrounds).filter(
				(item) => item.category === category && item.id !== current.backdrop?.id
			);
			const next = pool[Math.floor(Math.random() * pool.length)];
			if (next) {
				writeWallpaperPreference({
					...current,
					backdrop: { id: next.id, params: next.initialParams },
				});
			}
			return;
		}
		if (current.mode === "image") {
			writeWallpaperPreference({ ...current, mode: "random" });
			return;
		}
		notify();
	}, [pluginBackgrounds]);

	return { preference, shuffle, update, wallpaper };
}

// ---- uploads ----------------------------------------------------------------

const MAX_UPLOAD_EDGE = 2560;

/** Downscale an uploaded image into a JPEG `data:` URL small enough to persist. */
export async function fileToWallpaperDataUrl(file: File): Promise<string> {
	if (!file.type.startsWith("image/")) {
		throw new Error("Choose an image file.");
	}
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(
			1,
			MAX_UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height)
		);
		const canvas = document.createElement("canvas");
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("This device can't process images right now.");
		}
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL("image/jpeg", 0.85);
	} finally {
		bitmap.close();
	}
}
