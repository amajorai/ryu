import { z } from "zod";
// Desktop background customization: per-surface (sidebar + page) gradient and
// image backgrounds, layered on TOP of the theme's solid `--sidebar` /
// `--background` colors via `background-image`. Off by default — purely a
// customization layer. Mirrors the CSS-variable apply pattern in
// useThemePreset.ts.
//
// Storage split: the small config (gradient, fit, scale, overlay, toggles)
// lives in localStorage; the image BYTES live in IndexedDB (a Blob, no base64
// bloat) so there is no practical size limit — localStorage's ~5MB quota would
// otherwise throw and could wedge unrelated theme writes. The image is exposed
// to CSS as a per-window object URL recreated from the stored Blob at startup.

export type BackgroundFit = "cover" | "contain" | "fill" | "center" | "tile";

export type BackgroundSurface = "sidebar" | "page";

/** One color stop in a linear gradient, at an arbitrary position. */
export interface GradientStop {
	color: string; // hex
	/** Stop position along the gradient, 0-100 percent. */
	position: number;
}

export interface SurfaceBackground {
	/** Blur radius applied to the background layer itself, px (0 = sharp). */
	backdropBlur: number;
	/** Direction of the gradient, degrees 0-360. */
	gradientAngle: number;
	/** Layer a linear gradient behind the surface. */
	gradientEnabled: boolean;
	/** Color stops, in insertion order (sorted when the CSS is built). */
	gradientStops: GradientStop[];
	/** Layer a custom image over the gradient/color. */
	imageEnabled: boolean;
	imageFit: BackgroundFit;
	imageScale: number; // percent, only meaningful for center/tile
	/**
	 * Runtime object URL for the stored image Blob. NOT persisted — recreated
	 * from IndexedDB at startup and after a pick. Empty when no image is set.
	 */
	imageSrc: string;
	/** Tint drawn on top of the image to keep foreground text legible. */
	overlayColor: string; // hex
	overlayOpacity: number; // 0-100
	/** How see-through the whole background layer is (0 = opaque, 100 = gone). */
	transparency: number;
}

export const DEFAULT_SURFACE_BACKGROUND: SurfaceBackground = {
	gradientEnabled: false,
	gradientAngle: 135,
	gradientStops: [
		{ color: "#0099ff", position: 0 },
		{ color: "#7c3aed", position: 100 },
	],
	imageEnabled: false,
	imageSrc: "",
	imageFit: "cover",
	imageScale: 100,
	overlayColor: "#000000",
	overlayOpacity: 30,
	transparency: 0,
	backdropBlur: 0,
};

export function buildGradientCss(stops: GradientStop[], angle: number): string {
	const sorted = [...stops].sort((a, b) => a.position - b.position);
	const parts = sorted.map(
		(s) => `${hexToRgba(s.color, 1)} ${Math.round(s.position)}%`
	);
	return `linear-gradient(${angle}deg, ${parts.join(", ")})`;
}

const STORAGE_KEYS = {
	sidebar: "ryu:bg:sidebar",
	page: "ryu:bg:page",
} satisfies Record<BackgroundSurface, string>;

const CSS_VAR_PREFIX = {
	sidebar: "--ryu-sidebar-bg",
	page: "--ryu-page-bg",
} satisfies Record<BackgroundSurface, string>;

// Cross-window/tab change signal. The browser `storage` event only fires in
// OTHER windows, so we also dispatch this locally to update hooks in the window
// that made the change (e.g. a reset triggered elsewhere in Settings).
export const BG_CHANGE_EVENT = "ryu:bg-changed";

// --- IndexedDB image store ------------------------------------------------

const DB_NAME = "ryu-backgrounds";
const DB_VERSION = 1;
const IMAGE_STORE = "images";

function openImageDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(IMAGE_STORE)) {
				db.createObjectStore(IMAGE_STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
	});
}

async function idbGetImage(surface: BackgroundSurface): Promise<Blob | null> {
	try {
		const db = await openImageDb();
		return await new Promise<Blob | null>((resolve, reject) => {
			const tx = db.transaction(IMAGE_STORE, "readonly");
			const req = tx.objectStore(IMAGE_STORE).get(surface);
			req.onsuccess = () =>
				resolve(req.result instanceof Blob ? req.result : null);
			req.onerror = () => reject(req.error ?? new Error("read failed"));
		});
	} catch {
		return null;
	}
}

async function idbPutImage(
	surface: BackgroundSurface,
	blob: Blob
): Promise<boolean> {
	try {
		const db = await openImageDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IMAGE_STORE, "readwrite");
			tx.objectStore(IMAGE_STORE).put(blob, surface);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("write failed"));
		});
		return true;
	} catch {
		return false;
	}
}

async function idbDeleteImage(surface: BackgroundSurface): Promise<void> {
	try {
		const db = await openImageDb();
		await new Promise<void>((resolve) => {
			const tx = db.transaction(IMAGE_STORE, "readwrite");
			tx.objectStore(IMAGE_STORE).delete(surface);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		});
	} catch {
		// best-effort
	}
}

// Per-window object URLs for the current image Blobs. Recreated at startup and
// whenever the image changes; revoked when replaced so they don't leak.
const objectUrls: Partial<Record<BackgroundSurface, string>> = {};

function setObjectUrl(surface: BackgroundSurface, blob: Blob | null): string {
	const previous = objectUrls[surface];
	if (previous) {
		URL.revokeObjectURL(previous);
	}
	if (!blob) {
		delete objectUrls[surface];
		return "";
	}
	const url = URL.createObjectURL(blob);
	objectUrls[surface] = url;
	return url;
}

// --- Config (localStorage) -------------------------------------------------

const gradientStop = z.object({ color: z.string(), position: z.number() });
const storedBackground = z
	.object({
		backdropBlur: z.number(),
		gradientAngle: z.number(),
		gradientEnabled: z.boolean(),
		gradientStops: z
			.array(gradientStop.nullable().catch(null))
			.optional()
			.catch(undefined),
		imageEnabled: z.boolean(),
		imageFit: z.enum(["cover", "contain", "fill", "center", "tile"]),
		imageScale: z.number(),
		imageSrc: z.string(),
		overlayColor: z.string(),
		overlayOpacity: z.number(),
		transparency: z.number(),
		gradientFrom: z.string(),
		gradientTo: z.string(),
	})
	.partial();

function normalize(
	value: z.output<typeof storedBackground> | null
): SurfaceBackground {
	const base = { ...DEFAULT_SURFACE_BACKGROUND };
	if (!value) {
		return base;
	}
	const merged: SurfaceBackground = {
		...base,
		...value,
		gradientStops: base.gradientStops,
	};
	const legacy = value;
	// Migrate the legacy two-stop shape (gradientFrom/gradientTo) and drop any
	// malformed stop arrays left in storage. Check `value.gradientStops` — NOT
	// `merged.gradientStops`, which falls back to the default two-stop array
	// whenever the key is absent.
	const storedStops = Array.isArray(value.gradientStops)
		? value.gradientStops
		: null;
	if (!storedStops || storedStops.length < 2) {
		merged.gradientStops = [
			{
				color: legacy.gradientFrom ?? base.gradientStops[0].color,
				position: 0,
			},
			{
				color: legacy.gradientTo ?? base.gradientStops[1].color,
				position: 100,
			},
		];
	} else {
		merged.gradientStops = storedStops
			.filter((stop) => stop !== null)
			.map((s) => ({ color: s.color, position: s.position }));
		if (merged.gradientStops.length < 2) {
			merged.gradientStops = [...base.gradientStops];
		}
	}
	return merged;
}

/**
 * The current config for a surface. `imageSrc` is filled from the live object
 * URL (set by init or a pick), never from localStorage.
 */
export function loadSurfaceBackground(
	surface: BackgroundSurface
): SurfaceBackground {
	let config: SurfaceBackground;
	try {
		const raw = localStorage.getItem(STORAGE_KEYS[surface]);
		config = raw
			? normalize(storedBackground.parse(JSON.parse(raw)))
			: { ...DEFAULT_SURFACE_BACKGROUND };
	} catch {
		config = { ...DEFAULT_SURFACE_BACKGROUND };
	}
	config.imageSrc = objectUrls[surface] ?? "";
	return config;
}

function persistConfig(surface: BackgroundSurface, bg: SurfaceBackground) {
	// Never persist the runtime object URL — it is per-window and recreated from
	// the IndexedDB Blob at startup.
	const { imageSrc: _omit, ...rest } = bg;
	try {
		localStorage.setItem(STORAGE_KEYS[surface], JSON.stringify(rest));
	} catch {
		// Config is tiny; a failure here is unexpected and non-fatal.
	}
}

// --- CSS application -------------------------------------------------------

/** Upper bound of the backdrop blur slider, in px. */
export const MAX_BACKDROP_BLUR = 60;

const HEX_COLOR_REGEX = /^#?([0-9a-fA-F]{6})$/;
const BYTE_MODULO = 256;
const RED_DIVISOR = 65_536;
const GREEN_DIVISOR = 256;

function hexToRgba(hex: string, alpha: number): string {
	const match = HEX_COLOR_REGEX.exec(hex.trim());
	if (!match) {
		return `rgba(0, 0, 0, ${alpha})`;
	}
	const int = Number.parseInt(match[1], 16);
	const r = Math.floor(int / RED_DIVISOR) % BYTE_MODULO;
	const g = Math.floor(int / GREEN_DIVISOR) % BYTE_MODULO;
	const b = int % BYTE_MODULO;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function imageLayerSize(fit: BackgroundFit, scale: number): string {
	if (fit === "cover") {
		return "cover";
	}
	if (fit === "contain") {
		return "contain";
	}
	if (fit === "fill") {
		return "100% 100%";
	}
	// center + tile are scaled by the scale slider.
	return `${scale}%`;
}

interface BackgroundLayers {
	image: string;
	position: string;
	repeat: string;
	size: string;
}

// Build the parallel comma-separated CSS background lists. Layer order is
// top-to-bottom: overlay tint → image → gradient → (solid theme color shows
// through any transparency). Returns null when nothing is enabled.
function buildLayers(bg: SurfaceBackground): BackgroundLayers | null {
	const images: string[] = [];
	const sizes: string[] = [];
	const repeats: string[] = [];
	const positions: string[] = [];

	const hasImage = bg.imageEnabled && bg.imageSrc.length > 0;

	if (hasImage && bg.overlayOpacity > 0) {
		const tint = hexToRgba(bg.overlayColor, bg.overlayOpacity / 100);
		images.push(`linear-gradient(${tint}, ${tint})`);
		sizes.push("cover");
		repeats.push("no-repeat");
		positions.push("center");
	}

	if (hasImage) {
		images.push(`url("${bg.imageSrc}")`);
		sizes.push(imageLayerSize(bg.imageFit, bg.imageScale));
		repeats.push(bg.imageFit === "tile" ? "repeat" : "no-repeat");
		positions.push(bg.imageFit === "tile" ? "top left" : "center");
	}

	if (bg.gradientEnabled) {
		images.push(buildGradientCss(bg.gradientStops, bg.gradientAngle));
		sizes.push("cover");
		repeats.push("no-repeat");
		positions.push("center");
	}

	if (images.length === 0) {
		return null;
	}

	return {
		image: images.join(", "),
		size: sizes.join(", "),
		repeat: repeats.join(", "),
		position: positions.join(", "),
	};
}

function applySurface(surface: BackgroundSurface, bg: SurfaceBackground) {
	appliedBackgrounds[surface] = bg;
	const root = document.documentElement.style;
	const prefix = CSS_VAR_PREFIX[surface];
	const layers = buildLayers(bg);
	if (layers) {
		root.setProperty(`${prefix}-image`, layers.image);
		root.setProperty(`${prefix}-size`, layers.size);
		root.setProperty(`${prefix}-repeat`, layers.repeat);
		root.setProperty(`${prefix}-position`, layers.position);
	} else {
		root.removeProperty(`${prefix}-image`);
		root.removeProperty(`${prefix}-size`);
		root.removeProperty(`${prefix}-repeat`);
		root.removeProperty(`${prefix}-position`);
	}
	// Effects apply to the background layer as a whole (via the ::before the
	// CSS paints the vars on), so they stay set even when no layer is enabled —
	// a plain translucent/blurred theme color is a valid frosted surface.
	root.setProperty(
		`${prefix}-opacity`,
		`${1 - clampOpacity(bg.transparency) / 100}`
	);
	root.setProperty(`${prefix}-blur`, `${clampBlur(bg.backdropBlur)}px`);
	syncActiveState();
}

function clampOpacity(v: number): number {
	return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
}

function clampBlur(v: number): number {
	return Math.max(0, Math.min(MAX_BACKDROP_BLUR, Number.isFinite(v) ? v : 0));
}

function surfaceIsActive(bg: SurfaceBackground): boolean {
	return (
		buildLayers(bg) !== null ||
		clampOpacity(bg.transparency) > 0 ||
		clampBlur(bg.backdropBlur) > 0
	);
}

// Last background applied per surface. applySurface runs before persistConfig,
// so re-reading storage there would see the previous value and drop the active
// flag; track the applied value directly instead.
const appliedBackgrounds: Partial<
	Record<BackgroundSurface, SurfaceBackground>
> = {};

// Mirror the active state onto <html> so CSS only routes surfaces through the
// ::before layer while a surface actually uses it — otherwise every surface
// would lose its own background-color.
function syncActiveState() {
	const active = (["sidebar", "page"] as const).some((surface) =>
		surfaceIsActive(
			appliedBackgrounds[surface] ?? loadSurfaceBackground(surface)
		)
	);
	const root = document.documentElement;
	if (active) {
		root.setAttribute("data-ryu-bg-active", "true");
	} else {
		root.removeAttribute("data-ryu-bg-active");
	}
}

// --- Public API ------------------------------------------------------------

let storageListenerAttached = false;

/** Apply both surfaces from storage. Call once at startup (App.tsx). */
export function initBackgroundCustomization() {
	// Gradients + config apply synchronously; images fill in once their Blobs
	// load from IndexedDB.
	applySurface("sidebar", loadSurfaceBackground("sidebar"));
	applySurface("page", loadSurfaceBackground("page"));

	for (const surface of ["sidebar", "page"] as const) {
		idbGetImage(surface).then((blob) => {
			if (!blob) {
				return;
			}
			setObjectUrl(surface, blob);
			applySurface(surface, loadSurfaceBackground(surface));
			window.dispatchEvent(new Event(BG_CHANGE_EVENT));
		});
	}

	// Re-apply config when another window mutates it (gradients/toggles). Image
	// Blobs live in shared IndexedDB but object URLs are per-window, so the image
	// itself doesn't cross windows live — that's acceptable for a customization.
	if (!storageListenerAttached) {
		storageListenerAttached = true;
		window.addEventListener("storage", (e) => {
			if (e.key === STORAGE_KEYS.sidebar) {
				applySurface("sidebar", loadSurfaceBackground("sidebar"));
			} else if (e.key === STORAGE_KEYS.page) {
				applySurface("page", loadSurfaceBackground("page"));
			}
		});
	}
}

/** Persist + live-apply a surface's config (gradient/fit/overlay/toggles). */
export function setSurfaceBackground(
	surface: BackgroundSurface,
	bg: SurfaceBackground
) {
	applySurface(surface, bg);
	persistConfig(surface, bg);
	window.dispatchEvent(new Event(BG_CHANGE_EVENT));
}

/**
 * Store a picked image (any size — bytes go to IndexedDB), enable the image
 * layer, and apply it. Returns the resolved config, or null if the store
 * failed.
 */
export async function setSurfaceImage(
	surface: BackgroundSurface,
	file: Blob
): Promise<SurfaceBackground | null> {
	const stored = await idbPutImage(surface, file);
	if (!stored) {
		return null;
	}
	setObjectUrl(surface, file);
	const next = { ...loadSurfaceBackground(surface), imageEnabled: true };
	setSurfaceBackground(surface, next);
	return next;
}

/** Remove the stored image for a surface. */
export async function clearSurfaceImage(
	surface: BackgroundSurface
): Promise<void> {
	await idbDeleteImage(surface);
	setObjectUrl(surface, null);
	setSurfaceBackground(surface, loadSurfaceBackground(surface));
}

export function resetBackgroundCustomization() {
	for (const surface of ["sidebar", "page"] as const) {
		try {
			localStorage.removeItem(STORAGE_KEYS[surface]);
		} catch {
			// ignore — clearing is best-effort
		}
		idbDeleteImage(surface);
		setObjectUrl(surface, null);
		applySurface(surface, { ...DEFAULT_SURFACE_BACKGROUND });
	}
	window.dispatchEvent(new Event(BG_CHANGE_EVENT));
}
