import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
	ColorPickerTrigger,
} from "@ryu/ui/components/color-picker.tsx";
import {
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Fragment } from "react";
import type {
	CustomTokens,
	GroupedVariants,
	ThemeVariant,
} from "@/src/lib/themes/presets.ts";
import { themeManifestJson } from "@/src/lib/themes/publish.ts";
import appearanceStyles from "./appearance.module.css";
import {
	type AppearancePaintStyle,
	colorToHex,
	getContrastColor,
	PRIMARY_PRESETS,
} from "./appearance-tab-model.ts";

export function PresetSwatch({
	bg,
	surface,
	primary,
}: {
	bg: string;
	surface: string;
	primary: string;
}) {
	const backgroundStyle: AppearancePaintStyle = { "--appearance-fill": bg };
	const surfaceStyle: AppearancePaintStyle = { "--appearance-fill": surface };
	const primaryStyle: AppearancePaintStyle = { "--appearance-fill": primary };

	return (
		<span
			className={cn(
				"inline-flex shrink-0 flex-col overflow-hidden rounded-sm border border-border",
				appearanceStyles.swatchFrame
			)}
		>
			<span
				className={cn("block flex-1", appearanceStyles.fill)}
				style={backgroundStyle}
			/>
			<span
				className={cn("block", appearanceStyles.swatchSurface)}
				style={surfaceStyle}
			/>
			<span
				className={cn(
					"block",
					appearanceStyles.fill,
					appearanceStyles.swatchPrimary
				)}
				style={primaryStyle}
			/>
		</span>
	);
}

export function PresetSelectItem({ variant }: { variant: ThemeVariant }) {
	return (
		<SelectItem value={variant.id}>
			<span className="flex items-center gap-2">
				<PresetSwatch
					bg={variant.preview.bg}
					primary={variant.preview.primary}
					surface={variant.preview.surface}
				/>
				<span>{variant.label}</span>
			</span>
		</SelectItem>
	);
}

// Section headers for the preset picker, in render order. "My themes" leads because
// a user's own saved theme is the one they came here to re-select; "Installed" holds
// themes that arrived with a marketplace plugin (`contributes.themes`); "Built-in"
// is the shipped set — named for provenance, matching how VS Code and Zed label the
// bundled half of their theme lists.
export const PRESET_GROUP_LABELS = {
	custom: "My themes",
	plugin: "Installed",
	builtin: "Built-in",
} satisfies Record<keyof GroupedVariants, string>;

export const PRESET_GROUP_ORDER = ["custom", "plugin", "builtin"] as const;

/**
 * Hand the user a publishable plugin manifest for one of their own themes.
 *
 * Sharing a theme is publishing a plugin here — there is no theme-shaped upload
 * endpoint, because a theme IS a plugin that contributes one. The clipboard is the
 * whole handoff: what comes back is a complete `manifest.json`, so the next step is
 * the same `ryu publish` any other plugin author runs.
 */
export async function shareTheme(variant: ThemeVariant) {
	try {
		await navigator.clipboard.writeText(themeManifestJson(variant));
		toast.success("Theme manifest copied", {
			description:
				"Save it as manifest.json in a new folder and run `ryu publish` to list it on the marketplace.",
		});
	} catch {
		toast.error("Couldn't copy the theme manifest");
	}
}

/**
 * The preset dropdown, split into provenance groups with shadcn `SelectGroup` /
 * `SelectLabel` headers. Empty groups are dropped entirely rather than rendered as a
 * bare header (a fresh install has no custom or installed themes, and a lone
 * "Built-in" header above the only group would be noise).
 */
export function PresetSelectGroups({ groups }: { groups: GroupedVariants }) {
	const populated = PRESET_GROUP_ORDER.filter((key) => groups[key].length > 0);
	// A single group needs no header at all — the trigger already says what it is.
	if (populated.length < 2) {
		return (
			<>
				{populated.flatMap((key) =>
					groups[key].map((v) => <PresetSelectItem key={v.id} variant={v} />)
				)}
			</>
		);
	}
	return (
		<>
			{populated.map((key, index) => (
				// The separator sits BETWEEN groups, not inside one: a `SelectGroup`
				// is a labelled region, and a rule nested under its label reads as
				// part of that group rather than as the boundary before it.
				<Fragment key={key}>
					{index > 0 && <SelectSeparator />}
					<SelectGroup>
						<SelectLabel>{PRESET_GROUP_LABELS[key]}</SelectLabel>
						{groups[key].map((v) => (
							<PresetSelectItem key={v.id} variant={v} />
						))}
					</SelectGroup>
				</Fragment>
			))}
		</>
	);
}

export function ColorField({
	mode,
	fieldKey,
	label,
	value,
	onChange,
}: {
	mode: "light" | "dark";
	fieldKey: keyof CustomTokens;
	label: string;
	value: string;
	onChange: (key: keyof CustomTokens, val: string) => void;
}) {
	// `value` may be a raw preset string (oklch/rgba, possibly translucent). Keep
	// that lossless token in theme state while the trigger uses a compact hex
	// display value for the shared picker.
	const hexVal = colorToHex(value);
	const textColor = getContrastColor(hexVal);

	return (
		<div className="flex items-center gap-3">
			<label
				className="w-24 shrink-0 text-muted-foreground text-xs"
				htmlFor={`${mode}-${fieldKey}`}
			>
				{label}
			</label>
			<div className="flex flex-1 items-center gap-2">
				<ColorPicker
					format="hex"
					onValueChange={(val) => onChange(fieldKey, val)}
					value={hexVal}
				>
					<ColorPickerTrigger
						appearance="theme-field"
						className="h-7 flex-1"
						id={`${mode}-${fieldKey}`}
						palette={{ fillHex: hexVal, foregroundHex: textColor }}
					>
						{hexVal}
					</ColorPickerTrigger>
					<ColorPickerContent className="z-50">
						<ColorPickerPanel />
					</ColorPickerContent>
				</ColorPicker>
			</div>
		</div>
	);
}

export function PrimaryColorField({
	mode,
	value,
	onChange,
}: {
	mode: "light" | "dark";
	value: string;
	onChange: (key: keyof CustomTokens, val: string) => void;
}) {
	const tl = useLiteralMessages();
	// `value` may be a raw preset string (oklch). Derive a display hex so the
	// trigger renders and preset-matching works; the picker still emits hex for
	// this explicitly hex-formatted field.
	const hexVal = colorToHex(value);
	const matchesPreset = PRIMARY_PRESETS.some(
		(p) => (mode === "light" ? p.light : p.dark).toLowerCase() === hexVal
	);

	return (
		<div className="flex items-start gap-3">
			<span className="w-24 shrink-0 pt-1 text-muted-foreground text-xs">
				Primary
			</span>
			<div className="flex flex-1 flex-wrap items-center gap-1.5">
				{PRIMARY_PRESETS.map((p) => {
					const swatch = mode === "light" ? p.light : p.dark;
					const selected = swatch.toLowerCase() === hexVal;
					const swatchStyle: AppearancePaintStyle = {
						"--appearance-fill": swatch,
					};
					return (
						<button
							aria-label={tl("Set primary to {label}", { label: p.label })}
							className={cn(
								"size-6 rounded-lg border border-border transition-shadow duration-150",
								appearanceStyles.fill,
								selected &&
									"ring-2 ring-ring ring-offset-2 ring-offset-background"
							)}
							key={p.name}
							onClick={() => onChange("primary", swatch)}
							style={swatchStyle}
							title={p.label}
							type="button"
						/>
					);
				})}
				<ColorPicker
					format="hex"
					onValueChange={(val) => onChange("primary", val)}
					value={hexVal}
				>
					<ColorPickerTrigger
						appearance="theme-swatch"
						aria-label="Custom primary color"
						className="size-6"
						palette={{ fillHex: hexVal }}
						selected={!matchesPreset}
						spectrum={matchesPreset}
						title="Custom color"
					/>
					<ColorPickerContent className="z-50">
						<ColorPickerPanel />
					</ColorPickerContent>
				</ColorPicker>
			</div>
		</div>
	);
}
