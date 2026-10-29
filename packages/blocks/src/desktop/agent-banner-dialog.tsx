"use client";
import {
	isNativeNumber,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type { CSSProperties } from "react";
import styles from "./agent-banner-dialog.module.css";

// packages/blocks/src/desktop/agent-banner-dialog.tsx
//
// Banner customisation for the agent editor's profile header: pick a STYLE (the
// generative dither wash, or one of the gradient presets), a COLOUR, and — for
// the dither style only — a direction.
//
// It used to be a strip of bare swatch dots floating on the banner itself. The
// original comment there said they sat on the banner "so the effect is visible
// while choosing", which is the one thing a dialog would otherwise cost — so the
// dialog carries a live preview of the real wash at banner proportions, and the
// controls sit under it. That buys back the visibility and drops the chrome that
// was permanently parked over the top-left corner of every unlocked agent.
//
// The preset list is NOT defined here. It comes from
// `@ryu/ui/components/banner-presets`, which is an adapter over
// `ANIMATED_GRADIENT_PRESETS` — the same shared table the marketplace's listing
// banners paint from. So a gradient added for a listing banner shows up in this
// dialog with no edit, and `prism` means one thing across the app. Nothing in
// this file switches on a preset id.
//
// The washes here are the shared table's STATIC paint, never its WebGL shader:
// a header plus a preview plus seven tiles would be nine GL contexts against a
// browser cap of ~16 that evicts the oldest, which is a known crash on this app.
// The `live` opt-in belongs to a detail hero; see the animated-gradient header.
//
// Prefs stay in localStorage, per agent, exactly as before: this is a purely
// cosmetic per-machine choice, and a Core schema change (plus migration and
// sync) buys nothing for it.

import { PaintBoardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	type RenderableBackdrop,
	resolveMarketplaceWallpaperSelection,
	toMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import {
	BANNER_COLORS,
	BANNER_DIRECTIONS,
	BANNER_PRESETS,
	type BannerColor,
	type BannerPreset,
	bannerGradientCss,
	bannerPresetById,
	DITHER_BANNER_PRESET_ID,
	isBannerPresetId,
} from "@ryu/ui/components/banner-presets";
import { Button } from "@ryu/ui/components/button";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
	ColorPickerTrigger,
} from "@ryu/ui/components/color-picker";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient";
import type { DitherColor } from "@ryu/ui/components/dither-kit/palette";
import { cn } from "@ryu/ui/lib/utils";
import {
	type MarketplaceWallpaperSelection,
	parseMarketplaceWallpaperSelection,
} from "@ryuhq/protocol/marketplace-wallpaper";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarketplaceWallpaperPickerDialog } from "./marketplace-wallpaper-picker.tsx";

/** The slab the wash is painted over — the banner's own base, so the dialog's
 *  preview is the real thing rather than an approximation of it. */
export const AGENT_BANNER_BASE =
	"linear-gradient(135deg, hsl(222 18% 7%), hsl(222 12% 13%) 58%, hsl(224 10% 22%))";

/** Swatch fills for the colour picker — indicative only for the dither style,
 *  whose real fill is a dithered canvas that cannot be shown in a 16px dot. */
const BANNER_SWATCHES = {
	purple: "#b497cf",
	blue: "#7aa2f7",
	green: "#9ece6a",
	pink: "#e39ac7",
	orange: "#e0a363",
	red: "#e06c75",
	grey: "#9aa0a6",
} satisfies Record<DitherColor, string>;

/** Stable 32-bit hash of a string — same seed in, same banner out. */
function bannerHash(seed: string): number {
	let h = 2_166_136_261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16_777_619);
	}
	return Math.abs(h);
}

/**
 * The user's banner override for one agent. Every field is optional: with none
 * of them set the deterministic per-name default applies, so every agent has a
 * sensible banner without anyone ever opening this dialog.
 */
export interface AgentBannerPrefs {
	/** A palette name, or a HUE (0–360) for a custom colour. `DitherGradient`'s
	 *  `from` is `DitherColor | number`, and the gradient presets take a base hue,
	 *  so one field drives both styles. */
	color?: BannerColor;
	direction?: GradientDirection;
	/** A `BANNER_PRESETS` id. Absent = the dither default. */
	preset?: string;
	/** Safe Marketplace choice rendered through a built-in host adapter. */
	wallpaper?: MarketplaceWallpaperSelection;
}

export interface AgentBannerPreferenceStore {
	get: (agentId: string) => Promise<string | null>;
	set: (agentId: string, value: string) => Promise<void>;
}

/** Hex (#rrggbb) → hue, so the shared color picker can drive the wash. Only the
 *  hue is kept: saturation and lightness come from the style itself, which is
 *  what keeps a custom colour looking like part of the same system. */
function hexToHue(hex: string): number {
	const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
	if (!m?.[1]) {
		return 0;
	}
	const n = Number.parseInt(m[1], 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) {
		return 0;
	}
	let h: number;
	if (max === r) {
		h = ((g - b) / d) % 6;
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	return Math.round((((h * 60) % 360) + 360) % 360);
}

/** Hue → hex, so the colour input shows the currently-selected custom hue. */
function bannerSwatchHex(color: BannerColor): string {
	return isNativeNumber(color) ? hueToHex(color) : BANNER_SWATCHES[color];
}

function hueToHex(hue: number): string {
	const h = ((hue % 360) + 360) % 360;
	const s = 0.85;
	const l = 0.58;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		h < 60
			? [c, x, 0]
			: h < 120
				? [x, c, 0]
				: h < 180
					? [0, c, x]
					: h < 240
						? [0, x, c]
						: h < 300
							? [x, 0, c]
							: [c, 0, x];
	const to = (v: number) =>
		Math.round((v + m) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${to(r)}${to(g)}${to(b)}`;
}

const bannerPrefsKey = (agent: string) => `ryu:agent-banner:${agent}`;

function isBannerColor<T>(value: T): value is T & BannerColor {
	return (
		(isNativeNumber(value) &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= 360) ||
		(isNativeText(value) && BANNER_COLORS.some((color) => color === value))
	);
}

function isBannerDirection<T>(value: T): value is T & GradientDirection {
	return BANNER_DIRECTIONS.some((direction) => direction === value);
}

/** Native JSON object domain from the complete shared raw tree owner. Arrays
 * and primitives still take the existing empty-preference fallback. */
type StoredBannerJsonObject = Exclude<
	Extract<AppResponseValue, object>,
	readonly AppResponseValue[]
>;

function isRecord(value: AppResponseValue): value is StoredBannerJsonObject {
	return isNativeObjectLike(value) && !Array.isArray(value);
}

function parseAgentBannerPrefs(value: AppResponseValue): AgentBannerPrefs {
	if (!isRecord(value)) {
		return {};
	}
	const prefs: AgentBannerPrefs = {};
	if (isBannerColor(value.color)) {
		prefs.color = value.color;
	}
	if (isBannerDirection(value.direction)) {
		prefs.direction = value.direction;
	}
	if (isNativeText(value.preset) && isBannerPresetId(value.preset)) {
		prefs.preset = value.preset;
	}
	const wallpaper = parseMarketplaceWallpaperSelection(value.wallpaper);
	if (wallpaper) {
		prefs.wallpaper = wallpaper;
	}
	return prefs;
}

function readAgentBannerPrefs(raw: string | null): AgentBannerPrefs {
	if (!raw) {
		return {};
	}
	try {
		const parsed = appResponseValueSchema.parse(JSON.parse(raw));
		return parseAgentBannerPrefs(parsed);
	} catch {
		return {};
	}
}

/**
 * Read one agent's stored banner prefs, dropping any field this build cannot
 * paint.
 *
 * The dropping is load-bearing, not defensive dressing: a stale `color` string
 * that isn't a palette swatch reaches `fillOf` → `PALETTE[color].fill`, which
 * THROWS during canvas paint and takes the whole editor down on open. An unknown
 * `preset` id is the same bug class one layer up. Both fall back to the derived
 * default instead.
 */
export function loadAgentBannerPrefs(agent: string): AgentBannerPrefs {
	try {
		const raw = localStorage.getItem(bannerPrefsKey(agent));
		return readAgentBannerPrefs(raw);
	} catch {
		// Corrupt or unavailable storage must never break the editor.
		return {};
	}
}

export function saveAgentBannerPrefs(
	agent: string,
	prefs: AgentBannerPrefs
): void {
	try {
		localStorage.setItem(bannerPrefsKey(agent), JSON.stringify(prefs));
	} catch {
		// Non-fatal: the banner falls back to the derived default next load.
	}
}

/** The prefs for one agent, loaded once per name and written through on change.
 *  Instant-apply — there is no Save button, so the preview and the banner behind
 *  the dialog move together. */
export function useAgentBannerPrefs(
	agent: string,
	store?: AgentBannerPreferenceStore,
	legacyAgent = agent
) {
	const [prefs, setPrefs] = useState<AgentBannerPrefs>(() =>
		store ? {} : loadAgentBannerPrefs(agent)
	);
	const [storageError, setStorageError] = useState<string | null>(null);
	const [loading, setLoading] = useState(Boolean(store));
	const prefsRef = useRef(prefs);

	useEffect(() => {
		let current = true;
		setLoading(Boolean(store));
		if (!store) {
			const next = loadAgentBannerPrefs(agent);
			prefsRef.current = next;
			setPrefs(next);
			setStorageError(null);
			setLoading(false);
			return () => {
				current = false;
			};
		}
		setStorageError(null);
		void (async () => {
			try {
				const raw = await store.get(agent);
				let next: AgentBannerPrefs;
				if (raw === null) {
					next = loadAgentBannerPrefs(legacyAgent);
					if (Object.keys(next).length > 0) {
						await store.set(agent, JSON.stringify(next));
					}
				} else {
					next = readAgentBannerPrefs(raw);
				}
				if (current) {
					prefsRef.current = next;
					setPrefs(next);
					setLoading(false);
				}
			} catch {
				if (current) {
					prefsRef.current = {};
					setPrefs({});
					setStorageError(
						"Agent banner preferences could not be read from this node."
					);
					setLoading(false);
				}
			}
		})();
		return () => {
			current = false;
		};
	}, [agent, legacyAgent, store]);

	const update = useCallback(
		async (next: AgentBannerPrefs): Promise<boolean> => {
			const merged = { ...prefsRef.current, ...next };
			if (Object.hasOwn(next, "wallpaper") && next.wallpaper === undefined) {
				merged.wallpaper = undefined;
			}
			try {
				if (store) {
					await store.set(agent, JSON.stringify(merged));
				} else {
					saveAgentBannerPrefs(agent, merged);
				}
				prefsRef.current = merged;
				setPrefs(merged);
				setStorageError(null);
				return true;
			} catch {
				setStorageError(
					"Agent banner preferences could not be saved to this node."
				);
				return false;
			}
		},
		[agent, store]
	);

	const reset = useCallback(async (): Promise<boolean> => {
		try {
			if (store) {
				await store.set(agent, "{}");
			} else {
				saveAgentBannerPrefs(agent, {});
			}
			prefsRef.current = {};
			setPrefs({});
			setStorageError(null);
			return true;
		} catch {
			setStorageError(
				"Agent banner preferences could not be saved to this node."
			);
			return false;
		}
	}, [agent, store]);

	return { error: storageError, loading, prefs, reset, update };
}

/** Everything needed to paint one banner, with every default already resolved. */
export interface ResolvedAgentBanner {
	color: BannerColor;
	direction: GradientDirection;
	preset: BannerPreset;
}

/**
 * Fold the stored prefs (and any explicit prop override) onto the per-agent
 * deterministic default. "Random" here means DETERMINISTICALLY random: colour
 * and direction are derived from the agent name, so every agent gets a different
 * wash but the same agent looks the same on every render and every machine.
 */
export function resolveAgentBanner(
	agent: string,
	prefs: AgentBannerPrefs,
	overrides?: { color?: BannerColor; direction?: GradientDirection }
): ResolvedAgentBanner {
	const color =
		overrides?.color ??
		prefs.color ??
		BANNER_COLORS[bannerHash(agent) % BANNER_COLORS.length];
	const direction =
		overrides?.direction ??
		prefs.direction ??
		BANNER_DIRECTIONS[bannerHash(`${agent}:dir`) % BANNER_DIRECTIONS.length];
	const preset =
		bannerPresetById(prefs.preset) ??
		bannerPresetById(DITHER_BANNER_PRESET_ID) ??
		BANNER_PRESETS[0];
	if (color === undefined || direction === undefined || preset === undefined) {
		throw new Error("Agent banner presets are unavailable");
	}
	return { color, direction, preset };
}

/**
 * The wash itself — the single painter for every banner surface, so the header,
 * the dialog preview, and the style tiles cannot disagree about what a preset
 * looks like. A gradient preset paints as CSS; the dither preset paints on
 * dither-kit's canvas.
 */
interface BannerPaintStyle extends CSSProperties {
	"--agent-banner-opacity"?: number;
	"--agent-banner-paint"?: string;
	"--agent-banner-swatch"?: string;
}
export function AgentBannerWash({
	banner,
	className,
	opacity = 0.55,
}: {
	banner: ResolvedAgentBanner;
	className?: string;
	opacity?: number;
}) {
	const gradient = bannerGradientCss(banner.preset, banner.color);
	if (gradient) {
		return (
			<div
				aria-hidden
				className={cn("absolute inset-0", styles.wash, className)}
				style={
					{
						"--agent-banner-paint": gradient,
						"--agent-banner-opacity": opacity,
					} satisfies BannerPaintStyle as BannerPaintStyle
				}
			/>
		);
	}
	return (
		<DitherGradient
			className={cn("absolute inset-0", className)}
			direction={banner.direction}
			from={banner.color}
			opacity={opacity}
		/>
	);
}

/** Feather the profile banner into the card surface below it. */
export function AgentProfileBannerFade() {
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card via-card/70 to-transparent"
		/>
	);
}

function FieldLabel({ children }: { children: string }) {
	return <h4 className="font-medium text-foreground/70 text-xs">{children}</h4>;
}

/**
 * The customisation dialog. Opened from the banner; every change applies (and
 * persists) immediately, so the footer closes rather than commits.
 */
export function AgentBannerDialog({
	agent,
	marketplaceWallpapers,
	prefs,
	onInstallWallpaper,
	onReset,
	onUpdate,
	storageError,
	loading,
}: {
	/** Stable agent id, or the name in a storyboard without persisted ids. */
	agent: string;
	marketplaceWallpapers: readonly RenderableBackdrop[];
	onInstallWallpaper?: (
		wallpaper: RenderableBackdrop
	) => boolean | Promise<boolean>;
	onReset: () => Promise<boolean>;
	onUpdate: (next: AgentBannerPrefs) => Promise<boolean>;
	prefs: AgentBannerPrefs;
	storageError?: string | null;
	loading?: boolean;
}) {
	const banner = resolveAgentBanner(agent, prefs);
	const isDither = banner.preset.kind === "dither";
	const customHue = isNativeNumber(banner.color) ? banner.color : null;
	const [wallpaperPickerOpen, setWallpaperPickerOpen] = useState(false);
	const selectedWallpaper = parseMarketplaceWallpaperSelection(prefs.wallpaper);
	const renderedWallpaper = resolveMarketplaceWallpaperSelection(
		prefs.wallpaper
	);
	const updateStyle = (next: AgentBannerPrefs) =>
		onUpdate({ ...next, wallpaper: undefined });

	return (
		<>
			<Dialog>
				<DialogTrigger
					render={
						<Button
							appearance="banner-customize"
							disabled={loading}
							size="sm"
							variant="ghost"
						/>
					}
				>
					<HugeiconsIcon className="size-3.5" icon={PaintBoardIcon} />
					Customize
				</DialogTrigger>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Banner</DialogTitle>
						<DialogDescription>
							Choose a style or Marketplace wallpaper. Once the agent is saved,
							its banner is shared across devices connected to this node.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-4">
						{/* The real wash at banner proportions — the whole reason the swatch
					    strip used to live on the banner. */}
						<div
							className={cn(
								"relative h-24 overflow-hidden rounded-lg",
								styles.base
							)}
							data-testid="banner-preview"
						>
							{renderedWallpaper ? (
								<Backdrop
									className="absolute inset-0"
									definition={renderedWallpaper}
									live={false}
									params={renderedWallpaper.initialParams}
								/>
							) : (
								<AgentBannerWash banner={banner} />
							)}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								onClick={() => setWallpaperPickerOpen(true)}
								size="sm"
								variant="outline"
							>
								Browse Marketplace wallpapers
							</Button>
							{selectedWallpaper ? (
								<Button
									onClick={() => updateStyle({ wallpaper: undefined })}
									size="sm"
									variant="ghost"
								>
									Use banner style
								</Button>
							) : null}
						</div>
						{storageError ? (
							<p className="text-sm text-status-destructive" role="alert">
								{storageError}
							</p>
						) : null}

						<div className="flex flex-col gap-2">
							<FieldLabel>Style</FieldLabel>
							{/* Fixed column count, not `auto-fill`: the tiles are previews and
						    have to stay wide enough to read as one, so a longer preset
						    table wraps to another row rather than shrinking every tile. */}
							<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
								{BANNER_PRESETS.map((preset) => {
									const active = preset.id === banner.preset.id;
									return (
										<button
											aria-pressed={active}
											className={cn(
												"flex flex-col gap-1 rounded-lg p-1 text-left transition-colors",
												active ? "bg-accent" : "hover:bg-accent/50"
											)}
											data-testid="banner-style-tile"
											key={preset.id}
											onClick={() => updateStyle({ preset: preset.id })}
											type="button"
										>
											<span
												className={cn(
													"relative block h-10 overflow-hidden rounded-md ring-1 ring-inset",
													styles.base,
													active ? "ring-primary" : "ring-border"
												)}
											>
												<AgentBannerWash
													banner={{ ...banner, preset }}
													opacity={0.8}
												/>
											</span>
											<span className="type-caption truncate px-0.5 text-muted-foreground">
												{preset.label}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						<div className="flex flex-col gap-2">
							<FieldLabel>Colour</FieldLabel>
							<div className="flex items-center gap-2">
								{BANNER_COLORS.map((c) => (
									<button
										aria-label={`Banner colour ${c}`}
										aria-pressed={banner.color === c}
										className={cn(
											"size-6 rounded-full border transition-transform hover:scale-110",
											styles.swatch,
											banner.color === c
												? "border-foreground ring-2 ring-primary"
												: "border-border"
										)}
										key={c}
										onClick={() => updateStyle({ color: c })}
										style={
											{
												"--agent-banner-swatch": BANNER_SWATCHES[c],
											} satisfies BannerPaintStyle as BannerPaintStyle
										}
										type="button"
									/>
								))}
								{/* Custom colour: any hue, not just the six presets. Stored as a
							    number, which both styles accept directly. */}
								<ColorPicker
									onValueChange={(value) =>
										updateStyle({ color: hexToHue(value) })
									}
									swatches={Object.values(BANNER_SWATCHES)}
									value={customHue === null ? "#b497cf" : hueToHex(customHue)}
								>
									<ColorPickerTrigger
										aria-label="Custom banner colour"
										render={
											<button
												className={cn(
													"corner-squircle inline-flex size-6 min-w-12 items-center justify-center gap-2 border bg-background text-foreground hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50",
													styles.customHue,
													customHue !== null && styles.customHueSelected
												)}
												type="button"
											/>
										}
									>
										<span
											aria-hidden="true"
											className={cn(
												"corner-squircle size-5 shrink-0 rounded-sm border border-foreground/15",
												styles.customHuePaint
											)}
											style={
												{
													"--agent-banner-swatch": bannerSwatchHex(
														customHue ?? "purple"
													),
												} satisfies BannerPaintStyle as BannerPaintStyle
											}
										/>
									</ColorPickerTrigger>
									<ColorPickerContent>
										<ColorPickerPanel />
									</ColorPickerContent>
								</ColorPicker>
							</div>
						</div>

						{/* Direction is a dither-only control: a gradient preset carries its
					    own angle, and offering a direction that does nothing would read
					    as a broken control. */}
						{isDither ? (
							<div className="flex flex-col gap-2">
								<FieldLabel>Direction</FieldLabel>
								<div className="flex items-center gap-1.5">
									{BANNER_DIRECTIONS.map((d) => (
										<button
											aria-pressed={banner.direction === d}
											className={cn(
												"rounded-md px-2.5 py-1 text-xs capitalize transition-colors",
												banner.direction === d
													? "bg-primary text-primary-foreground"
													: "bg-muted text-muted-foreground hover:bg-accent"
											)}
											key={d}
											onClick={() => updateStyle({ direction: d })}
											type="button"
										>
											{d}
										</button>
									))}
								</div>
							</div>
						) : null}
					</div>

					<DialogFooter>
						<Button onClick={onReset} size="sm" variant="ghost">
							Reset to default
						</Button>
						<DialogClose render={<Button size="sm" />}>Done</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<MarketplaceWallpaperPickerDialog
				onOpenChange={setWallpaperPickerOpen}
				onSelect={async (wallpaper) => {
					if (onInstallWallpaper && !(await onInstallWallpaper(wallpaper))) {
						return false;
					}
					return (
						(await onUpdate({
							wallpaper: toMarketplaceWallpaperSelection(wallpaper),
						})) !== false
					);
				}}
				open={wallpaperPickerOpen}
				selectedId={selectedWallpaper?.id}
				title="Choose an agent banner wallpaper"
				wallpapers={marketplaceWallpapers}
			/>
		</>
	);
}
