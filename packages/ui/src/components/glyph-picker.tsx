"use client";

import styles from "./glyph-picker.module.css";

/**
 * Shared glyph picker — the single primitive for picking an entity icon /
 * avatar across the product (agents, project folders, spaces, pages, meetings).
 *
 * Allowed kinds are decided here via {@link GLYPH_PRESETS} (or an explicit
 * allowlist). The canonical set is avatar · icon · emoji · dicebear; agents
 * additionally allow expressive ghost faces, marketplace avatar styles (shown
 * only when an enabled plugin contributes one), and a standalone dither gradient.
 * Icons and emojis can also take dither as an optional *background* layer
 * (DiceBear and expressive faces cannot).
 */

import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { useAvatarContributions } from "@ryu/ui/components/avatar-contributions.tsx";
import {
	AvatarStyleControls,
	defaultAvatarStyleValue,
} from "@ryu/ui/components/avatar-style-controls.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient.tsx";
import {
	type DitherColor,
	isDitherColor,
	PALETTE,
	rgb,
} from "@ryu/ui/components/dither-kit/palette.ts";
import { EXPRESSIVE_EXPRESSION_OPTIONS } from "@ryu/ui/components/expressive.ts";
import { EXPRESSIVE_ANIMATION_OPTIONS } from "@ryu/ui/components/expressive-animation.ts";
import {
	DEFAULT_DICEBEAR_STYLE,
	DICEBEAR_STYLES,
	dicebearStyleLabel,
	dicebearUrl,
	GLYPH_ICON_COLORS,
	type GlyphDitherValue,
	type GlyphIconHit,
	type GlyphKind,
	type GlyphPresetName,
	type GlyphValue,
	glyphDitherOf,
	randomDicebearSeed,
	resolveGlyphKinds,
	searchGlyphIcons,
	tabForGlyphValue,
} from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Slider } from "@ryu/ui/components/slider.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	Dices,
	ImagePlus,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import type { GhostAvatarAppearance } from "./ghost-avatar.ts";
import { GhostAvatarControls } from "./ghost-avatar-controls.tsx";

interface GlyphPickerDrawingStyle extends CSSProperties {
	"--glyph-picker-square-size"?: string;
	"--glyph-picker-swatch-color"?: string;
}

interface Dimensions {
	height: number;
	width: number;
}

export interface GlyphPickerProps {
	/**
	 * Allowed kinds, or a {@link GlyphPresetName} (`"entity"` | `"agent"`).
	 * Defaults to `"entity"` — avatar, icon, emoji, dicebear.
	 */
	allowed?: readonly GlyphKind[] | GlyphPresetName;
	className?: string;
	/** Show a clear/remove affordance when a value is set. Default true. */
	clearable?: boolean;
	/** Optional description under the title (e.g. the entity name). */
	description?: string;
	disabled?: boolean;
	/** Shown when no custom glyph is set (engine logo, folder icon, …). */
	fallback?: ReactNode;
	/** Called with the picked glyph, or null when cleared. */
	onChange: (value: GlyphValue) => void;
	/**
	 * Controlled open state. When omitted the picker owns its own dialog and
	 * renders a clickable preview trigger (agent-field style). When provided,
	 * only the dialog is rendered (sidebar "Change icon…" style).
	 */
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	/** Edge length of the resting preview trigger in px. */
	previewSize?: number;
	/** Dialog title. */
	title?: string;
	value: GlyphValue;
}

const OUTPUT_SIZE = 256;
const MAX_ZOOM = 3;

const DITHER_COLORS: DitherColor[] = [
	"green",
	"blue",
	"purple",
	"pink",
	"orange",
	"red",
	"grey",
];

const DIRECTION_OPTIONS: {
	value: GradientDirection;
	label: string;
	Icon: typeof ArrowUp;
}[] = [
	{ value: "up", label: "Up", Icon: ArrowUp },
	{ value: "down", label: "Down", Icon: ArrowDown },
	{ value: "left", label: "Left", Icon: ArrowLeft },
	{ value: "right", label: "Right", Icon: ArrowRight },
];

const DEFAULT_DITHER: GlyphDitherValue = {
	from: "green",
	to: null,
	direction: "up",
};

/** Compact dither controls used as a background layer under icon/emoji. */
function DitherLayerControls({
	dither,
	onChange,
	enabled,
	onEnabledChange,
	showToggle,
}: {
	dither: GlyphDitherValue;
	enabled: boolean;
	onChange: (next: GlyphDitherValue) => void;
	onEnabledChange: (enabled: boolean) => void;
	/** When false, controls always apply (standalone dither tab). */
	showToggle: boolean;
}) {
	return (
		<div className="space-y-3 rounded-lg border border-border p-3">
			{showToggle ? (
				<button
					aria-pressed={enabled}
					className={cn(
						"flex w-full items-center justify-between rounded-md px-1 py-0.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
					)}
					onClick={() => onEnabledChange(!enabled)}
					type="button"
				>
					<span className="font-medium text-xs">Dither background</span>
					<span
						className={cn(
							"type-compact rounded-full px-2 py-0.5 uppercase tracking-wide",
							enabled
								? "bg-foreground text-background"
								: "bg-muted text-muted-foreground"
						)}
					>
						{enabled ? "On" : "Off"}
					</span>
				</button>
			) : (
				<span className="font-medium text-muted-foreground text-xs">
					Dither
				</span>
			)}

			{(!showToggle || enabled) && (
				<>
					<div className="space-y-1.5">
						<span className="text-muted-foreground text-xs">Colour</span>
						<div className="flex flex-wrap gap-2">
							{DITHER_COLORS.map((color) => {
								const swatchStyle: GlyphPickerDrawingStyle = {
									"--glyph-picker-swatch-color": rgb(PALETTE[color].fill),
								};
								return (
									<button
										aria-label={color}
										aria-pressed={dither.from === color}
										className={cn(
											"size-7 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
											styles.colorSwatch,
											dither.from === color
												? "ring-2 ring-foreground"
												: "ring-1 ring-border"
										)}
										key={color}
										onClick={() => onChange({ ...dither, from: color })}
										style={swatchStyle}
										type="button"
									/>
								);
							})}
						</div>
					</div>

					<div className="space-y-1.5">
						<span className="text-muted-foreground text-xs">
							Blend to (optional)
						</span>
						<div className="flex flex-wrap items-center gap-2">
							<button
								aria-label="Fade to transparent"
								aria-pressed={dither.to === null}
								className={cn(
									"flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
									dither.to === null
										? "ring-2 ring-foreground"
										: "ring-1 ring-border"
								)}
								onClick={() => onChange({ ...dither, to: null })}
								type="button"
							>
								<X className="size-3.5" />
							</button>
							{DITHER_COLORS.map((color) => {
								const swatchStyle: GlyphPickerDrawingStyle = {
									"--glyph-picker-swatch-color": rgb(PALETTE[color].fill),
								};
								return (
									<button
										aria-label={`Blend to ${color}`}
										aria-pressed={dither.to === color}
										className={cn(
											"size-7 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
											styles.colorSwatch,
											dither.to === color
												? "ring-2 ring-foreground"
												: "ring-1 ring-border"
										)}
										key={color}
										onClick={() => onChange({ ...dither, to: color })}
										style={swatchStyle}
										type="button"
									/>
								);
							})}
						</div>
					</div>

					<div className="space-y-1.5">
						<span className="text-muted-foreground text-xs">Direction</span>
						<div className="flex gap-2">
							{DIRECTION_OPTIONS.map((opt) => (
								<button
									aria-label={opt.label}
									aria-pressed={dither.direction === opt.value}
									className={cn(
										"flex size-8 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
										dither.direction === opt.value
											? "bg-foreground text-background"
											: "bg-muted text-muted-foreground hover:bg-muted/70"
									)}
									key={opt.value}
									onClick={() => onChange({ ...dither, direction: opt.value })}
									type="button"
								>
									<opt.Icon className="size-4" />
								</button>
							))}
						</div>
					</div>
				</>
			)}
		</div>
	);
}

const TAB_LABEL = {
	avatar: "Upload",
	icon: "Icon",
	emoji: "Emoji",
	dicebear: "DiceBear",
	expressive: "Expressive",
	avatar_style: "Styles",
	dither: "Dither",
} satisfies Record<GlyphKind, string>;

const loadImage = (url: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.addEventListener("load", () => resolve(image));
		image.addEventListener("error", reject);
		image.src = url;
	});

async function cropToDataUrl(
	imageSrc: string,
	zoom: number,
	mime: "image/jpeg" | "image/png" = "image/jpeg"
): Promise<string | null> {
	const image = await loadImage(imageSrc);
	const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
	const sx = (image.naturalWidth - side) / 2;
	const sy = (image.naturalHeight - side) / 2;

	const canvas = document.createElement("canvas");
	canvas.width = OUTPUT_SIZE;
	canvas.height = OUTPUT_SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.drawImage(image, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
	return canvas.toDataURL(mime, mime === "image/jpeg" ? 0.9 : undefined);
}

interface EmojiSelectPayload {
	native?: string;
}

/**
 * Unified glyph picker dialog (+ optional clickable preview trigger).
 *
 * Prefer this over bespoke emoji grids / icon text fields so every surface
 * offers the same avatar · icon · emoji · dicebear options.
 */
export function GlyphPicker({
	value,
	onChange,
	fallback,
	disabled = false,
	className,
	title = "Choose icon",
	description,
	allowed = "entity",
	previewSize = 40,
	clearable = true,
	open: openProp,
	onOpenChange: onOpenChangeProp,
}: GlyphPickerProps) {
	const avatarContributions = useAvatarContributions();
	const hasAvatarStyles = avatarContributions.styles.length > 0;
	const allowedKinds = resolveGlyphKinds(allowed);
	// Marketplace styles get a tab only when an enabled plugin contributes one,
	// or when the current value already uses one (so it stays editable).
	const keepStyleTab = hasAvatarStyles || value?.kind === "avatar_style";
	const kinds = useMemo(
		() =>
			keepStyleTab
				? allowedKinds
				: allowedKinds.filter((kind) => kind !== "avatar_style"),
		[allowedKinds, keepStyleTab]
	);
	const controlled = openProp !== undefined;
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const isDialogOpen = controlled ? Boolean(openProp) : uncontrolledOpen;
	const setIsDialogOpen = useCallback(
		(next: boolean) => {
			if (!controlled) {
				setUncontrolledOpen(next);
			}
			onOpenChangeProp?.(next);
		},
		[controlled, onOpenChangeProp]
	);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const [tab, setTab] = useState<GlyphKind>(kinds[0] ?? "avatar");

	// Upload / crop
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [rendered, setRendered] = useState<Dimensions | null>(null);
	const [zoom, setZoom] = useState(1);

	// Icon
	const [iconQuery, setIconQuery] = useState("");
	const [iconDebounced, setIconDebounced] = useState("");
	const [iconHits, setIconHits] = useState<GlyphIconHit[]>([]);
	const [iconLoading, setIconLoading] = useState(false);
	const [iconError, setIconError] = useState<string | null>(null);
	const [iconDraft, setIconDraft] = useState("");
	const [iconColor, setIconColor] = useState<string | undefined>(undefined);

	// DiceBear
	const [diceStyle, setDiceStyle] = useState<string>(DEFAULT_DICEBEAR_STYLE);
	const [diceSeed, setDiceSeed] = useState(() => randomDicebearSeed());

	const [ghostAppearance, setGhostAppearance] = useState<GhostAvatarAppearance>(
		{ variant: "3d", bodyStyle: "orb", behavior: "custom" }
	);
	// Expressive ghost avatar
	const [expressiveSelection, setExpressiveSelection] =
		useState<Extract<GlyphValue, { kind: "expressive" }>["expression"]>(
			"random"
		);
	const [expressiveAnimationSelection, setExpressiveAnimationSelection] =
		useState<
			NonNullable<Extract<GlyphValue, { kind: "expressive" }>["animation"]>
		>("random");

	// Marketplace avatar style
	const [styleDraft, setStyleDraft] = useState<
		Extract<GlyphValue, { kind: "avatar_style" }>
	>(() => defaultAvatarStyleValue(avatarContributions.styles[0]?.id ?? ""));

	// Dither — standalone tab and/or background under icon/emoji
	const [dither, setDither] = useState<GlyphDitherValue>(DEFAULT_DITHER);
	const [ditherAsBg, setDitherAsBg] = useState(false);

	// Seed drafts from the current value whenever the dialog opens.
	useEffect(() => {
		if (!isDialogOpen) {
			return;
		}
		setTab(tabForGlyphValue(value, kinds));
		setPreviewUrl(null);
		setRendered(null);
		setZoom(1);
		setIconQuery("");
		setIconDebounced("");
		setIconError(null);
		if (value?.kind === "icon") {
			setIconDraft(value.id);
			setIconColor(value.color);
		} else {
			setIconDraft("");
			setIconColor(undefined);
		}
		if (value?.kind === "dicebear") {
			setDiceStyle(value.style);
			setDiceSeed(value.seed);
		} else {
			setDiceStyle(DEFAULT_DICEBEAR_STYLE);
			setDiceSeed(randomDicebearSeed());
		}
		if (value?.kind === "expressive") {
			setGhostAppearance({ ...value });
			setExpressiveSelection(value.expression);
			setExpressiveAnimationSelection(value.animation ?? "random");
		} else {
			setGhostAppearance({
				variant: "3d",
				bodyStyle: "orb",
				behavior: "custom",
			});
			setExpressiveSelection("random");
			setExpressiveAnimationSelection("random");
		}
		if (value?.kind === "avatar_style") {
			setStyleDraft({ ...value });
		} else {
			setStyleDraft(
				defaultAvatarStyleValue(avatarContributions.styles[0]?.id ?? "")
			);
		}
		const layered = glyphDitherOf(value);
		if (layered) {
			setDither({
				from: isDitherColor(layered.from) ? layered.from : "green",
				to: isDitherColor(layered.to) ? layered.to : null,
				direction: layered.direction,
			});
			setDitherAsBg(value?.kind === "icon" || value?.kind === "emoji");
		} else {
			setDither(DEFAULT_DITHER);
			setDitherAsBg(false);
		}
	}, [isDialogOpen, value, kinds, avatarContributions.styles]);

	// Debounce icon search.
	useEffect(() => {
		const t = setTimeout(() => setIconDebounced(iconQuery), 280);
		return () => clearTimeout(t);
	}, [iconQuery]);

	// Run Iconify search when the icon tab is active.
	useEffect(() => {
		if (!(isDialogOpen && tab === "icon")) {
			return;
		}
		let cancelled = false;
		setIconLoading(true);
		setIconError(null);
		searchGlyphIcons(iconDebounced)
			.then((hits) => {
				if (!cancelled) {
					setIconHits(hits);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setIconError("Couldn't load icons. Check your connection.");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIconLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [isDialogOpen, tab, iconDebounced]);

	const handleFileSelect = useCallback((file: File) => {
		const reader = new FileReader();
		reader.onload = (e) => {
			// SAFETY: this private reader's only operation is readAsDataURL(file)
			// below. FileReader's successful load event therefore exposes a data
			// URL string, not the ArrayBuffer produced by readAsArrayBuffer. The
			// original optional-target/null fallback is retained.
			setPreviewUrl((e.target?.result as string | undefined) ?? null);
			setRendered(null);
			setZoom(1);
		};
		reader.readAsDataURL(file);
	}, []);

	const applyAvatar = useCallback(async () => {
		if (!previewUrl) {
			return;
		}
		const dataUrl = await cropToDataUrl(previewUrl, zoom);
		if (dataUrl) {
			onChange({ kind: "avatar", dataUrl });
		}
		setIsDialogOpen(false);
	}, [previewUrl, zoom, onChange, setIsDialogOpen]);

	const applyIcon = useCallback(() => {
		const id = iconDraft.trim();
		if (!id) {
			return;
		}
		onChange({
			kind: "icon",
			id,
			...(iconColor ? { color: iconColor } : undefined),
			...(ditherAsBg ? { dither } : undefined),
		});
		setIsDialogOpen(false);
	}, [iconDraft, iconColor, ditherAsBg, dither, onChange, setIsDialogOpen]);

	const applyEmoji = useCallback(
		(emoji: string) => {
			if (!emoji) {
				return;
			}
			onChange({
				kind: "emoji",
				emoji,
				...(ditherAsBg ? { dither } : undefined),
			});
			setIsDialogOpen(false);
		},
		[ditherAsBg, dither, onChange, setIsDialogOpen]
	);

	const applyDicebear = useCallback(() => {
		onChange({
			kind: "dicebear",
			style: diceStyle,
			seed: diceSeed.trim() || randomDicebearSeed(),
		});
		setIsDialogOpen(false);
	}, [diceStyle, diceSeed, onChange, setIsDialogOpen]);

	const applyAvatarStyle = useCallback(() => {
		if (!styleDraft.style) {
			return;
		}
		onChange({ ...styleDraft, seed: styleDraft.seed.trim() || "ryu" });
		setIsDialogOpen(false);
	}, [styleDraft, onChange, setIsDialogOpen]);

	const applyDither = useCallback(() => {
		onChange({ kind: "dither", dither });
		setIsDialogOpen(false);
	}, [dither, onChange, setIsDialogOpen]);

	const applyExpressive = useCallback(() => {
		onChange({
			...ghostAppearance,
			animation: expressiveAnimationSelection,
			kind: "expressive",
			expression: expressiveSelection,
		});
		setIsDialogOpen(false);
	}, [
		ghostAppearance,
		expressiveAnimationSelection,
		expressiveSelection,
		onChange,
		setIsDialogOpen,
	]);

	const previewSizeStyle: GlyphPickerDrawingStyle = {
		"--glyph-picker-square-size": `${previewSize}px`,
	};
	const guideSide = rendered
		? Math.min(rendered.width, rendered.height) / zoom
		: 0;

	const guideSizeStyle: GlyphPickerDrawingStyle = {
		"--glyph-picker-square-size": `${guideSide}px`,
	};
	const dialog = (
		<Dialog onOpenChange={setIsDialogOpen} open={isDialogOpen}>
			<DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-140 *:[button]:hidden">
				<DialogDescription className="sr-only">
					{description ?? title}
				</DialogDescription>
				<DialogHeader className="contents space-y-0 text-left">
					<DialogTitle className="border-b px-4 py-3 text-base">
						{title}
						{description ? (
							<span className="mt-0.5 block truncate font-normal text-muted-foreground text-xs">
								{description}
							</span>
						) : null}
					</DialogTitle>
				</DialogHeader>

				<Tabs
					className="min-h-0 overflow-y-auto px-4 pt-3"
					onValueChange={(v) => setTab(v)}
					value={tab}
				>
					<TabsList className="w-full flex-wrap">
						{kinds.map((kind) => (
							<TabsTrigger key={kind} value={kind}>
								{TAB_LABEL[kind]}
							</TabsTrigger>
						))}
					</TabsList>

					{/* ── Upload ── */}
					{kinds.includes("avatar") ? (
						<TabsContent className="pt-3" value="avatar">
							{previewUrl ? (
								<div className="space-y-4">
									<div className="flex h-64 items-center justify-center overflow-hidden rounded-lg bg-muted/30">
										<div className="relative inline-flex">
											{}
											{}
											{}
											<img
												alt="Crop preview"
												className="block max-h-64 max-w-full object-contain"
												onLoad={(e) => {
													const img = e.currentTarget;
													setRendered({
														width: img.clientWidth,
														height: img.clientHeight,
													});
												}}
												src={safeMediaUrl(previewUrl) ?? undefined}
											/>
											{guideSide > 0 ? (
												<div
													className={cn(
														"pointer-events-none absolute rounded-full border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]",
														styles.cropGuidePosition,
														styles.square
													)}
													style={guideSizeStyle}
												/>
											) : null}
										</div>
									</div>
									<div className="flex items-center gap-4">
										<span className="text-muted-foreground text-xs">Zoom</span>
										<Slider
											aria-label="Zoom"
											max={MAX_ZOOM}
											min={1}
											onValueChange={(v) => {
												const next = Array.isArray(v) ? v[0] : v;
												if (isNativeNumber(next)) {
													setZoom(next);
												}
											}}
											step={0.1}
											value={[zoom]}
										/>
									</div>
								</div>
							) : (
								<button
									className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => fileInputRef.current?.click()}
									type="button"
								>
									<ImagePlus className="size-6" />
									<span>Choose an image to crop</span>
								</button>
							)}
						</TabsContent>
					) : null}

					{/* ── Iconify ── */}
					{kinds.includes("icon") ? (
						<TabsContent className="pt-3" value="icon">
							<div className="space-y-3">
								<div className="flex h-24 items-center justify-center rounded-lg bg-muted/30">
									{iconDraft.trim() ? (
										<GlyphDisplay
											alt=""
											className="rounded-lg"
											size={64}
											value={{
												kind: "icon",
												id: iconDraft,
												...(iconColor ? { color: iconColor } : undefined),
												...(ditherAsBg ? { dither } : undefined),
											}}
										/>
									) : (
										<span className="text-muted-foreground text-sm">
											Pick an icon
										</span>
									)}
								</div>

								<div className="relative">
									<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
									<Input
										aria-label="Search icons"
										className="pl-9"
										onChange={(e) => setIconQuery(e.target.value)}
										placeholder="Search Iconify (Lucide, MDI, Tabler, …)"
										value={iconQuery}
									/>
								</div>

								<div className="space-y-1.5">
									<span className="text-muted-foreground text-xs">Color</span>
									<div className="flex flex-wrap gap-1.5">
										{GLYPH_ICON_COLORS.map((swatch) => {
											const active = iconColor === swatch.value;
											const swatchStyle: GlyphPickerDrawingStyle | undefined =
												swatch.value
													? { "--glyph-picker-swatch-color": swatch.value }
													: undefined;
											return (
												<button
													aria-label={swatch.label}
													aria-pressed={active}
													className={cn(
														"size-6 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
														styles.colorSwatch,
														!swatch.value && styles.colorCycle,
														active
															? "ring-2 ring-foreground"
															: "ring-1 ring-border"
													)}
													key={swatch.label}
													onClick={() => setIconColor(swatch.value)}
													style={swatchStyle}
													title={swatch.label}
													type="button"
												/>
											);
										})}
									</div>
								</div>

								<DitherLayerControls
									dither={dither}
									enabled={ditherAsBg}
									onChange={setDither}
									onEnabledChange={setDitherAsBg}
									showToggle
								/>

								<div className="h-48 overflow-hidden rounded-lg border border-border">
									{iconLoading ? (
										<div className="flex h-full items-center justify-center">
											<Spinner />
										</div>
									) : iconError ? (
										<div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-sm">
											{iconError}
										</div>
									) : iconHits.length === 0 ? (
										<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
											No icons found
										</div>
									) : (
										<ScrollArea className="h-full">
											<div className="grid grid-cols-8 gap-1 p-2">
												{iconHits.map((hit) => {
													const active = iconDraft === hit.id;
													const safePreviewUrl = safeMediaUrl(hit.previewUrl);
													return (
														<button
															aria-label={hit.id}
															aria-pressed={active}
															className={cn(
																"flex aspect-square items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
																active && "bg-accent ring-2 ring-primary"
															)}
															key={hit.id}
															onClick={() => setIconDraft(hit.id)}
															title={hit.id}
															type="button"
														>
															{}
															{}
															{safePreviewUrl ? (
																<img
																	alt=""
																	className="size-5"
																	src={safePreviewUrl}
																/>
															) : null}
														</button>
													);
												})}
											</div>
										</ScrollArea>
									)}
								</div>
							</div>
						</TabsContent>
					) : null}

					{/* ── Emoji (emoji-mart) ── */}
					{kinds.includes("emoji") ? (
						<TabsContent className="pt-3" value="emoji">
							<div className="space-y-3">
								{ditherAsBg ? (
									<div className="flex h-20 items-center justify-center rounded-lg bg-muted/30">
										<GlyphDisplay
											alt=""
											className="rounded-lg"
											size={56}
											value={{
												kind: "emoji",
												emoji: "✨",
												dither,
											}}
										/>
									</div>
								) : null}
								<DitherLayerControls
									dither={dither}
									enabled={ditherAsBg}
									onChange={setDither}
									onEnabledChange={setDitherAsBg}
									showToggle
								/>
								<div className="overflow-hidden rounded-lg border border-border [&_em-emoji-picker]:w-full!">
									<Picker
										data={data}
										dynamicWidth
										emojiButtonSize={32}
										emojiSize={20}
										maxFrequentRows={1}
										navPosition="bottom"
										onEmojiSelect={(emoji: EmojiSelectPayload) => {
											if (emoji.native) {
												applyEmoji(emoji.native);
											}
										}}
										previewPosition="none"
										skinTonePosition="search"
										theme="auto"
									/>
								</div>
							</div>
						</TabsContent>
					) : null}

					{/* ── Expressive ghost ── */}
					{kinds.includes("expressive") ? (
						<TabsContent className="pt-3" value="expressive">
							<div className="space-y-3">
								<div className="flex min-h-36 items-center justify-center rounded-lg bg-muted/30">
									<GlyphDisplay
										alt="Expressive Ryu avatar preview"
										className="text-foreground"
										size={96}
										value={{
											...ghostAppearance,
											animation: expressiveAnimationSelection,
											kind: "expressive",
											expression: expressiveSelection,
										}}
									/>
								</div>
								<GhostAvatarControls
									onChange={setGhostAppearance}
									value={ghostAppearance}
								/>
								<p
									className="text-muted-foreground text-xs"
									hidden={ghostAppearance.variant === "costume"}
								>
									Choose a mood and animation, or use Random to cycle. The live
									preview uses your selected appearance.
								</p>
								<div
									className="h-72 overflow-hidden rounded-lg border border-border"
									hidden={
										ghostAppearance.behavior === "conversation" ||
										ghostAppearance.variant === "costume"
									}
								>
									<ScrollArea className="h-full">
										<div className="space-y-3 p-2">
											<div>
												<p className="mb-1.5 font-medium text-muted-foreground text-xs">
													Expression
												</p>
												<div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
													{EXPRESSIVE_EXPRESSION_OPTIONS.map((option) => {
														const active = expressiveSelection === option.value;
														return (
															<button
																aria-label={option.label}
																aria-pressed={active}
																className={cn(
																	"flex flex-col items-center gap-1 rounded-md p-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
																	active && "bg-accent ring-2 ring-primary"
																)}
																key={option.value}
																onClick={() =>
																	setExpressiveSelection(option.value)
																}
																title={option.description}
																type="button"
															>
																<GlyphDisplay
																	alt=""
																	animated={false}
																	className="size-11"
																	size={44}
																	value={{
																		animation: expressiveAnimationSelection,
																		kind: "expressive",
																		expression: option.value,
																	}}
																/>
																<span className="type-compact w-full truncate text-center text-muted-foreground leading-tight">
																	{option.label}
																</span>
															</button>
														);
													})}
												</div>
												<div className="border-border border-t pt-2">
													<p className="mb-1.5 font-medium text-muted-foreground text-xs">
														Animation
													</p>
													<div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
														{EXPRESSIVE_ANIMATION_OPTIONS.map((option) => {
															const active =
																expressiveAnimationSelection === option.value;
															return (
																<button
																	aria-label={option.label}
																	aria-pressed={active}
																	className={cn(
																		"flex flex-col items-center gap-1 rounded-md p-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
																		active && "bg-accent ring-2 ring-primary"
																	)}
																	key={option.value}
																	onClick={() =>
																		setExpressiveAnimationSelection(
																			option.value
																		)
																	}
																	title={option.description}
																	type="button"
																>
																	<GlyphDisplay
																		alt=""
																		animated={false}
																		className="size-11"
																		size={44}
																		value={{
																			animation: option.value,
																			kind: "expressive",
																			expression: expressiveSelection,
																		}}
																	/>
																	<span className="type-compact w-full truncate text-center text-muted-foreground leading-tight">
																		{option.label}
																	</span>
																</button>
															);
														})}
													</div>
												</div>
											</div>
										</div>
									</ScrollArea>
								</div>
							</div>
						</TabsContent>
					) : null}

					{/* ── DiceBear ── */}
					{kinds.includes("dicebear") ? (
						<TabsContent className="pt-3" value="dicebear">
							<div className="space-y-3">
								<div className="flex h-28 items-center justify-center rounded-lg bg-muted/30">
									{}
									{}
									<img
										alt=""
										className="size-20 rounded-lg"
										src={dicebearUrl(diceStyle, diceSeed, { size: 80 })}
									/>
								</div>

								<div className="flex items-center gap-2">
									<Input
										aria-label="DiceBear seed"
										onChange={(e) => setDiceSeed(e.target.value)}
										placeholder="Seed"
										value={diceSeed}
									/>
									<Button
										aria-label="Randomize seed"
										onClick={() => setDiceSeed(randomDicebearSeed())}
										size="icon"
										type="button"
										variant="outline"
									>
										<RefreshCw className="size-4" />
									</Button>
								</div>

								<div className="h-44 overflow-hidden rounded-lg border border-border">
									<ScrollArea className="h-full">
										<div className="grid grid-cols-5 gap-1.5 p-2">
											{DICEBEAR_STYLES.map((style) => {
												const active = diceStyle === style;
												return (
													<button
														aria-label={dicebearStyleLabel(style)}
														aria-pressed={active}
														className={cn(
															"flex flex-col items-center gap-1 rounded-md p-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
															active && "bg-accent ring-2 ring-primary"
														)}
														key={style}
														onClick={() => setDiceStyle(style)}
														title={dicebearStyleLabel(style)}
														type="button"
													>
														{}
														{}
														<img
															alt=""
															className="size-10 rounded-md"
															src={dicebearUrl(style, diceSeed || "preview", {
																size: 40,
															})}
														/>
														<span className="type-compact w-full truncate text-center text-muted-foreground leading-tight">
															{dicebearStyleLabel(style)}
														</span>
													</button>
												);
											})}
										</div>
									</ScrollArea>
								</div>
							</div>
						</TabsContent>
					) : null}

					{/* ── Marketplace avatar styles ── */}
					{kinds.includes("avatar_style") ? (
						<TabsContent className="pt-3" value="avatar_style">
							<AvatarStyleControls
								onChange={setStyleDraft}
								value={styleDraft}
							/>
						</TabsContent>
					) : null}

					{/* ── Dither-only (agent) ── */}
					{kinds.includes("dither") ? (
						<TabsContent className="pt-3" value="dither">
							<div className="space-y-4">
								<div className="flex h-40 items-center justify-center rounded-lg bg-muted/30">
									<span className="relative block size-24 overflow-hidden rounded-full ring-1 ring-border">
										<DitherGradient
											direction={dither.direction}
											from={dither.from}
											to={dither.to ?? "transparent"}
										/>
									</span>
								</div>
								<DitherLayerControls
									dither={dither}
									enabled
									onChange={setDither}
									onEnabledChange={() => undefined}
									showToggle={false}
								/>
								<p className="text-muted-foreground text-xs">
									Tip: on the Icon or Emoji tabs you can also use dither as a
									background behind the glyph. DiceBear does not mix with
									dither.
								</p>
							</div>
						</TabsContent>
					) : null}
				</Tabs>

				<DialogFooter className="shrink-0 border-t px-4 py-3">
					{clearable && value ? (
						<Button
							className="mr-auto"
							onClick={() => {
								onChange(null);
								setIsDialogOpen(false);
							}}
							type="button"
							variant="ghost"
						>
							Remove
						</Button>
					) : null}
					{tab === "avatar" ? (
						<Button disabled={!previewUrl} onClick={applyAvatar} type="button">
							Apply
						</Button>
					) : null}
					{tab === "icon" ? (
						<Button
							disabled={!iconDraft.trim()}
							onClick={applyIcon}
							type="button"
						>
							Use icon
						</Button>
					) : null}
					{tab === "dicebear" ? (
						<Button onClick={applyDicebear} type="button">
							<Dices className="size-4" />
							Use avatar
						</Button>
					) : null}
					{tab === "expressive" ? (
						<Button onClick={applyExpressive} type="button">
							Use ghost avatar
						</Button>
					) : null}
					{tab === "avatar_style" ? (
						<Button
							disabled={
								!avatarContributions.styles.some(
									(row) => row.id === styleDraft.style
								)
							}
							onClick={applyAvatarStyle}
							type="button"
						>
							Use avatar
						</Button>
					) : null}
					{tab === "dither" ? (
						<Button onClick={applyDither} type="button">
							Use gradient
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

	// Controlled-only mode: host owns the trigger (e.g. sidebar context menu).
	if (controlled) {
		return (
			<>
				{dialog}
				<input
					accept="image/jpeg,image/png,image/webp,image/svg+xml"
					aria-label="Upload image file"
					className="sr-only"
					disabled={disabled}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) {
							handleFileSelect(file);
							e.target.value = "";
						}
					}}
					ref={fileInputRef}
					type="file"
				/>
			</>
		);
	}

	return (
		<>
			<div className={cn("relative", className)}>
				<button
					aria-label={value ? "Change icon" : "Set icon"}
					className={cn(
						"group/glyph relative flex items-center justify-center overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
						styles.square
					)}
					disabled={disabled}
					onClick={() => setIsDialogOpen(true)}
					style={previewSizeStyle}
					type="button"
				>
					<GlyphDisplay
						alt=""
						className="size-full rounded-lg"
						fallback={fallback}
						size={previewSize}
						value={value}
					/>
					{disabled ? null : (
						<span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover/glyph:opacity-100">
							<ImagePlus className="size-4" />
						</span>
					)}
				</button>
				{clearable && value && !disabled ? (
					<Button
						aria-label="Remove icon"
						className="absolute -top-1.5 -right-1.5 size-5 rounded-full border-2 border-background p-0 shadow-none"
						onClick={() => onChange(null)}
						size="icon"
						type="button"
					>
						<X className="size-3" />
					</Button>
				) : null}
			</div>
			{dialog}
			<input
				accept="image/jpeg,image/png,image/webp,image/svg+xml"
				aria-label="Upload image file"
				className="sr-only"
				disabled={disabled}
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file) {
						handleFileSelect(file);
						e.target.value = "";
					}
				}}
				ref={fileInputRef}
				type="file"
			/>
		</>
	);
}
