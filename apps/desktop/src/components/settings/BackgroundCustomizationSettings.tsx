import {
	Add01Icon,
	Cancel01Icon,
	Delete02Icon,
	Image01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
	ColorPickerTrigger,
} from "@ryu/ui/components/color-picker.tsx";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef, useState } from "react";
import {
	type BackgroundFit,
	type BackgroundSurface,
	BG_CHANGE_EVENT,
	buildGradientCss,
	clearSurfaceImage,
	type GradientStop,
	loadSurfaceBackground,
	MAX_BACKDROP_BLUR,
	type SurfaceBackground,
	setSurfaceBackground,
	setSurfaceImage,
} from "@/src/hooks/useBackgroundCustomization.ts";
import previewStyles from "./settings-preview.module.css";
import type { PreviewStyle } from "./settings-preview-style.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const FIT_OPTIONS: Array<{ value: BackgroundFit; label: string }> = [
	{ value: "cover", label: "Cover" },
	{ value: "contain", label: "Contain" },
	{ value: "fill", label: "Stretch" },
	{ value: "center", label: "Center" },
	{ value: "tile", label: "Tile" },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Pick black/white text for legibility against the trigger fill. The shared
// picker owns the actual swatch, sliders, formats, and recent-color history.
function getContrastColor(hex: string): string {
	if (!HEX_RE.test(hex)) {
		return "#ffffff";
	}
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
	return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "#000000" : "#ffffff";
}

function ColorSwatch({
	value,
	onChange,
	ariaLabel,
}: {
	value: string;
	onChange: (val: string) => void;
	ariaLabel: string;
}) {
	const hex = HEX_RE.test(value) ? value : "#000000";
	return (
		<ColorPicker format="hex" onValueChange={onChange} value={hex}>
			<ColorPickerTrigger
				appearance="hex-field"
				aria-label={ariaLabel}
				className="w-24"
				palette={{ fillHex: hex, foregroundHex: getContrastColor(hex) }}
			>
				{hex}
			</ColorPickerTrigger>
			<ColorPickerContent className="z-50">
				<ColorPickerPanel />
			</ColorPickerContent>
		</ColorPicker>
	);
}

function FieldRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-28 shrink-0 text-muted-foreground text-xs">
				{label}
			</span>
			<div className="flex flex-1 items-center justify-end gap-2">
				{children}
			</div>
		</div>
	);
}

function GradientStopsEditor({
	angle,
	stops,
	onChange,
}: {
	angle: number;
	stops: GradientStop[];
	onChange: (stops: GradientStop[]) => void;
}) {
	const tl = useLiteralMessages();
	const setColor = (index: number, color: string) => {
		onChange(stops.map((s, i) => (i === index ? { ...s, color } : s)));
	};

	const setPosition = (index: number, position: number) => {
		onChange(stops.map((s, i) => (i === index ? { ...s, position } : s)));
	};

	const remove = (index: number) => {
		if (stops.length <= 2) {
			return;
		}
		onChange(stops.filter((_, i) => i !== index));
	};

	const add = () => {
		// Drop a new stop in the widest gap between neighbors so it starts
		// somewhere visible instead of stacking on an existing stop.
		const sorted = [...stops].sort((a, b) => a.position - b.position);
		let best = 50;
		let bestGap = -1;
		for (let i = 0; i < sorted.length - 1; i++) {
			const gap = sorted[i + 1].position - sorted[i].position;
			if (gap > bestGap) {
				bestGap = gap;
				best = Math.round(sorted[i].position + gap / 2);
			}
		}
		onChange([
			...stops,
			{ color: "#8b8b93", position: Number.isFinite(best) ? best : 50 },
		]);
	};

	const gradientStyle: PreviewStyle = {
		"--settings-preview-image": buildGradientCss(stops, angle),
	};
	return (
		<div className="space-y-3">
			{/* Live preview of the stops at their current positions. */}
			<div
				aria-label="Gradient preview"
				className={`h-6 w-full rounded-lg border border-border ${previewStyles.gradient}`}
				role="img"
				style={gradientStyle}
			/>
			{stops.map((stop, i) => (
				<div
					className="flex items-center gap-2"
					// stops have no
					// stable identity and rows keep insertion order.
					key={i}
				>
					<span className="w-5 shrink-0 text-center text-muted-foreground text-xs tabular-nums">
						{i + 1}
					</span>
					<ColorSwatch
						ariaLabel={tl("Gradient stop {stopNumber} color", {
							stopNumber: i + 1,
						})}
						onChange={(color) => setColor(i, color)}
						value={stop.color}
					/>
					<FluidSlider
						aria-label={tl("Gradient stop {stopNumber} position", {
							stopNumber: i + 1,
						})}
						format={(v) => `${Math.round(v)}%`}
						label=""
						max={100}
						min={0}
						onValueChange={(v) => setPosition(i, v)}
						step={1}
						value={stop.position}
					/>
					<Button
						appearance="recipient-remove"
						aria-label={tl("Remove gradient stop {stopNumber}", {
							stopNumber: i + 1,
						})}
						className="size-8 shrink-0"
						disabled={stops.length <= 2}
						onClick={() => remove(i)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon icon={Cancel01Icon} size={14} />
					</Button>
				</div>
			))}
			<Button className="w-full" onClick={add} size="sm" variant="outline">
				<HugeiconsIcon icon={Add01Icon} size={14} />
				Add stop
			</Button>
		</div>
	);
}

function SurfaceBackgroundEditor({ surface }: { surface: BackgroundSurface }) {
	const [bg, setBg] = useState<SurfaceBackground>(() =>
		loadSurfaceBackground(surface)
	);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const tl = useLiteralMessages();
	const surfaceLabel = surface === "sidebar" ? tl("Sidebar") : tl("Page");

	// Reflect external changes (Reset-to-defaults elsewhere in this tab, or
	// another window) by reloading from the store when one is signaled.
	useEffect(() => {
		const reload = () => {
			const fresh = loadSurfaceBackground(surface);
			setBg((prev) =>
				JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh
			);
		};
		window.addEventListener(BG_CHANGE_EVENT, reload);
		window.addEventListener("storage", reload);
		return () => {
			window.removeEventListener(BG_CHANGE_EVENT, reload);
			window.removeEventListener("storage", reload);
		};
	}, [surface]);

	const update = (patch: Partial<SurfaceBackground>) => {
		const next = { ...bg, ...patch };
		setSurfaceBackground(surface, next);
		setBg(next);
	};

	const onPickImage = async (file: File | undefined) => {
		if (!file) {
			return;
		}
		if (!file.type.startsWith("image/")) {
			toast.error("Please choose an image file.");
			return;
		}
		// Bytes go to IndexedDB (no size limit); only a per-window object URL is
		// referenced from CSS.
		const next = await setSurfaceImage(surface, file);
		if (next) {
			setBg(next);
		} else {
			toast.error("Couldn't save that image.");
		}
	};

	const onRemoveImage = async () => {
		await clearSurfaceImage(surface);
		setBg(loadSurfaceBackground(surface));
	};

	const scaleApplies = bg.imageFit === "center" || bg.imageFit === "tile";

	const imageStyle: PreviewStyle = {
		"--settings-preview-image": bg.imageSrc
			? `url("${bg.imageSrc}")`
			: undefined,
	};
	return (
		<div className="space-y-4">
			{/* Gradient */}
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<div>
						<p className="font-medium text-sm">Gradient</p>
						<p className="text-detail text-muted-foreground">
							A linear gradient behind the surface.
						</p>
					</div>
					<Switch
						aria-label={tl("{surfaceLabel} gradient background", {
							surfaceLabel,
						})}
						checked={bg.gradientEnabled}
						onCheckedChange={(v) => update({ gradientEnabled: v })}
					/>
				</div>
				{bg.gradientEnabled && (
					<div className="space-y-3">
						<GradientStopsEditor
							angle={bg.gradientAngle}
							onChange={(stops) => update({ gradientStops: stops })}
							stops={bg.gradientStops}
						/>
						<FluidSlider
							format={(v) => `${Math.round(v)}°`}
							label="Angle"
							max={360}
							min={0}
							onValueChange={(v) => update({ gradientAngle: Math.round(v) })}
							step={1}
							value={bg.gradientAngle}
						/>
					</div>
				)}
			</div>

			{/* Image */}
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<div>
						<p className="font-medium text-sm">Image</p>
						<p className="text-detail text-muted-foreground">
							A custom image, layered over the gradient.
						</p>
					</div>
					<Switch
						aria-label={tl("{surfaceLabel} image background", { surfaceLabel })}
						checked={bg.imageEnabled}
						onCheckedChange={(v) => update({ imageEnabled: v })}
					/>
				</div>
				{bg.imageEnabled && (
					<div className="space-y-3">
						<input
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								// Reset so picking the same file again still fires change.
								e.target.value = "";
								onPickImage(file).catch(() => undefined);
							}}
							ref={fileInputRef}
							type="file"
						/>
						<div className="flex items-center gap-3">
							<div
								className={`h-12 w-20 shrink-0 overflow-hidden rounded-lg bg-muted ${previewStyles.image}`}
								style={imageStyle}
							/>
							<Button
								onClick={() => fileInputRef.current?.click()}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon icon={Image01Icon} size={14} />
								{bg.imageSrc ? "Replace" : "Choose image"}
							</Button>
							{bg.imageSrc && (
								<Button
									aria-label="Remove image"
									onClick={() => {
										onRemoveImage().catch(() => undefined);
									}}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon icon={Delete02Icon} size={14} />
								</Button>
							)}
						</div>

						{bg.imageSrc ? (
							<>
								<FieldRow label="Fit">
									<Select<BackgroundFit>
										items={FIT_OPTIONS}
										onValueChange={(v) => v && update({ imageFit: v })}
										value={bg.imageFit}
									>
										<SelectTrigger
											aria-label={tl("{surfaceLabel} image fit", {
												surfaceLabel,
											})}
											className="w-auto shrink-0"
											size="sm"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{FIT_OPTIONS.map((f) => (
												<SelectItem key={f.value} value={f.value}>
													{f.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</FieldRow>

								{scaleApplies && (
									<FluidSlider
										format={(v) => `${Math.round(v)}%`}
										label="Scale"
										max={300}
										min={25}
										onValueChange={(v) => update({ imageScale: Math.round(v) })}
										step={5}
										value={bg.imageScale}
									/>
								)}

								<div className="space-y-2 border-border border-t pt-2">
									<FieldRow label="Overlay color">
										<ColorSwatch
											ariaLabel="Overlay color"
											onChange={(val) => update({ overlayColor: val })}
											value={bg.overlayColor}
										/>
									</FieldRow>
									<FluidSlider
										format={(v) => `${Math.round(v)}%`}
										label="Overlay opacity"
										max={100}
										min={0}
										onValueChange={(v) =>
											update({ overlayOpacity: Math.round(v) })
										}
										step={1}
										value={bg.overlayOpacity}
									/>
									<p className="text-detail text-muted-foreground">
										A tint drawn over the image to keep text readable.
									</p>
								</div>
							</>
						) : (
							<p className="text-detail text-muted-foreground">
								Choose an image to set its fit, scale, and overlay.
							</p>
						)}
					</div>
				)}
			</div>

			{/* Effects — blur / transparency for the whole background layer. */}
			<div className="space-y-3">
				<div>
					<p className="font-medium text-sm">Effects</p>
					<p className="text-detail text-muted-foreground">
						Softens the layer and lets the theme colors show through.
					</p>
				</div>
				<div className="space-y-3">
					<FluidSlider
						format={(v) => `${Math.round(v)}%`}
						label="Transparency"
						max={100}
						min={0}
						onValueChange={(v) => update({ transparency: Math.round(v) })}
						step={1}
						value={bg.transparency}
					/>
					<FluidSlider
						format={(v) => `${Math.round(v)}px`}
						label="Backdrop blur"
						max={MAX_BACKDROP_BLUR}
						min={0}
						onValueChange={(v) => update({ backdropBlur: Math.round(v) })}
						step={1}
						value={bg.backdropBlur}
					/>
				</div>
			</div>
		</div>
	);
}

export function BackgroundCustomizationSettings() {
	return (
		<SettingsSection
			caption="A gradient or image behind the sidebar and page. Off by default."
			title="Backgrounds"
		>
			<SettingsCard className="grid grid-cols-1 gap-6 md:grid-cols-2">
				<div className="space-y-3">
					<h3 className="font-medium text-sm">Sidebar</h3>
					<SurfaceBackgroundEditor surface="sidebar" />
				</div>
				<div className="space-y-3">
					<h3 className="font-medium text-sm">Page background</h3>
					<SurfaceBackgroundEditor surface="page" />
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
