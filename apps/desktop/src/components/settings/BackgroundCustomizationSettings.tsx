import { Delete02Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	ColorPicker,
	ColorPickerArea,
	ColorPickerContent,
	ColorPickerEyeDropper,
	ColorPickerFormatSelect,
	ColorPickerHueSlider,
	ColorPickerInput,
	ColorPickerTrigger,
} from "@ryu/ui/components/color-picker";
import { ElasticSlider } from "@ryu/ui/components/elastic-slider";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { Switch } from "@ryu/ui/components/switch";
import { useEffect, useRef, useState } from "react";
import {
	type BackgroundFit,
	type BackgroundSurface,
	BG_CHANGE_EVENT,
	clearSurfaceImage,
	loadSurfaceBackground,
	type SurfaceBackground,
	setSurfaceBackground,
	setSurfaceImage,
} from "@/src/hooks/useBackgroundCustomization.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const FIT_OPTIONS: Array<{ value: BackgroundFit; label: string }> = [
	{ value: "cover", label: "Cover" },
	{ value: "contain", label: "Contain" },
	{ value: "fill", label: "Stretch" },
	{ value: "center", label: "Center" },
	{ value: "tile", label: "Tile" },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Pick black/white text for legibility against the swatch fill — mirrors the
// theme color pickers in AppearanceTab, which show the hex on the swatch.
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
				aria-label={ariaLabel}
				className="flex h-7 w-24 cursor-pointer items-center justify-center rounded border border-border px-2 font-mono text-[11px] uppercase transition-opacity hover:opacity-90"
				style={{ backgroundColor: hex, color: getContrastColor(hex) }}
			>
				{hex}
			</ColorPickerTrigger>
			<ColorPickerContent className="z-50">
				<ColorPickerArea />
				<ColorPickerHueSlider />
				<ColorPickerEyeDropper />
				<ColorPickerFormatSelect />
				<ColorPickerInput />
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
			<span className="w-28 flex-shrink-0 text-muted-foreground text-xs">
				{label}
			</span>
			<div className="flex flex-1 items-center justify-end gap-2">
				{children}
			</div>
		</div>
	);
}

function SurfaceBackgroundEditor({ surface }: { surface: BackgroundSurface }) {
	const [bg, setBg] = useState<SurfaceBackground>(() =>
		loadSurfaceBackground(surface)
	);
	const fileInputRef = useRef<HTMLInputElement>(null);

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

	return (
		<div className="space-y-4">
			{/* Gradient */}
			<div className="space-y-2.5">
				<div className="flex items-center justify-between">
					<div>
						<p className="font-medium text-sm">Gradient</p>
						<p className="text-muted-foreground text-xs">
							A linear gradient behind the surface.
						</p>
					</div>
					<Switch
						checked={bg.gradientEnabled}
						onCheckedChange={(v) => update({ gradientEnabled: v })}
					/>
				</div>
				{bg.gradientEnabled && (
					<div className="space-y-2 rounded-lg border border-border/60 p-3">
						<FieldRow label="From">
							<ColorSwatch
								ariaLabel="Gradient start color"
								onChange={(val) => update({ gradientFrom: val })}
								value={bg.gradientFrom}
							/>
						</FieldRow>
						<FieldRow label="To">
							<ColorSwatch
								ariaLabel="Gradient end color"
								onChange={(val) => update({ gradientTo: val })}
								value={bg.gradientTo}
							/>
						</FieldRow>
						<ElasticSlider
							formatValue={(v) => `${Math.round(v)}°`}
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
			<div className="space-y-2.5">
				<div className="flex items-center justify-between">
					<div>
						<p className="font-medium text-sm">Image</p>
						<p className="text-muted-foreground text-xs">
							A custom image, layered over the gradient.
						</p>
					</div>
					<Switch
						checked={bg.imageEnabled}
						onCheckedChange={(v) => update({ imageEnabled: v })}
					/>
				</div>
				{bg.imageEnabled && (
					<div className="space-y-3 rounded-lg border border-border/60 p-3">
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
								className="h-12 w-20 flex-shrink-0 overflow-hidden rounded bg-muted"
								style={
									bg.imageSrc
										? {
												backgroundImage: `url("${bg.imageSrc}")`,
												backgroundSize: "cover",
												backgroundPosition: "center",
											}
										: undefined
								}
							/>
							<Button
								onClick={() => fileInputRef.current?.click()}
								size="sm"
								variant="secondary"
							>
								<HugeiconsIcon className="mr-1" icon={Image01Icon} size={14} />
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
									<Select
										items={FIT_OPTIONS}
										onValueChange={(v) =>
											v && update({ imageFit: v as BackgroundFit })
										}
										value={bg.imageFit}
									>
										<SelectTrigger className="h-8 w-36 text-sm">
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
									<ElasticSlider
										formatValue={(v) => `${Math.round(v)}%`}
										label="Scale"
										max={300}
										min={25}
										onValueChange={(v) => update({ imageScale: Math.round(v) })}
										step={5}
										value={bg.imageScale}
									/>
								)}

								<div className="space-y-2 border-border/50 border-t pt-2">
									<FieldRow label="Overlay color">
										<ColorSwatch
											ariaLabel="Overlay color"
											onChange={(val) => update({ overlayColor: val })}
											value={bg.overlayColor}
										/>
									</FieldRow>
									<ElasticSlider
										formatValue={(v) => `${Math.round(v)}%`}
										label="Overlay opacity"
										max={100}
										min={0}
										onValueChange={(v) =>
											update({ overlayOpacity: Math.round(v) })
										}
										step={1}
										value={bg.overlayOpacity}
									/>
									<p className="text-muted-foreground text-xs">
										A tint drawn over the image to keep text readable.
									</p>
								</div>
							</>
						) : (
							<p className="text-muted-foreground text-xs">
								Choose an image to set its fit, scale, and overlay.
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export function BackgroundCustomizationSettings() {
	return (
		<SettingsSection
			caption="Layer a gradient or image over the sidebar and page. Off by default — the theme colors show through any transparency."
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
