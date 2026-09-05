import {
	ArrowDown01Icon,
	Cancel01Icon,
	ChartLineData01Icon,
	Chat01Icon,
	DashboardSquare01Icon,
	Delete02Icon,
	FloppyDiskIcon,
	Folder01Icon,
	GitCompareIcon,
	Share08Icon,
	SparklesIcon,
	TextFontIcon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { SettingsSubpages } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible";
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
import { Input } from "@ryu/ui/components/input";
import { RangeSlider } from "@ryu/ui/components/motion/range-slider";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch";
import { useBotTerminology } from "@ryu/ui/hooks/use-bot-terminology.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useTheme } from "next-themes";
import type { CSSProperties } from "react";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
	getCurrentSeason,
	getSeasonDisplayEmoji,
	SEASONS,
} from "@/src/components/layout/SeasonalEffects.tsx";
import {
	setAgentRowStyle,
	useAgentRowStylePref,
} from "@/src/hooks/useAgentRowStyle.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import { useChatPickerPlacement } from "@/src/hooks/useChatPickerPlacement.ts";
import {
	setChromeShadows,
	useChromeShadows,
} from "@/src/hooks/useChromeShadows.ts";
import {
	setDialogOverlayBlur,
	useDialogOverlayBlur,
} from "@/src/hooks/useDialogOverlayBlur.ts";
import {
	type DiffViewPrefs,
	diffViewPrefsToOptions,
	setDiffViewPrefs,
	useDiffViewPrefs,
} from "@/src/hooks/useDiffViewPrefs.ts";
import {
	type FileTreePrefs,
	fileTreePrefsToOptions,
	setFileTreePrefs,
	useFileTreePrefs,
} from "@/src/hooks/useFileTreePrefs.ts";
import { useFileTreeThemeStyles } from "@/src/hooks/useFileTreeThemeStyles.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import {
	setInvertedBackgrounds,
	useInvertedBackgrounds,
} from "@/src/hooks/useInvertedBackgrounds.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import {
	setPointerCursor,
	usePointerCursor,
} from "@/src/hooks/usePointerCursor.ts";
import {
	setPopupOverlayBlur,
	usePopupOverlayBlur,
} from "@/src/hooks/usePopupOverlayBlur.ts";
import {
	previewSeasonalTheme,
	type SeasonalThemeSetting,
	setSeasonalThemeSetting,
	usePreviewSeasonalTheme,
	useSeasonalThemeSetting,
} from "@/src/hooks/useSeasonalEffects.ts";
import { usePendingSubpage } from "@/src/hooks/useSettingSubpage.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import { useSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import {
	type SidebarMode,
	useSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import { useSidebarModes } from "@/src/hooks/useSidebarModes.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTabDropdown } from "@/src/hooks/useTabDropdown.ts";
import {
	applyCustomTokensLive,
	CODE_FONTS,
	DEFAULT_CARD_SPACING,
	DEFAULT_CHAT_WIDTH,
	DEFAULT_RADIUS,
	DEFAULT_SCALE,
	DEFAULT_SIDEBAR_WIDTH,
	DEFAULT_SPACING,
	HEADING_FONTS,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SCALE_MAX,
	SCALE_MIN,
	SIDEBAR_WIDTH_KEY,
	setCardSpacing,
	setChatWidth,
	setCodeFont,
	setContrast,
	setDarkPreset,
	setHeadingFont,
	setLightPreset,
	setRadius,
	setScale,
	setSidebarWidthSetting,
	setSpacing,
	setUiFont,
	UI_FONTS,
} from "@/src/hooks/useThemePreset.ts";
import {
	setUsageBarPrefs,
	useUsageBarPrefs,
} from "@/src/hooks/useUsageBarPrefs.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
	bindAppearanceThemeMode,
	resetAppearanceSettings,
} from "@/src/lib/appearance-settings.ts";
import { LEVEL_RAMP_CLASS, levelFillColor } from "@/src/lib/level-ramp.ts";
import {
	NOTIFICATION_LAYOUT_STEPS,
	notificationLayoutStepIndex,
	setNotificationLayout,
	useNotificationLayout,
} from "@/src/lib/notification-layout.ts";
import {
	PIERRE_DARK_THEMES,
	PIERRE_LIGHT_THEMES,
	TREE_DARK_THEMES,
	TREE_LIGHT_THEMES,
} from "@/src/lib/pierre-themes.ts";
import {
	type CustomTokens,
	customTokensToVariant,
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	deleteCustomTheme,
	findVariant,
	type GroupedVariants,
	getGroupedVariants,
	STORAGE_KEYS,
	saveCustomTheme,
	type ThemeVariant,
	variantToCustomTokens,
} from "@/src/lib/themes/presets.ts";
import { themeManifestJson } from "@/src/lib/themes/publish.ts";
import {
	deriveToolDetailPreset,
	TOOL_DETAIL_PRESETS,
	TOOL_DETAIL_STEPS,
	type ToolDetailStepId,
	type ToolDetailValue,
	toolDetailStepIndex,
} from "@/src/lib/tool-detail-ladder.ts";
import { BackgroundCustomizationSettings } from "./BackgroundCustomizationSettings.tsx";
import { LanguageSettings } from "./LanguageSettings.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import { TimezoneSetting } from "./TimezoneSetting.tsx";

const MODES = [
	{
		value: "light",
		label: "Light",
		image: "/assets/images/settings/ui-light.png",
	},
	{
		value: "dark",
		label: "Dark",
		image: "/assets/images/settings/ui-dark.png",
	},
	{
		value: "system",
		label: "System",
		image: "/assets/images/settings/ui-system.png",
	},
] as const;

const COLOR_FIELDS: Array<{ key: keyof CustomTokens; label: string }> = [
	{ key: "background", label: "Background" },
	{ key: "foreground", label: "Foreground" },
	{ key: "primary", label: "Primary" },
	{ key: "muted", label: "Muted" },
	{ key: "mutedForeground", label: "Muted text" },
	{ key: "border", label: "Border" },
	{ key: "sidebar", label: "Sidebar" },
];

// Quick-pick accent colors for the primary token, per mode. Selecting one sets
// `--primary` through the same token-change flow as the custom picker, so it
// participates in the dirty/save logic. The custom picker is the last option.
const PRIMARY_PRESETS: Array<{
	name: string;
	label: string;
	light: string;
	dark: string;
}> = [
	{ name: "ryu", label: "Ryu Blue", light: "#0099ff", dark: "#0099ff" },
	{ name: "blue", label: "Blue", light: "#2563eb", dark: "#60a5fa" },
	{ name: "violet", label: "Violet", light: "#7c3aed", dark: "#a78bfa" },
	{ name: "green", label: "Green", light: "#16a34a", dark: "#4ade80" },
	{ name: "orange", label: "Orange", light: "#ea580c", dark: "#fb923c" },
	{ name: "red", label: "Red", light: "#dc2626", dark: "#ef4444" },
	{ name: "rose", label: "Rose", light: "#e11d48", dark: "#fb7185" },
	{ name: "neutral", label: "Neutral", light: "#18181b", dark: "#fafafa" },
];

const CUSTOM_SWATCH_GRADIENT =
	"conic-gradient(from 0deg, #ef4444, #f59e0b, #10b981, #3b82f6, #8b5cf6, #ef4444)";

const OKLCH_RE = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/;
const HEX_6_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_3_RE = /^#[0-9a-fA-F]{3}$/;
const RGBA_CHANNEL_RE = /rgba?\((\d+),\s*(\d+),\s*(\d+)/;

function getLuminance(hex: string): number {
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function getContrastColor(hex: string): string {
	if (!HEX_6_RE.test(hex)) {
		return "#ffffff";
	}
	return getLuminance(hex) > 0.5 ? "#000000" : "#ffffff";
}

function channelToHex(v: number): string {
	return Math.round(Math.min(1, Math.max(0, v)) * 255)
		.toString(16)
		.padStart(2, "0");
}

function linearToSrgb(x: number): number {
	return x <= 0.003_130_8 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

// Full OKLCH -> sRGB hex conversion (Björn Ottosson's OKLab matrices). Handles
// chromatic colors, not just near-grey, so the settings swatch matches the real
// `--primary` the theme applies. Lightness may be given as a 0-1 number or a %.
function oklchToHex(lRaw: string, cRaw: string, hRaw: string): string {
	const l = lRaw.endsWith("%") ? Number.parseFloat(lRaw) / 100 : Number(lRaw);
	const c = Number(cRaw);
	const h = Number(hRaw);
	const hRad = (h * Math.PI) / 180;
	const a = c * Math.cos(hRad);
	const b = c * Math.sin(hRad);

	const lp = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
	const mp = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
	const sp = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;

	const r = 4.076_741_662_1 * lp - 3.307_711_591_3 * mp + 0.230_969_929_2 * sp;
	const g = -1.268_438_004_6 * lp + 2.609_757_401_1 * mp - 0.341_319_396_5 * sp;
	const bb = -0.004_196_086_3 * lp - 0.703_418_614_7 * mp + 1.707_614_701 * sp;

	return `#${channelToHex(linearToSrgb(r))}${channelToHex(linearToSrgb(g))}${channelToHex(linearToSrgb(bb))}`;
}

function colorToHex(color: string): string {
	if (HEX_6_RE.test(color)) {
		return color;
	}
	if (HEX_3_RE.test(color)) {
		const r = color[1];
		const g = color[2];
		const b = color[3];
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	const rgba = color.match(RGBA_CHANNEL_RE);
	if (rgba) {
		const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
		return `#${toHex(rgba[1])}${toHex(rgba[2])}${toHex(rgba[3])}`;
	}
	const oklchMatch = color.match(OKLCH_RE);
	if (oklchMatch) {
		return oklchToHex(oklchMatch[1], oklchMatch[2], oklchMatch[3]);
	}
	return "#888888";
}

function tokensAreEqual(a: CustomTokens, b: CustomTokens): boolean {
	for (const field of COLOR_FIELDS) {
		if (a[field.key] !== b[field.key]) {
			return false;
		}
	}
	return true;
}

function initTokens(variantId: string): CustomTokens {
	const variant = findVariant(variantId);
	if (!variant) {
		return {
			background: "#ffffff",
			foreground: "#000000",
			primary: "#000000",
			muted: "#f4f4f5",
			mutedForeground: "#71717a",
			border: "#e4e4e7",
			sidebar: "#f9f9f9",
		};
	}
	// Keep the preset's raw CSS colour strings (e.g. `oklch(1 0 0 / 10%)` for a
	// dark border). These are what get re-applied live and saved, so they MUST
	// stay lossless — converting to 6-digit hex here dropped the alpha channel
	// and collapsed translucent borders/inputs to solid #ffffff (white outlines
	// + blown-out muted surfaces in dark mode). Hex is a display-only concern,
	// handled in the colour fields via `colorToHex`.
	return variantToCustomTokens(variant);
}

function PresetSwatch({
	bg,
	surface,
	primary,
}: {
	bg: string;
	surface: string;
	primary: string;
}) {
	return (
		<span
			className="inline-flex flex-shrink-0 flex-col overflow-hidden rounded border border-border/60"
			style={{ width: 32, height: 20 }}
		>
			<span className="block flex-1" style={{ backgroundColor: bg }} />
			<span className="block" style={{ backgroundColor: surface, height: 5 }} />
			<span className="block" style={{ backgroundColor: primary, height: 4 }} />
		</span>
	);
}

function PresetSelectItem({ variant }: { variant: ThemeVariant }) {
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
const PRESET_GROUP_LABELS: Record<keyof GroupedVariants, string> = {
	custom: "My themes",
	plugin: "Installed",
	builtin: "Built-in",
};

const PRESET_GROUP_ORDER = ["custom", "plugin", "builtin"] as const;

/**
 * Hand the user a publishable plugin manifest for one of their own themes.
 *
 * Sharing a theme is publishing a plugin here — there is no theme-shaped upload
 * endpoint, because a theme IS a plugin that contributes one. The clipboard is the
 * whole handoff: what comes back is a complete `manifest.json`, so the next step is
 * the same `ryu publish` any other plugin author runs.
 */
async function shareTheme(variant: ThemeVariant) {
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
function PresetSelectGroups({ groups }: { groups: GroupedVariants }) {
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

function ColorField({
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
	// `value` may be a raw preset string (oklch/rgba, possibly translucent). The
	// swatch + picker only speak 6-digit hex, so derive a display hex here — the
	// picker emitting an opaque hex on edit is the user's explicit choice.
	const hexVal = colorToHex(value);
	const textColor = getContrastColor(hexVal);

	return (
		<div className="flex items-center gap-3">
			<label
				className="w-24 flex-shrink-0 text-muted-foreground text-xs"
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
						className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded border border-border px-2 font-mono text-xs transition-opacity hover:opacity-90"
						id={`${mode}-${fieldKey}`}
						style={{ backgroundColor: hexVal, color: textColor }}
					>
						{hexVal}
					</ColorPickerTrigger>
					<ColorPickerContent className="z-50">
						<ColorPickerArea />
						<ColorPickerHueSlider />
						<ColorPickerEyeDropper />
						<ColorPickerFormatSelect />
						<ColorPickerInput />
					</ColorPickerContent>
				</ColorPicker>
			</div>
		</div>
	);
}

function PrimaryColorField({
	mode,
	value,
	onChange,
}: {
	mode: "light" | "dark";
	value: string;
	onChange: (key: keyof CustomTokens, val: string) => void;
}) {
	// `value` may be a raw preset string (oklch). Derive a display hex so the
	// swatch renders and preset-matching works; the picker still emits hex.
	const hexVal = colorToHex(value);
	const matchesPreset = PRIMARY_PRESETS.some(
		(p) => (mode === "light" ? p.light : p.dark).toLowerCase() === hexVal
	);

	return (
		<div className="flex items-start gap-3">
			<span className="w-24 flex-shrink-0 pt-1 text-muted-foreground text-xs">
				Primary
			</span>
			<div className="flex flex-1 flex-wrap items-center gap-1.5">
				{PRIMARY_PRESETS.map((p) => {
					const swatch = mode === "light" ? p.light : p.dark;
					const selected = swatch.toLowerCase() === hexVal;
					return (
						<button
							aria-label={`Set primary to ${p.label}`}
							className={cn(
								"size-6 rounded-md border-2 transition-all hover:scale-105",
								selected
									? "border-ring ring-2 ring-ring ring-offset-1 ring-offset-background"
									: "border-border hover:border-ring/50"
							)}
							key={p.name}
							onClick={() => onChange("primary", swatch)}
							style={{ backgroundColor: swatch }}
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
						aria-label="Custom primary color"
						className={cn(
							"flex size-6 cursor-pointer items-center justify-center rounded-md border-2 transition-all hover:scale-105",
							matchesPreset
								? "border-border hover:border-ring/50"
								: "border-ring ring-2 ring-ring ring-offset-1 ring-offset-background"
						)}
						style={{
							background: matchesPreset ? CUSTOM_SWATCH_GRADIENT : hexVal,
						}}
						title="Custom color"
					/>
					<ColorPickerContent className="z-50">
						<ColorPickerArea />
						<ColorPickerHueSlider />
						<ColorPickerEyeDropper />
						<ColorPickerFormatSelect />
						<ColorPickerInput />
					</ColorPickerContent>
				</ColorPicker>
			</div>
		</div>
	);
}

interface ThemePanelProps {
	baseTokens: CustomTokens;
	dirty: boolean;
	groups: GroupedVariants;
	label: string;
	mode: "light" | "dark";
	onDeletePreset: (id: string) => void;
	onDiscardClick: () => void;
	onSaveCancel: () => void;
	onSaveClick: () => void;
	onSaveConfirm: () => void;
	onSaveNameChange: (name: string) => void;
	onSelectPreset: (id: string | null) => void;
	onTokenChange: (key: keyof CustomTokens, value: string) => void;
	saveDialogOpen: boolean;
	saveName: string;
	selectedId: string;
	tokens: CustomTokens;
}

function ThemePanel({
	mode,
	label,
	groups,
	selectedId,
	tokens,
	dirty,
	saveDialogOpen,
	saveName,
	onSelectPreset,
	onTokenChange,
	onSaveClick,
	onDeletePreset,
	onDiscardClick,
	onSaveNameChange,
	onSaveConfirm,
	onSaveCancel,
}: ThemePanelProps) {
	const selected = findVariant(selectedId);
	// Hold the id being confirmed, not a bare boolean: picking a different preset
	// mid-confirm then re-selects the state away instead of leaving an armed
	// "Delete" pointed at whatever is now selected.
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	// Only a locally-saved theme can be deleted here. A built-in has no storage to
	// remove, and an installed one belongs to its plugin — that is an uninstall in
	// the Store, not a delete in Appearance. Answered from `groups.custom` rather
	// than `variantSource()` so this stays free: the panel re-renders on every
	// colour-picker drag, and that helper re-reads and re-parses localStorage.
	const canDelete = !dirty && groups.custom.some((v) => v.id === selectedId);
	const confirming = canDelete && confirmDeleteId === selectedId;

	return (
		<div className="space-y-3">
			<div>
				<h3 className="mb-1 font-medium text-sm">{label} theme</h3>
				<p className="mb-2 text-muted-foreground text-xs">
					Used when {mode} mode is active.
				</p>
				<div className="flex items-center gap-2">
					<Select
						onValueChange={onSelectPreset}
						value={dirty ? "" : selectedId}
					>
						<SelectTrigger className="h-9 w-full text-sm">
							{dirty ? (
								<span className="flex items-center gap-2">
									<PresetSwatch
										bg={tokens.background}
										primary={tokens.primary}
										surface={tokens.sidebar}
									/>
									<span className="text-muted-foreground italic">
										Unsaved theme
									</span>
								</span>
							) : selected ? (
								<span className="flex items-center gap-2">
									<PresetSwatch
										bg={selected.preview.bg}
										primary={selected.preview.primary}
										surface={selected.preview.surface}
									/>
									<span>{selected.label}</span>
								</span>
							) : (
								// The stored id resolves to no known variant — its theme
								// plugin was uninstalled, or the preset was renamed. A bare
								// <SelectValue /> here would print that dead id verbatim,
								// because Base UI resolves the closed trigger from the root's
								// `items` prop and this root has none (the list is grouped).
								<span className="text-muted-foreground italic">
									Select a theme
								</span>
							)}
						</SelectTrigger>
						<SelectContent>
							<PresetSelectGroups groups={groups} />
						</SelectContent>
					</Select>
					{canDelete && !confirming && (
						<>
							<Button
								aria-label={`Share ${selected?.label ?? "theme"}`}
								className="h-9 w-9 flex-shrink-0"
								onClick={() => selected && shareTheme(selected)}
								size="icon"
								title="Copy a publishable plugin manifest for this theme"
								variant="ghost"
							>
								<HugeiconsIcon icon={Share08Icon} size={14} />
							</Button>
							<Button
								aria-label={`Delete ${selected?.label ?? "theme"}`}
								className="h-9 w-9 flex-shrink-0"
								onClick={() => setConfirmDeleteId(selectedId)}
								size="icon"
								title={`Delete ${selected?.label ?? "theme"}`}
								variant="ghost"
							>
								<HugeiconsIcon icon={Delete02Icon} size={14} />
							</Button>
						</>
					)}
				</div>
				{confirming && (
					<div className="mt-2 flex items-center gap-2">
						<span className="flex-1 text-muted-foreground text-xs">
							Delete “{selected?.label}”?
						</span>
						<Button
							className="h-7 px-2 text-xs"
							onClick={() => {
								setConfirmDeleteId(null);
								onDeletePreset(selectedId);
							}}
							size="sm"
							variant="destructive"
						>
							Delete
						</Button>
						<Button
							className="h-7 px-2 text-xs"
							onClick={() => setConfirmDeleteId(null)}
							size="sm"
							variant="ghost"
						>
							Cancel
						</Button>
					</div>
				)}
			</div>

			<div className="space-y-1.5">
				{COLOR_FIELDS.map(({ key, label: fieldLabel }) =>
					key === "primary" ? (
						<PrimaryColorField
							key={key}
							mode={mode}
							onChange={onTokenChange}
							value={tokens.primary}
						/>
					) : (
						<ColorField
							fieldKey={key}
							key={key}
							label={fieldLabel}
							mode={mode}
							onChange={onTokenChange}
							value={tokens[key]}
						/>
					)
				)}
			</div>

			{dirty && !saveDialogOpen && (
				<div className="flex gap-2">
					<Button
						className="h-7 flex-1 text-xs"
						onClick={onSaveClick}
						size="sm"
						variant="default"
					>
						<HugeiconsIcon className="mr-1" icon={FloppyDiskIcon} size={12} />
						Save as preset
					</Button>
					<Button
						className="h-7 text-xs"
						onClick={onDiscardClick}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="mr-1" icon={Cancel01Icon} size={12} />
						Discard
					</Button>
				</div>
			)}

			{saveDialogOpen && (
				<div className="flex items-center gap-2">
					<Input
						autoFocus
						className="h-7 flex-1 text-xs"
						onChange={(e) => onSaveNameChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								onSaveConfirm();
							}
							if (e.key === "Escape") {
								onSaveCancel();
							}
						}}
						placeholder="Preset name..."
						value={saveName}
					/>
					<Button
						className="h-7 px-2 text-xs"
						disabled={!saveName.trim()}
						onClick={onSaveConfirm}
						size="sm"
						variant="default"
					>
						Save
					</Button>
					<Button
						className="h-7 px-2 text-xs"
						onClick={onSaveCancel}
						size="sm"
						variant="ghost"
					>
						Cancel
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * The stepped Detail level control — the same `RangeSlider` the composer's
 * reasoning-effort picker uses (`EffortSliderRow`), so a level ladder reads the
 * same everywhere in the app: one detent per level, the active level named above
 * the track, every level captioned below it, painted with the shared cool → hot
 * fill ramp (`level-ramp.ts`). `LEVEL_RAMP_CLASS` on the wrapper is load-bearing:
 * it declares the variable the ramp's top stop resolves against, and without it
 * the whole `color-mix` is invalid and the fill silently vanishes.
 *
 * "Custom" is shown as the value label with the thumb parked on the nearest
 * level; the slider stays live, so moving it commits that level and clears the
 * custom state.
 */
function ToolDetailSlider({
	preset,
	step,
	onStepChange,
}: {
	onStepChange: (next: number) => void;
	preset: ToolDetailValue;
	step: number;
}) {
	const activeLabel =
		preset === "custom"
			? "Custom"
			: (TOOL_DETAIL_STEPS.find((s) => s.id === preset)?.label ?? "");

	return (
		<div className={cn("flex w-[220px] flex-col gap-1.5", LEVEL_RAMP_CLASS)}>
			<div className="flex items-center justify-end">
				<span className="truncate text-foreground text-xs">{activeLabel}</span>
			</div>
			<RangeSlider
				aria-label="Detail level"
				className="h-8"
				fillColor={levelFillColor(step, TOOL_DETAIL_STEPS.length)}
				formatValueText={(v) =>
					TOOL_DETAIL_STEPS[Math.round(v)]?.label ?? String(v)
				}
				max={TOOL_DETAIL_STEPS.length - 1}
				min={0}
				onValueChange={onStepChange}
				step={1}
				value={step}
			/>
			<div className="flex items-center justify-between gap-1">
				{TOOL_DETAIL_STEPS.map((s, i) => (
					<span
						className={cn(
							"flex-1 truncate text-[10px] leading-none",
							i === 0 && "text-left",
							i === TOOL_DETAIL_STEPS.length - 1 && "text-right",
							i > 0 && i < TOOL_DETAIL_STEPS.length - 1 && "text-center",
							preset !== "custom" && i === step
								? "text-foreground"
								: "text-muted-foreground/70"
						)}
						key={s.id}
					>
						{s.label}
					</span>
				))}
			</div>
		</div>
	);
}

function NotificationLayoutSlider({
	onStepChange,
	step,
}: {
	onStepChange: (next: number) => void;
	step: number;
}) {
	const activeLabel = NOTIFICATION_LAYOUT_STEPS[step]?.label ?? "Unified";

	return (
		<div className={cn("flex w-[220px] flex-col gap-1.5", LEVEL_RAMP_CLASS)}>
			<div className="flex items-center justify-end">
				<span className="truncate text-foreground text-xs">{activeLabel}</span>
			</div>
			<RangeSlider
				aria-label="Notification layout"
				className="h-8"
				fillColor={levelFillColor(step, NOTIFICATION_LAYOUT_STEPS.length)}
				formatValueText={(value) =>
					NOTIFICATION_LAYOUT_STEPS[Math.round(value)]?.label ?? String(value)
				}
				max={NOTIFICATION_LAYOUT_STEPS.length - 1}
				min={0}
				onValueChange={onStepChange}
				step={1}
				value={step}
			/>
			<div className="flex items-center justify-between gap-1">
				{NOTIFICATION_LAYOUT_STEPS.map((layout, index) => (
					<span
						className={cn(
							"flex-1 truncate text-[10px] leading-none",
							index === 0 && "text-left",
							index === NOTIFICATION_LAYOUT_STEPS.length - 1 && "text-right",
							index > 0 &&
								index < NOTIFICATION_LAYOUT_STEPS.length - 1 &&
								"text-center",
							index === step ? "text-foreground" : "text-muted-foreground/70"
						)}
						key={layout.id}
					>
						{layout.label}
					</span>
				))}
			</div>
		</div>
	);
}

// Diff viewer (`@pierre/diffs`) option lists for the Appearance selects.
const DIFF_STYLE_OPTIONS = [
	{ value: "split", label: "Split (side-by-side)" },
	{ value: "unified", label: "Stacked (inline)" },
] as const;
const DIFF_INDICATOR_OPTIONS = [
	{ value: "bars", label: "Bars" },
	{ value: "classic", label: "Classic (+/−)" },
	{ value: "none", label: "None" },
] as const;
const DIFF_LINE_DIFF_OPTIONS = [
	{ value: "word", label: "Word" },
	{ value: "word-alt", label: "Word (alternate)" },
	{ value: "char", label: "Character" },
	{ value: "none", label: "Off" },
] as const;
const DIFF_HUNK_SEPARATOR_OPTIONS = [
	{ value: "simple", label: "Simple" },
	{ value: "metadata", label: "Metadata" },
	{ value: "line-info", label: "Line info" },
	{ value: "line-info-basic", label: "Line info (basic)" },
] as const;
const DIFF_THEME_OPTIONS = [
	{ value: "system", label: "Auto (match app)" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
] as const;

// A tiny single-file patch rendered live in the Diff viewer settings section so
// changes (layout, markers, wrap, …) are visible instantly. Covers context,
// additions and deletions so every indicator has something to show.
const DIFF_PREVIEW_PATCH = `diff --git a/greeting.ts b/greeting.ts
index 1a2b3c4..5d6e7f8 100644
--- a/greeting.ts
+++ b/greeting.ts
@@ -1,4 +1,4 @@
 export function greeting(name: string) {
-  const message = "Hello, " + name;
-  return message;
+  const message = \`Hello, \${name}!\`;
+  return message.trim();
 }
`;

// File tree (`@pierre/trees`) option lists for the Appearance selects.
const FILE_TREE_DENSITY_OPTIONS = [
	{ value: "compact", label: "Compact" },
	{ value: "default", label: "Default" },
	{ value: "relaxed", label: "Relaxed" },
] as const;
const FILE_TREE_ICON_OPTIONS = [
	{ value: "standard", label: "Standard" },
	{ value: "minimal", label: "Minimal" },
	{ value: "complete", label: "Complete" },
	{ value: "none", label: "No icons" },
] as const;
const FILE_TREE_SEARCH_MODE_OPTIONS = [
	{ value: "expand-matches", label: "Expand matches" },
	{ value: "collapse-non-matches", label: "Collapse non-matches" },
	{ value: "hide-non-matches", label: "Hide non-matches" },
] as const;
const FILE_TREE_EXPANSION_OPTIONS = [
	{ value: "closed", label: "Collapsed" },
	{ value: "open", label: "Expanded" },
] as const;

// A small sample tree rendered live in the File tree settings section.
const FILE_TREE_PREVIEW_PATHS = [
	"src/components/Button.tsx",
	"src/components/Card.tsx",
	"src/hooks/useTheme.ts",
	"src/index.ts",
	"package.json",
	"README.md",
] as const;

// The preview builds its model from static paths, so no `resetPaths` is needed;
// remounting it (via a `key` on the prefs) applies the constructor-time options.
function FileTreePreview({
	prefs,
	style,
}: {
	prefs: FileTreePrefs;
	style?: CSSProperties;
}) {
	const { model } = useFileTree({
		...fileTreePrefsToOptions(prefs),
		paths: FILE_TREE_PREVIEW_PATHS as unknown as string[],
	});
	return <FileTree className="h-full w-full" model={model} style={style} />;
}

const SEASON_OPTIONS = [
	{ value: "auto", label: "Automatic" },
	...SEASONS.map((s) => ({
		value: s.id,
		label: `${getSeasonDisplayEmoji(s)} ${s.label}`,
	})),
];

/**
 * The seasonal titlebar effects: the on/off switch, which season to show, and a
 * timed preview so a season can be seen without waiting for its date.
 *
 * Both rows follow the Motion master switch — falling particles are an
 * animation, so "Enable animations" (and the OS reduce-motion preference, which
 * overrides everything) must turn them off too.
 */
function SeasonalEffectsSettings() {
	const [animationsEnabled] = usePersistedToggle(
		APPEARANCE_KEYS.animationsEnabled,
		APPEARANCE_DEFAULTS.animationsEnabled
	);
	const [seasonalEffects, setSeasonalEffects] = usePersistedToggle(
		APPEARANCE_KEYS.seasonalEffects,
		APPEARANCE_DEFAULTS.seasonalEffects
	);
	const seasonSetting = useSeasonalThemeSetting();
	const previewing = usePreviewSeasonalTheme();

	// Releasing on unmount matters: close Settings mid-preview and the titlebar
	// would otherwise stay stuck on the previewed season until the timer fires.
	useEffect(() => () => previewSeasonalTheme(null), []);

	// A pinned season previews itself. "Automatic" previews whatever season is
	// running today — and on the ~340 days a year when that is none, it falls
	// back to Christmas rather than leaving the one button whose whole job is
	// "show me the effect without waiting for December" permanently dead.
	const previewTarget =
		seasonSetting === "auto"
			? (getCurrentSeason()?.id ?? "christmas")
			: seasonSetting;

	return (
		<SettingsSection title="Seasonal effects">
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={seasonalEffects}
							disabled={!animationsEnabled}
							id="seasonal-effects-toggle"
							onCheckedChange={setSeasonalEffects}
						/>
					}
					description="Drift festive particles down the titlebar around holidays: snow in December, confetti on New Year's Eve, pumpkins through October. Requires “Enable animations” to be on, and never runs while your system asks for reduced motion."
					title="Seasonal effects"
				/>
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							<Select
								items={SEASON_OPTIONS}
								onValueChange={(v) =>
									setSeasonalThemeSetting(v as SeasonalThemeSetting)
								}
								value={seasonSetting}
							>
								<SelectTrigger
									className="h-8 w-56 text-sm"
									disabled={!(animationsEnabled && seasonalEffects)}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SEASON_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								disabled={!(animationsEnabled && previewTarget) || !!previewing}
								onClick={() =>
									previewTarget && previewSeasonalTheme(previewTarget)
								}
								size="sm"
								variant="ghost"
							>
								{previewing ? "Previewing…" : "Preview"}
							</Button>
						</div>
					}
					description="Automatic follows the calendar. Pin a season to keep it running all year. Preview shows the selected season in the titlebar for a few seconds. It works even while the switch above is off."
					title="Season"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

export function AppearanceTab() {
	// A settings-search hit may name a row on a sub-page that is currently
	// closed — and therefore not in the DOM the reveal polls. This says which
	// page to open first.
	const pendingSubpage = usePendingSubpage("appearance");
	const { theme, setTheme } = useTheme();
	// next-themes' setter lives in React; bind it so registry reset can call it.
	useEffect(() => {
		bindAppearanceThemeMode(setTheme);
		return () => bindAppearanceThemeMode(null);
	}, [setTheme]);
	const pointerCursorEnabled = usePointerCursor();
	const chromeShadowsEnabled = useChromeShadows();
	const dialogOverlayBlurEnabled = useDialogOverlayBlur();
	const popupOverlayBlurEnabled = usePopupOverlayBlur();
	const invertedBackgroundsEnabled = useInvertedBackgrounds();
	const [friendlyNames, setFriendlyNames] = useFriendlyMode();
	const interfaceLevel = useInterfaceLevel();
	const [botTerminology, setBotTerminologyEnabled] = useBotTerminology();
	const botTerminologyForced = interfaceLevel === "simple";
	const [groupChatsByDate, setGroupChatsByDate] = useChatDateGrouping();
	const [sidebarGroupedNav, setSidebarGroupedNav] = useSidebarGroupedNav();
	// The STORED choice, not the drawn one: Bot mode forces messaging rows, and a
	// switch that flipped itself on when the user picked a sidebar mode would have
	// nothing left to restore when they left it.
	const agentRowStyle = useAgentRowStylePref();
	const [sidebarChatPreview, setSidebarChatPreview] = useSidebarChatPreview();
	const [chatPickerPlacement, setChatPickerPlacement] =
		useChatPickerPlacement();
	const [markdownComposer, setMarkdownComposer] = usePersistedToggle(
		APPEARANCE_KEYS.markdownComposer,
		APPEARANCE_DEFAULTS.markdownComposer
	);
	// Only the contributed half: the three built-in modes have their own switches
	// above, worded for what they actually do.
	const contributedModes = useSidebarModes().modes.filter((m) =>
		m.key.startsWith("plugin:")
	);
	const [sidebarMode, setSidebarMode] = useSidebarMode();
	const [sidebarVariant, setSidebarVariant] = useSidebarVariant();
	const [sidebarOverflowPopover, setSidebarOverflowPopover] =
		usePersistedToggle(
			APPEARANCE_KEYS.sidebarOverflowPopover,
			APPEARANCE_DEFAULTS.sidebarOverflowPopover
		);
	const [tabDropdown, setTabDropdown] = useTabDropdown();
	const [tabSearchButtonVisible, setTabSearchButtonVisible] =
		usePersistedToggle(
			APPEARANCE_KEYS.tabSearchButton,
			APPEARANCE_DEFAULTS.tabSearchButton
		);
	const notificationLayout = useNotificationLayout();
	const notificationLayoutStep =
		notificationLayoutStepIndex(notificationLayout);
	const handleNotificationLayoutStep = useCallback((next: number) => {
		const layout = NOTIFICATION_LAYOUT_STEPS[Math.round(next)]?.id;
		if (layout) {
			setNotificationLayout(layout);
		}
	}, []);
	const [nodeSelectorDetail, setNodeSelectorDetail] = usePersistedToggle(
		APPEARANCE_KEYS.nodeSelectorDetail,
		APPEARANCE_DEFAULTS.nodeSelectorDetail
	);
	const usageBarPrefs = useUsageBarPrefs();
	const [groupToolUses, setGroupToolUses] = usePersistedToggle(
		APPEARANCE_KEYS.groupToolUses,
		APPEARANCE_DEFAULTS.groupToolUses
	);
	const [expandFileEdits, setExpandFileEdits] = usePersistedToggle(
		APPEARANCE_KEYS.expandFileEdits,
		APPEARANCE_DEFAULTS.expandFileEdits
	);
	const [expandCommands, setExpandCommands] = usePersistedToggle(
		APPEARANCE_KEYS.expandCommands,
		APPEARANCE_DEFAULTS.expandCommands
	);
	const [expandCodeBlocks, setExpandCodeBlocks] = usePersistedToggle(
		APPEARANCE_KEYS.expandCodeBlocks,
		APPEARANCE_DEFAULTS.expandCodeBlocks
	);
	const [hideToolDetail, setHideToolDetail] = usePersistedToggle(
		APPEARANCE_KEYS.hideToolDetail,
		APPEARANCE_DEFAULTS.hideToolDetail
	);
	const [pinUserMessage, setPinUserMessage] = usePersistedToggle(
		APPEARANCE_KEYS.pinUserMessage,
		APPEARANCE_DEFAULTS.pinUserMessage
	);
	const [openChatAtBottom, setOpenChatAtBottom] = usePersistedToggle(
		APPEARANCE_KEYS.openChatAtBottom,
		APPEARANCE_DEFAULTS.openChatAtBottom
	);
	const [inferenceStats, setInferenceStats] = usePersistedToggle(
		APPEARANCE_KEYS.inferenceStats,
		APPEARANCE_DEFAULTS.inferenceStats
	);
	const [animationsEnabled, setAnimationsEnabled] = usePersistedToggle(
		APPEARANCE_KEYS.animationsEnabled,
		APPEARANCE_DEFAULTS.animationsEnabled
	);
	const [streamAnimation, setStreamAnimation] = usePersistedToggle(
		APPEARANCE_KEYS.streamAnimation,
		APPEARANCE_DEFAULTS.streamAnimation
	);
	const diffPrefs = useDiffViewPrefs();
	const fileTreePrefs = useFileTreePrefs();
	const fileTreeThemeStyles = useFileTreeThemeStyles(fileTreePrefs);

	const toolDetailPreset = deriveToolDetailPreset(
		hideToolDetail,
		groupToolUses,
		expandFileEdits,
		expandCommands,
		expandCodeBlocks
	);
	const applyToolDetailStep = useCallback(
		(id: ToolDetailStepId) => {
			// None writes ONLY the visibility flag: the four expansion toggles keep
			// whatever the user had, so stepping back up restores their setup
			// instead of a preset we picked for them.
			if (id === "none") {
				setHideToolDetail(true);
				return;
			}
			setHideToolDetail(false);
			const preset = TOOL_DETAIL_PRESETS[id];
			setGroupToolUses(preset.group);
			setExpandFileEdits(preset.edits);
			setExpandCommands(preset.commands);
			setExpandCodeBlocks(preset.code);
		},
		[
			setHideToolDetail,
			setGroupToolUses,
			setExpandFileEdits,
			setExpandCommands,
			setExpandCodeBlocks,
		]
	);
	const toolDetailStep = toolDetailStepIndex(
		toolDetailPreset,
		groupToolUses,
		expandFileEdits,
		expandCommands,
		expandCodeBlocks
	);
	const handleToolDetailStep = useCallback(
		(next: number) => {
			const picked = TOOL_DETAIL_STEPS[Math.round(next)];
			if (picked) {
				applyToolDetailStep(picked.id);
			}
		},
		[applyToolDetailStep]
	);
	// Auto-reveal Advanced when the current combo matches no preset, so a "custom"
	// state is never hidden behind a collapsed section.
	const [toolDetailAdvancedOpen, setToolDetailAdvancedOpen] = useState(
		toolDetailPreset === "custom"
	);

	const [lightPresetId, setLightPresetId] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID
	);
	const [darkPresetId, setDarkPresetId] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID
	);
	const [lightTokens, setLightTokens] = useState<CustomTokens>(() =>
		initTokens(
			localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID
		)
	);
	const [darkTokens, setDarkTokens] = useState<CustomTokens>(() =>
		initTokens(localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID)
	);
	const [lightBaseTokens, setLightBaseTokens] = useState<CustomTokens>(() =>
		initTokens(
			localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID
		)
	);
	const [darkBaseTokens, setDarkBaseTokens] = useState<CustomTokens>(() =>
		initTokens(localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID)
	);
	const lightDirty = !tokensAreEqual(lightTokens, lightBaseTokens);
	const darkDirty = !tokensAreEqual(darkTokens, darkBaseTokens);

	const [lightGroups, setLightGroups] = useState<GroupedVariants>(() =>
		getGroupedVariants("light")
	);
	const [darkGroups, setDarkGroups] = useState<GroupedVariants>(() =>
		getGroupedVariants("dark")
	);

	const [uiFont, setUiFontState] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.uiFont) ?? UI_FONTS[0].value
	);
	const [headingFont, setHeadingFontState] = useState<string>(
		() =>
			localStorage.getItem(STORAGE_KEYS.headingFont) ?? HEADING_FONTS[0].value
	);
	const [codeFont, setCodeFontState] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.codeFont) ?? CODE_FONTS[0].value
	);
	const [contrastValue, setContrastValue] = useState<number>(() =>
		Number(localStorage.getItem(STORAGE_KEYS.contrast) ?? "50")
	);
	const [radiusValue, setRadiusValue] = useState<number>(() =>
		Number(localStorage.getItem(STORAGE_KEYS.radius) ?? String(DEFAULT_RADIUS))
	);
	const [spacingValue, setSpacingValue] = useState<number>(() =>
		Number(
			localStorage.getItem(STORAGE_KEYS.spacing) ?? String(DEFAULT_SPACING)
		)
	);
	const [scaleValue, setScaleValue] = useState<number>(() =>
		Number(localStorage.getItem(STORAGE_KEYS.scale) ?? String(DEFAULT_SCALE))
	);
	const [cardSpacingValue, setCardSpacingValue] = useState<number>(() =>
		Number(
			localStorage.getItem(STORAGE_KEYS.cardSpacing) ??
				String(DEFAULT_CARD_SPACING)
		)
	);
	const [chatWidthValue, setChatWidthValue] = useState<number>(() =>
		Number(
			localStorage.getItem(STORAGE_KEYS.chatWidth) ?? String(DEFAULT_CHAT_WIDTH)
		)
	);
	const [sidebarWidthValue, setSidebarWidthValue] = useState<number>(() =>
		Number(
			localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? String(DEFAULT_SIDEBAR_WIDTH)
		)
	);

	const [appearanceResetConfirm, setAppearanceResetConfirm] = useState(false);

	const [lightSaveDialog, setLightSaveDialog] = useState(false);
	const [darkSaveDialog, setDarkSaveDialog] = useState(false);
	const [lightSaveName, setLightSaveName] = useState("");
	const [darkSaveName, setDarkSaveName] = useState("");

	const handleLightPreset = useCallback((id: string | null) => {
		if (!id) {
			return;
		}
		const tokens = initTokens(id);
		setLightPresetId(id);
		setLightTokens(tokens);
		setLightBaseTokens(tokens);
		setLightSaveDialog(false);
		setLightPreset(id);
	}, []);

	const handleDarkPreset = useCallback((id: string | null) => {
		if (!id) {
			return;
		}
		const tokens = initTokens(id);
		setDarkPresetId(id);
		setDarkTokens(tokens);
		setDarkBaseTokens(tokens);
		setDarkSaveDialog(false);
		setDarkPreset(id);
	}, []);

	const handleLightTokenChange = useCallback(
		(key: keyof CustomTokens, value: string) => {
			setLightTokens((prev) => {
				const updated = { ...prev, [key]: value };
				applyCustomTokensLive("light", updated);
				return updated;
			});
		},
		[]
	);

	const handleDarkTokenChange = useCallback(
		(key: keyof CustomTokens, value: string) => {
			setDarkTokens((prev) => {
				const updated = { ...prev, [key]: value };
				applyCustomTokensLive("dark", updated);
				return updated;
			});
		},
		[]
	);

	const handleLightSaveConfirm = useCallback(() => {
		const name = lightSaveName.trim();
		if (!name) {
			return;
		}
		const id = `custom-light-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
		const variant = customTokensToVariant(id, name, "light", lightTokens);
		saveCustomTheme(variant);
		setLightGroups(getGroupedVariants("light"));
		setLightPresetId(id);
		setLightBaseTokens(lightTokens);
		setLightSaveDialog(false);
		setLightSaveName("");
		setLightPreset(id);
	}, [lightSaveName, lightTokens]);

	const handleDarkSaveConfirm = useCallback(() => {
		const name = darkSaveName.trim();
		if (!name) {
			return;
		}
		const id = `custom-dark-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
		const variant = customTokensToVariant(id, name, "dark", darkTokens);
		saveCustomTheme(variant);
		setDarkGroups(getGroupedVariants("dark"));
		setDarkPresetId(id);
		setDarkBaseTokens(darkTokens);
		setDarkSaveDialog(false);
		setDarkSaveName("");
		setDarkPreset(id);
	}, [darkSaveName, darkTokens]);

	// Deleting the ACTIVE preset would otherwise leave a dangling id in
	// localStorage: `findVariant` returns undefined, `initTheme` applies nothing,
	// and the next cold start boots with whatever tokens the stylesheet ships. So
	// deletion always re-selects the shipped default for that mode, which also
	// repaints immediately through the normal preset-change path.
	const handleLightDelete = useCallback(
		(id: string) => {
			deleteCustomTheme(id);
			setLightGroups(getGroupedVariants("light"));
			if (lightPresetId === id) {
				handleLightPreset(DEFAULT_LIGHT_ID);
			}
		},
		[handleLightPreset, lightPresetId]
	);

	const handleDarkDelete = useCallback(
		(id: string) => {
			deleteCustomTheme(id);
			setDarkGroups(getGroupedVariants("dark"));
			if (darkPresetId === id) {
				handleDarkPreset(DEFAULT_DARK_ID);
			}
		},
		[handleDarkPreset, darkPresetId]
	);

	const handleLightDiscard = useCallback(() => {
		// Re-apply the saved preset variant (not customTokensToVariant on the
		// 7 base fields). customTokensToVariant invents primary-foreground and
		// would leave Switch thumbs / primary ink wrong after a swatch edit.
		setLightTokens(lightBaseTokens);
		setLightSaveDialog(false);
		setLightPreset(lightPresetId);
	}, [lightBaseTokens, lightPresetId]);

	const handleDarkDiscard = useCallback(() => {
		setDarkTokens(darkBaseTokens);
		setDarkSaveDialog(false);
		setDarkPreset(darkPresetId);
	}, [darkBaseTokens, darkPresetId]);

	const handleUiFont = (value: string | null) => {
		if (!value) {
			return;
		}
		setUiFontState(value);
		setUiFont(value);
	};

	const handleHeadingFont = (value: string | null) => {
		if (!value) {
			return;
		}
		setHeadingFontState(value);
		setHeadingFont(value);
	};

	const handleCodeFont = (value: string | null) => {
		if (!value) {
			return;
		}
		setCodeFontState(value);
		setCodeFont(value);
	};

	const handleContrast = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? 50)
			: (vals as number);
		setContrastValue(value);
		setContrast(value);
	};

	const handleRadius = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? DEFAULT_RADIUS)
			: (vals as number);
		setRadiusValue(value);
		setRadius(value);
	};

	const handleSpacing = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? DEFAULT_SPACING)
			: (vals as number);
		setSpacingValue(value);
		setSpacing(value);
	};

	const handleScale = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? DEFAULT_SCALE)
			: (vals as number);
		setScaleValue(value);
		setScale(value);
	};

	const handleCardSpacing = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? DEFAULT_CARD_SPACING)
			: (vals as number);
		setCardSpacingValue(value);
		setCardSpacing(value);
	};

	const handleChatWidth = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? DEFAULT_CHAT_WIDTH)
			: (vals as number);
		setChatWidthValue(value);
		setChatWidth(value);
	};

	const handleSidebarWidth = (vals: number | readonly number[]) => {
		const value = Array.isArray(vals)
			? ((vals as number[])[0] ?? DEFAULT_SIDEBAR_WIDTH)
			: (vals as number);
		setSidebarWidthValue(value);
		setSidebarWidthSetting(value);
	};

	const resetAppearanceDefaults = () => {
		// Registry owns every appearance preference — adding a setting means
		// registering it in appearance-settings.ts, not extending this list.
		resetAppearanceSettings();

		// Sync local useState mirrors (sliders / font selects / preset editors).
		// Hook-backed toggles update themselves via their external stores.
		const lightTok = initTokens(APPEARANCE_DEFAULTS.lightPreset);
		setLightPresetId(APPEARANCE_DEFAULTS.lightPreset);
		setLightTokens(lightTok);
		setLightBaseTokens(lightTok);
		setLightSaveDialog(false);
		const darkTok = initTokens(APPEARANCE_DEFAULTS.darkPreset);
		setDarkPresetId(APPEARANCE_DEFAULTS.darkPreset);
		setDarkTokens(darkTok);
		setDarkBaseTokens(darkTok);
		setDarkSaveDialog(false);
		setUiFontState(APPEARANCE_DEFAULTS.uiFont);
		setHeadingFontState(APPEARANCE_DEFAULTS.headingFont);
		setCodeFontState(APPEARANCE_DEFAULTS.codeFont);
		setContrastValue(APPEARANCE_DEFAULTS.contrast);
		setRadiusValue(APPEARANCE_DEFAULTS.radius);
		setSpacingValue(APPEARANCE_DEFAULTS.spacing);
		setScaleValue(APPEARANCE_DEFAULTS.scale);
		setCardSpacingValue(DEFAULT_CARD_SPACING);
		setChatWidthValue(APPEARANCE_DEFAULTS.chatWidth);
		setSidebarWidthValue(APPEARANCE_DEFAULTS.sidebarWidth);

		setAppearanceResetConfirm(false);
	};

	// ── Sub-pages ────────────────────────────────────────────────────────────
	// Appearance is the longest pane in the app: eleven groups and ~1,200 lines
	// of controls in a single scroll, where finding "line numbers" meant knowing
	// it was a diff-viewer setting and then scrolling past ninety others. The
	// Apple answer to a pane this size is not a longer scroll — it is a short
	// index that pushes one page per topic, so that is what this is.
	//
	// Theme and colour stay on the index rather than behind a row: they are what
	// this pane is FOR, and a settings pane whose headline setting is one click
	// away has organised itself at the user's expense.
	//
	// The bodies below are the same nodes as before, moved verbatim. If you add a
	// group, add it here AND to `APPEARANCE_SUBPAGE_BY_GROUP` in
	// `settings-index.ts` — that map is what lets settings search reveal a row
	// that is currently behind a closed page.
	const themeIntro = (
		<div className="space-y-6">
			<SettingsSection
				caption="Choose how Ryu looks on your device."
				title="Theme"
			>
				<SettingsCard className="flex gap-4">
					{MODES.map(({ value, label, image }) => (
						<label
							className="flex cursor-pointer flex-col items-center gap-2"
							key={value}
						>
							<input
								checked={theme === value}
								className="sr-only"
								name="theme"
								onChange={() => setTheme(value)}
								type="radio"
								value={value}
							/>
							{/* biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: dynamic remote logo URL */}
							<img
								alt={label}
								className={cn(
									"rounded-lg border-2 shadow-md transition-all hover:scale-105",
									theme === value
										? "border-ring ring-2 ring-ring ring-offset-2 ring-offset-background"
										: "border-border hover:border-ring/50"
								)}
								height={70}
								src={image}
								width={88}
							/>
							<span className="flex items-center gap-1 font-medium text-xs">
								{theme === value ? (
									<HugeiconsIcon className="size-3.5" icon={Tick01Icon} />
								) : (
									<span className="size-3.5" />
								)}
								<span
									className={theme === value ? "" : "text-muted-foreground"}
								>
									{label}
								</span>
							</span>
						</label>
					))}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Pick a preset for each mode, or adjust the colors and save your own."
				title="Color theme"
			>
				<SettingsCard className="grid grid-cols-2 gap-6">
					<ThemePanel
						baseTokens={lightBaseTokens}
						dirty={lightDirty}
						groups={lightGroups}
						label="Light"
						mode="light"
						onDeletePreset={handleLightDelete}
						onDiscardClick={handleLightDiscard}
						onSaveCancel={() => setLightSaveDialog(false)}
						onSaveClick={() => setLightSaveDialog(true)}
						onSaveConfirm={handleLightSaveConfirm}
						onSaveNameChange={setLightSaveName}
						onSelectPreset={handleLightPreset}
						onTokenChange={handleLightTokenChange}
						saveDialogOpen={lightSaveDialog}
						saveName={lightSaveName}
						selectedId={lightPresetId}
						tokens={lightTokens}
					/>
					<ThemePanel
						baseTokens={darkBaseTokens}
						dirty={darkDirty}
						groups={darkGroups}
						label="Dark"
						mode="dark"
						onDeletePreset={handleDarkDelete}
						onDiscardClick={handleDarkDiscard}
						onSaveCancel={() => setDarkSaveDialog(false)}
						onSaveClick={() => setDarkSaveDialog(true)}
						onSaveConfirm={handleDarkSaveConfirm}
						onSaveNameChange={setDarkSaveName}
						onSelectPreset={handleDarkPreset}
						onTokenChange={handleDarkTokenChange}
						saveDialogOpen={darkSaveDialog}
						saveName={darkSaveName}
						selectedId={darkPresetId}
						tokens={darkTokens}
					/>
				</SettingsCard>
			</SettingsSection>
		</div>
	);

	const layoutPage = (
		<>
			<SettingsSection title="Layout & sizing">
				<SettingsCard className="space-y-3">
					<div className="space-y-1.5">
						<FluidSlider
							label="Muted contrast"
							max={100}
							min={0}
							onValueChange={handleContrast}
							step={1}
							value={contrastValue}
						/>
						<p className="text-muted-foreground text-xs">
							Center (50) is the preset default. Lower darkens muted surfaces,
							higher brightens them.
						</p>
					</div>

					<FluidSlider
						format={(v) => `${v.toFixed(3)}rem`}
						label="Roundness"
						max={1.5}
						min={0}
						onValueChange={handleRadius}
						step={0.025}
						value={radiusValue}
					/>

					<div className="space-y-1.5">
						<FluidSlider
							format={(v) => `${(v * 100).toFixed(0)}%`}
							label="Scale (UI zoom)"
							max={SCALE_MAX}
							min={SCALE_MIN}
							onValueChange={handleScale}
							step={0.05}
							value={scaleValue}
						/>
						<p className="text-muted-foreground text-xs">
							Scales the whole interface like a browser zoom: text, spacing, and
							everything else. 100% is the default.
						</p>
					</div>

					<div className="space-y-1.5">
						<FluidSlider
							format={(v) => `${v.toFixed(3)}rem`}
							label="Zoom (spacing)"
							max={0.36}
							min={0.16}
							onValueChange={handleSpacing}
							step={0.005}
							value={spacingValue}
						/>
						<p className="text-muted-foreground text-xs">
							Scales the base spacing unit all UI padding, gaps, and sizes
							derive from. {DEFAULT_SPACING}rem is the default; lower compacts
							the interface, higher zooms it in.
						</p>
					</div>

					<div className="space-y-1.5">
						<FluidSlider
							format={(v) => `${v.toFixed(2)}rem`}
							label="Card padding"
							max={1.6}
							min={0.48}
							onValueChange={handleCardSpacing}
							step={0.02}
							value={cardSpacingValue}
						/>
						<p className="text-muted-foreground text-xs">
							Inner padding of cards (header, content, footer).{" "}
							{`${DEFAULT_CARD_SPACING}rem`} is the default; lower tightens
							cards, higher loosens them.
						</p>
					</div>

					<FluidSlider
						format={(v) => `${v}px`}
						label="Chat width"
						max={960}
						min={480}
						onValueChange={handleChatWidth}
						step={10}
						value={chatWidthValue}
					/>

					<FluidSlider
						format={(v) => `${v}px`}
						label="Sidebar width"
						max={MAX_SIDEBAR_WIDTH}
						min={MIN_SIDEBAR_WIDTH}
						onValueChange={handleSidebarWidth}
						step={4}
						value={sidebarWidthValue}
					/>
				</SettingsCard>
			</SettingsSection>

			<BackgroundCustomizationSettings />

			<SettingsSection
				caption="Fonts for the interface and for code."
				title="Typography"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={UI_FONTS}
								onValueChange={handleUiFont}
								value={uiFont}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{UI_FONTS.map((f) => (
										<SelectItem key={f.label} value={f.value}>
											<span style={{ fontFamily: f.value }}>{f.label}</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="UI font"
					/>
					<SettingsItem
						actions={
							<Select
								items={HEADING_FONTS}
								onValueChange={handleHeadingFont}
								value={headingFont}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{HEADING_FONTS.map((f) => (
										<SelectItem key={f.label} value={f.value}>
											<span style={{ fontFamily: f.value }}>{f.label}</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Heading font"
					/>
					<SettingsItem
						actions={
							<Select
								items={CODE_FONTS}
								onValueChange={handleCodeFont}
								value={codeFont}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CODE_FONTS.map((f) => (
										<SelectItem key={f.label} value={f.value}>
											<span style={{ fontFamily: f.value }}>{f.label}</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Code font"
					/>
				</SettingsGroup>
			</SettingsSection>

			<TimezoneSetting />
		</>
	);

	const motionPage = (
		<>
			<SettingsSection title="Motion">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={animationsEnabled}
								id="animations-enabled-toggle"
								onCheckedChange={setAnimationsEnabled}
							/>
						}
						description="Master switch for in-app animations. Turn off for a fully static interface. Your system “reduce motion” setting always overrides this."
						title="Enable animations"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={streamAnimation}
								disabled={!animationsEnabled}
								id="stream-animation-toggle"
								onCheckedChange={setStreamAnimation}
							/>
						}
						description="Fade streaming chat replies in word-by-word as the assistant types. Requires “Enable animations” to be on."
						title="Animate streaming chat text"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SeasonalEffectsSettings />
		</>
	);

	const interfacePage = (
		<>
			<SettingsSection title="Interface">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={friendlyNames}
								id="friendly-names-toggle"
								onCheckedChange={setFriendlyNames}
							/>
						}
						// The description names the two kinds of thing this now covers,
						// because they read as one setting but are not: renaming a MODEL is
						// cosmetic, while renaming an OPTION ("Graph" → "Connected search")
						// changes the word a user will look for in docs, in support, and in
						// this app's own settings. Saying so is what makes turning it off a
						// deliberate choice rather than a mystery, and the last sentence is
						// there because the setting reaches installed apps and plugins too —
						// a user who sees a plugin change wording should know why.
						description="Use everyday wording across the app instead of technical terms. Model and skill names read as plain names rather than raw strings like “gemma-4-E2B-it-GGUF”, and options are named for what they do: a space's retrieval mode reads “Quick search” and “Connected search” rather than “Vector” and “Graph”. Installed apps and plugins follow this too. Turn it off to see the exact technical names everywhere."
						title="Friendly names"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={botTerminologyForced || botTerminology}
								disabled={botTerminologyForced}
								id="bot-terminology-toggle"
								onCheckedChange={setBotTerminologyEnabled}
							/>
						}
						description="Use the Bot vocabulary throughout visible interface copy. Ryu Work mode keeps this on; switch to Code to turn it off."
						title="Use Bot terminology"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={pointerCursorEnabled}
								id="pointer-cursor-toggle"
								onCheckedChange={setPointerCursor}
							/>
						}
						description="Show a pointer cursor when hovering over interactive elements."
						title="Pointer cursor"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={chromeShadowsEnabled}
								id="chrome-shadows-toggle"
								onCheckedChange={setChromeShadows}
							/>
						}
						description="Show drop shadows on the titlebar navigation and action groups and on the floating sidebar. Turn off for a flatter look."
						title="Navigation & sidebar shadows"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={dialogOverlayBlurEnabled}
								id="dialog-overlay-blur-toggle"
								onCheckedChange={setDialogOverlayBlur}
							/>
						}
						description="Dim and blur the app behind dialogs, action dialogs, sheets, and drawers. Off uses a flat transparent look with no backdrop or panel shadow."
						title="Blur dialog backgrounds"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={popupOverlayBlurEnabled}
								id="popup-overlay-blur-toggle"
								onCheckedChange={setPopupOverlayBlur}
							/>
						}
						description="Dim and blur the app behind dropdowns, selects, popovers, context menus, and navigation menus. Off by default for a lighter popup experience."
						title="Blur popup backgrounds"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={invertedBackgroundsEnabled}
								id="inverted-backgrounds-toggle"
								onCheckedChange={setInvertedBackgrounds}
							/>
						}
						description="Use the page background instead of muted/popover colors for tooltips, dropdowns, popovers, selects, and menus."
						title="Invert overlay backgrounds"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={sidebarMode === "tabbed"}
								id="sidebar-tabbed-toggle"
								onCheckedChange={(checked) =>
									setSidebarMode(checked ? "tabbed" : "sections")
								}
							/>
						}
						description="Put the section names (Workflows, Chats, …) in a button bar at the top of the sidebar and show one list at a time. Turn off to stack every section as its own collapsible group."
						title="Tabbed sidebar"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={sidebarMode === "agent"}
								id="sidebar-agent-mode-toggle"
								onCheckedChange={(checked) =>
									setSidebarMode(checked ? "agent" : "sections")
								}
							/>
						}
						description="Use the built-in Agents view: direct threads appear under each bot, with other chats below the roster and messaging-style rows on. Ryu Work selects it automatically; turn it off to return to the full section list."
						title="Agents view"
					/>
					{/* App-registered modes (`contributes.sidebar_modes`). Rendered from the
					    same list the sidebar's own menu offers, so the two cannot disagree
					    about which contributed modes are real. Inert until an enabled app
					    ships one. */}
					{contributedModes.map((mode) => (
						<SettingsItem
							actions={
								<Switch
									checked={sidebarMode === mode.key}
									id={`sidebar-mode-${mode.key}`}
									onCheckedChange={(checked) =>
										setSidebarMode(
											checked ? (mode.key as SidebarMode) : "sections"
										)
									}
								/>
							}
							description={
								mode.description ??
								`Arrange the sidebar as ${mode.title}, offering ${mode.sections?.length ?? 0} section(s) as tabs. Turn off to go back to the full section list.`
							}
							key={mode.key}
							title={mode.title}
						/>
					))}
					<SettingsItem
						actions={
							<Switch
								checked={groupChatsByDate}
								id="group-chats-by-date-toggle"
								onCheckedChange={setGroupChatsByDate}
							/>
						}
						description="Group the sidebar's Chats into Today, Yesterday, Last week, and older buckets (like ChatGPT), each collapsible and reorderable. Applies to every timestamped sidebar list — Chats, a project's chats, a space's pages and files, and app-registered sections. Turn off for flat lists."
						title="Group lists by date"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={sidebarGroupedNav}
								id="sidebar-grouped-nav-toggle"
								onCheckedChange={setSidebarGroupedNav}
							/>
						}
						description="Collapse the Projects and Spaces sections into one picker each, instead of a row per project and per space. “All projects” lists every chat across your projects, “All spaces” every page, database and file across your spaces, and picking one narrows the list to it. Turn off to list every project and space as its own expandable row."
						title="Projects & Spaces as pickers"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={sidebarVariant === "inset"}
								id="sidebar-inset-toggle"
								onCheckedChange={(checked) =>
									setSidebarVariant(checked ? "inset" : "floating")
								}
							/>
						}
						description="Sit the sidebar flush against the window edge and pull the main content in as its own rounded card. Turn off to float the sidebar as a rounded card over a flush canvas."
						title="Inset sidebar"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={agentRowStyle === "messaging"}
								id="agent-row-messaging-toggle"
								onCheckedChange={(checked) =>
									setAgentRowStyle(checked ? "messaging" : "compact")
								}
							/>
						}
						description={
							sidebarMode === "agent"
								? "Draw each agent in the sidebar the way a messaging app does: a large round avatar spanning two lines, the agent's name and the time of its last message on the first, and a preview of that message below. The Agents view draws these rows regardless; this switch is what you return to when you leave it."
								: "Draw each agent in the sidebar the way a messaging app does: a large round avatar spanning two lines, the agent's name and the time of its last message on the first, and a preview of that message below. Turn off for the compact single-line row."
						}
						title="Messaging-style agent rows"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={sidebarChatPreview}
								id="sidebar-chat-preview-toggle"
								onCheckedChange={setSidebarChatPreview}
							/>
						}
						description="Show ordinary chat sessions as two-line rows with their latest message and current tool/run state. The text loop pauses when animations are disabled. The Agents view keeps its own two-line rows regardless of this setting."
						title="Show latest message / tool state in sidebar"
					/>
					<SettingsItem
						actions={
							<Select
								onValueChange={(value) => {
									if (value === "composer" || value === "tab-bar") {
										setChatPickerPlacement(value);
									}
								}}
								value={chatPickerPlacement}
							>
								<SelectTrigger
									className="h-8 w-56 text-sm"
									id="chat-picker-placement-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="composer">In composer</SelectItem>
									<SelectItem value="tab-bar">
										In tab bar actions tray
									</SelectItem>
								</SelectContent>
							</Select>
						}
						description="Choose where the chat model and agent picker appears. The default keeps it in the composer; the tab bar option moves the same picker into the chat tab's actions tray."
						title="Chat model & agent picker"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={markdownComposer}
								id="markdown-composer-toggle"
								onCheckedChange={setMarkdownComposer}
							/>
						}
						description="Use the shared Plate Markdown editor in chat. Pasted Markdown links render as links, can be clicked to edit their URL or display text, and common Markdown blocks and marks render inline. Mentions keep their chat tokens; turn this off to return to the lightweight textarea."
						title="Rich Markdown composer"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={nodeSelectorDetail}
								id="node-selector-detail-toggle"
								onCheckedChange={setNodeSelectorDetail}
							/>
						}
						description="Show live hardware, usage, versions, and service captions in the node command dialog. Turn it off for a faster compact picker; nested engine controls stay available either way."
						title="Detailed node picker"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={sidebarOverflowPopover}
								id="sidebar-overflow-popover-toggle"
								onCheckedChange={setSidebarOverflowPopover}
							/>
						}
						description="When a section has more items than fit, open a searchable, infinite-scrolling popover to the right instead of expanding the list inline with Show more / Show less."
						title="Search overflow in a popover"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={tabDropdown}
								id="tab-dropdown-toggle"
								onCheckedChange={setTabDropdown}
							/>
						}
						description="Replace the full title-bar tab strip with one compact, searchable dropdown for every open tab. Its trigger stays borderless and transparent until you hover it. Turn off to show the full tab strip."
						title="Show tabs as a dropdown"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={tabSearchButtonVisible}
								disabled={tabDropdown}
								id="tab-search-button-toggle"
								onCheckedChange={setTabSearchButtonVisible}
							/>
						}
						description="Show the chevron beside the + tab button when the full tab strip is enabled. It opens a searchable list of every open tab; if you hide it from its context menu, turn this back on here."
						title="Show tab search button"
					/>
					<SettingsItem
						actions={
							<NotificationLayoutSlider
								onStepChange={handleNotificationLayoutStep}
								step={notificationLayoutStep}
							/>
						}
						description={
							NOTIFICATION_LAYOUT_STEPS[notificationLayoutStep]?.description
						}
						title="Notification layout"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const chatPage = (
		<>
			<SettingsSection title="Chat">
				<SettingsGroup>
					<SettingsItem
						actions={
							<ToolDetailSlider
								onStepChange={handleToolDetailStep}
								preset={toolDetailPreset}
								step={toolDetailStep}
							/>
						}
						description="How much of each reply the chat shows. None hides tool calls and file edits entirely, leaving a plain messaging view. Failed steps still show. Compact keeps every tool call collapsed to a row and caps long code blocks; Minimal opens file diffs but keeps command output and code capped; Detailed expands diffs, output and code blocks and lists every call individually. Fine-tune the pieces under Advanced."
						title="Detail level"
					/>
				</SettingsGroup>

				<Collapsible
					onOpenChange={setToolDetailAdvancedOpen}
					open={toolDetailAdvancedOpen}
				>
					<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-[10px] px-3.5 py-2 text-left text-muted-foreground text-xs hover:bg-muted/40">
						<span>Advanced detail</span>
						<HugeiconsIcon
							className={cn(
								"size-4 shrink-0 transition-transform",
								toolDetailAdvancedOpen && "rotate-180"
							)}
							icon={ArrowDown01Icon}
						/>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-1">
						{/* At None there are no tool rows left for the first three to
						    expand, so they are disabled rather than left as switches
						    that flip and change nothing. Their stored values are
						    untouched — step the ladder back up and they apply again
						    exactly as set. "Expand code blocks" stays live: it also
						    governs fenced code in the assistant's own reply. */}
						{hideToolDetail ? (
							<p className="px-3.5 pb-1 text-muted-foreground text-xs">
								Detail level is None, so the chat shows no tool calls to expand.
								Raise the level to use these. Code blocks in replies are still
								shown.
							</p>
						) : null}
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										checked={groupToolUses}
										disabled={hideToolDetail}
										id="group-tool-uses-toggle"
										onCheckedChange={setGroupToolUses}
									/>
								}
								description="Collapse consecutive tool calls into one activity row with a summary. Rich and interactive results stay separate. Turn off to show every call individually."
								title="Group tool uses"
							/>
							<SettingsItem
								actions={
									<Switch
										checked={expandFileEdits}
										disabled={hideToolDetail}
										id="expand-file-edits-toggle"
										onCheckedChange={setExpandFileEdits}
									/>
								}
								description="Show file edit diffs expanded by default. When off, diffs start collapsed and require a click to reveal."
								title="Show file edits expanded"
							/>
							<SettingsItem
								actions={
									<Switch
										checked={expandCommands}
										disabled={hideToolDetail}
										id="expand-commands-toggle"
										onCheckedChange={setExpandCommands}
									/>
								}
								description="Show command output expanded by default. When off, output is capped at a few lines."
								title="Auto-expand commands"
							/>
							<SettingsItem
								actions={
									// NOT disabled at None: this one reaches past tool rows
									// into fenced code inside the assistant's own markdown
									// (see markdown.tsx), which None still renders.
									<Switch
										checked={expandCodeBlocks}
										id="expand-code-blocks-toggle"
										onCheckedChange={setExpandCodeBlocks}
									/>
								}
								description="Show code blocks in replies at full height. When off, a long block is capped and scrolls inside its own box so it cannot bury the rest of the answer."
								title="Expand code blocks"
							/>
						</SettingsGroup>
					</CollapsibleContent>
				</Collapsible>

				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={pinUserMessage}
								id="pin-user-message-toggle"
								onCheckedChange={setPinUserMessage}
							/>
						}
						description="Keep your latest prompt pinned at the top while you scroll through a long reply, like Cursor. Updates automatically when you send a new message."
						title="Pin user message while scrolling"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={openChatAtBottom}
								id="open-chat-at-bottom-toggle"
								onCheckedChange={setOpenChatAtBottom}
							/>
						}
						description="Jump to the newest message when you open a chat. When off, the transcript stays wherever it loaded, near the start of the conversation."
						title="Open chats at the latest message"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={inferenceStats}
								id="inference-stats-toggle"
								onCheckedChange={setInferenceStats}
							/>
						}
						description="Show the Stats plugin under the latest reply with session turns, steps, tokens, cache efficiency, speed, context, compactions, cost, and provider usage when reported."
						title="Session stats"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const usagePage = (
		<>
			<SettingsSection
				caption="Subscription usage meters for agents like Claude Code and Codex, shown beside the composer and, optionally, next to each agent in the sidebar."
				title="Usage meter"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={usageBarPrefs.visible}
								id="usage-meter-visible-toggle"
								onCheckedChange={(v) => setUsageBarPrefs({ visible: v })}
							/>
						}
						description="Show the usage meters beside the message input. Turn off to hide them entirely."
						title="Show usage meter"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={usageBarPrefs.sidebar}
								id="usage-meter-sidebar-toggle"
								onCheckedChange={(v) => setUsageBarPrefs({ sidebar: v })}
							/>
						}
						description="Also show the usage meters next to each supported agent's name in the sidebar. Only agents with a readable subscription window (Claude Code, Codex) ever show one."
						title="Show in sidebar"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={usageBarPrefs.showBar}
								disabled={!usageBarPrefs.visible}
								id="usage-meter-bar-toggle"
								onCheckedChange={(v) => setUsageBarPrefs({ showBar: v })}
							/>
						}
						description="Show the little progress bar. Turn off to keep only the label (and percentage, if enabled)."
						title="Show progress bar"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={usageBarPrefs.barStyle === "ring"}
								disabled={!(usageBarPrefs.visible && usageBarPrefs.showBar)}
								id="usage-meter-ring-toggle"
								onCheckedChange={(v) =>
									setUsageBarPrefs({ barStyle: v ? "ring" : "bar" })
								}
							/>
						}
						description="Render the progress indicator as a circular ring instead of a horizontal bar."
						title="Circular progress ring"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={usageBarPrefs.showPercent}
								disabled={!usageBarPrefs.visible}
								id="usage-meter-percent-toggle"
								onCheckedChange={(v) => setUsageBarPrefs({ showPercent: v })}
							/>
						}
						description="Show the percentage as a number next to each meter, not only in the tooltip."
						title="Show percentage"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={usageBarPrefs.mode === "remaining"}
								disabled={!usageBarPrefs.visible}
								id="usage-meter-mode-toggle"
								onCheckedChange={(v) =>
									setUsageBarPrefs({ mode: v ? "remaining" : "used" })
								}
							/>
						}
						description="Show how much of your allowance is left instead of how much you've used."
						title="Show remaining instead of used"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const diffPage = (
		<>
			<SettingsSection
				caption="How code diffs render in the workspace Changes tab. The Split/Stacked control also lives in that tab's toolbar."
				title="Diff viewer"
			>
				<SettingsCard className="overflow-hidden p-0">
					<div className="border-border/60 border-b px-3 py-1.5 text-muted-foreground text-xs">
						Live preview
					</div>
					<div className="max-h-64 overflow-auto text-xs">
						<PatchDiff
							disableWorkerPool
							options={diffViewPrefsToOptions(diffPrefs)}
							patch={DIFF_PREVIEW_PATCH}
						/>
					</div>
				</SettingsCard>

				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={DIFF_STYLE_OPTIONS}
								onValueChange={(v) =>
									setDiffViewPrefs({
										diffStyle: v as DiffViewPrefs["diffStyle"],
									})
								}
								value={diffPrefs.diffStyle}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DIFF_STYLE_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Split shows old and new side by side; Stacked shows changes inline in one column."
						title="Layout"
					/>
					<SettingsItem
						actions={
							<Select
								items={DIFF_THEME_OPTIONS}
								onValueChange={(v) =>
									setDiffViewPrefs({
										themeMode: v as DiffViewPrefs["themeMode"],
									})
								}
								value={diffPrefs.themeMode}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DIFF_THEME_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Which of the two themes below applies. Auto follows the app's light/dark mode."
						title="Theme mode"
					/>
					<SettingsItem
						actions={
							<Select
								items={PIERRE_LIGHT_THEMES}
								onValueChange={(v) => {
									if (v != null) {
										setDiffViewPrefs({ lightTheme: v });
									}
								}}
								value={diffPrefs.lightTheme}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PIERRE_LIGHT_THEMES.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Syntax-highlight theme used while diffs render in light mode."
						settingsId="appearance.diff-viewer.light-theme"
						title="Light theme"
					/>
					<SettingsItem
						actions={
							<Select
								items={PIERRE_DARK_THEMES}
								onValueChange={(v) => {
									if (v != null) {
										setDiffViewPrefs({ darkTheme: v });
									}
								}}
								value={diffPrefs.darkTheme}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PIERRE_DARK_THEMES.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Syntax-highlight theme used while diffs render in dark mode."
						settingsId="appearance.diff-viewer.dark-theme"
						title="Dark theme"
					/>
					<SettingsItem
						actions={
							<Select
								items={DIFF_INDICATOR_OPTIONS}
								onValueChange={(v) =>
									setDiffViewPrefs({
										diffIndicators: v as DiffViewPrefs["diffIndicators"],
									})
								}
								value={diffPrefs.diffIndicators}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DIFF_INDICATOR_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="How added and removed lines are marked in the gutter."
						title="Change markers"
					/>
					<SettingsItem
						actions={
							<Select
								items={DIFF_LINE_DIFF_OPTIONS}
								onValueChange={(v) =>
									setDiffViewPrefs({
										lineDiffType: v as DiffViewPrefs["lineDiffType"],
									})
								}
								value={diffPrefs.lineDiffType}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DIFF_LINE_DIFF_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Highlight the exact characters or words that changed within a line."
						title="Inline highlighting"
					/>
					<SettingsItem
						actions={
							<Select
								items={DIFF_HUNK_SEPARATOR_OPTIONS}
								onValueChange={(v) =>
									setDiffViewPrefs({
										hunkSeparators: v as DiffViewPrefs["hunkSeparators"],
									})
								}
								value={diffPrefs.hunkSeparators}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DIFF_HUNK_SEPARATOR_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Style of the separators shown between collapsed sections of unchanged code."
						title="Hunk separators"
					/>
				</SettingsGroup>

				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={diffPrefs.showBackground}
								id="diff-show-background-toggle"
								onCheckedChange={(v) => setDiffViewPrefs({ showBackground: v })}
							/>
						}
						description="Fill changed lines with a red/green background instead of leaving them plain."
						title="Line backgrounds"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={diffPrefs.showLineNumbers}
								id="diff-show-line-numbers-toggle"
								onCheckedChange={(v) =>
									setDiffViewPrefs({ showLineNumbers: v })
								}
							/>
						}
						description="Show the line-number gutter alongside the diff."
						title="Line numbers"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={diffPrefs.wrapLines}
								id="diff-wrap-lines-toggle"
								onCheckedChange={(v) => setDiffViewPrefs({ wrapLines: v })}
							/>
						}
						description="Wrap long lines instead of scrolling horizontally."
						title="Wrap long lines"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={diffPrefs.expandUnchanged}
								id="diff-expand-unchanged-toggle"
								onCheckedChange={(v) =>
									setDiffViewPrefs({ expandUnchanged: v })
								}
							/>
						}
						description="Show unchanged context lines expanded by default instead of collapsing them."
						title="Expand unchanged context"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const filesPage = (
		<>
			<SettingsSection
				caption="How the workspace Files tab renders your project tree. Density and search also live in that tab's toolbar."
				title="File tree"
			>
				<SettingsCard className="overflow-hidden p-0">
					<div className="border-border/60 border-b px-3 py-1.5 text-muted-foreground text-xs">
						Live preview
					</div>
					<div className="h-52 overflow-hidden text-xs">
						{/* Keyed on the constructor-time options only — theme rides in as
						    host CSS variables and must not force a remount. */}
						<FileTreePreview
							key={JSON.stringify(fileTreePrefsToOptions(fileTreePrefs))}
							prefs={fileTreePrefs}
							style={fileTreeThemeStyles}
						/>
					</div>
				</SettingsCard>

				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={FILE_TREE_DENSITY_OPTIONS}
								onValueChange={(v) =>
									setFileTreePrefs({
										density: v as FileTreePrefs["density"],
									})
								}
								value={fileTreePrefs.density}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FILE_TREE_DENSITY_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Row height and spacing of tree items."
						title="Density"
					/>
					<SettingsItem
						actions={
							<Select
								items={TREE_LIGHT_THEMES}
								onValueChange={(v) => {
									if (v != null) {
										setFileTreePrefs({ lightTheme: v });
									}
								}}
								value={fileTreePrefs.lightTheme}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TREE_LIGHT_THEMES.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Colors used while the app is in light mode. Match app theme keeps the tree on the app's own surface colors."
						settingsId="appearance.file-tree.light-theme"
						title="Light theme"
					/>
					<SettingsItem
						actions={
							<Select
								items={TREE_DARK_THEMES}
								onValueChange={(v) => {
									if (v != null) {
										setFileTreePrefs({ darkTheme: v });
									}
								}}
								value={fileTreePrefs.darkTheme}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TREE_DARK_THEMES.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Colors used while the app is in dark mode. The same theme list as the diff viewer, set independently."
						settingsId="appearance.file-tree.dark-theme"
						title="Dark theme"
					/>
					<SettingsItem
						actions={
							<Select
								items={FILE_TREE_ICON_OPTIONS}
								onValueChange={(v) =>
									setFileTreePrefs({
										iconSet: v as FileTreePrefs["iconSet"],
									})
								}
								value={fileTreePrefs.iconSet}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FILE_TREE_ICON_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Which built-in file-type icon set to use, or none."
						title="Icons"
					/>
					<SettingsItem
						actions={
							<Select
								items={FILE_TREE_SEARCH_MODE_OPTIONS}
								onValueChange={(v) =>
									setFileTreePrefs({
										searchMode: v as FileTreePrefs["searchMode"],
									})
								}
								value={fileTreePrefs.searchMode}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FILE_TREE_SEARCH_MODE_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="How a search query reshapes the tree (expand, collapse, or hide non-matches)."
						title="Search mode"
					/>
					<SettingsItem
						actions={
							<Select
								items={FILE_TREE_EXPANSION_OPTIONS}
								onValueChange={(v) =>
									setFileTreePrefs({
										initialExpansion: v as FileTreePrefs["initialExpansion"],
									})
								}
								value={fileTreePrefs.initialExpansion}
							>
								<SelectTrigger className="h-8 w-56 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{FILE_TREE_EXPANSION_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Whether folders start expanded or collapsed."
						title="Initial state"
					/>
				</SettingsGroup>

				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={fileTreePrefs.coloredIcons}
								id="file-tree-colored-icons-toggle"
								onCheckedChange={(v) => setFileTreePrefs({ coloredIcons: v })}
							/>
						}
						description="Tint file icons by type instead of a single muted color."
						title="Colored icons"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={fileTreePrefs.stickyFolders}
								id="file-tree-sticky-folders-toggle"
								onCheckedChange={(v) => setFileTreePrefs({ stickyFolders: v })}
							/>
						}
						description="Pin a parent folder to the top while scrolling through its children."
						title="Sticky folders"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={fileTreePrefs.showSearch}
								id="file-tree-show-search-toggle"
								onCheckedChange={(v) => setFileTreePrefs({ showSearch: v })}
							/>
						}
						description="Show the filter box above the tree."
						title="Search box"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={fileTreePrefs.flattenEmptyDirectories}
								id="file-tree-flatten-toggle"
								onCheckedChange={(v) =>
									setFileTreePrefs({ flattenEmptyDirectories: v })
								}
							/>
						}
						description="Collapse a chain of single-child folders into one row (e.g. src/main/java)."
						title="Flatten empty directories"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={fileTreePrefs.dragAndDrop}
								id="file-tree-dnd-toggle"
								onCheckedChange={(v) => setFileTreePrefs({ dragAndDrop: v })}
							/>
						}
						description="Allow dragging items to move or reorder them."
						title="Drag and drop"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={fileTreePrefs.renaming}
								id="file-tree-renaming-toggle"
								onCheckedChange={(v) => setFileTreePrefs({ renaming: v })}
							/>
						}
						description="Allow inline rename (F2 or double-click)."
						title="Inline rename"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const resetPage = (
		<>
			<SettingsSection title="Reset">
				<SettingsGroup>
					<SettingsItem
						actions={
							appearanceResetConfirm ? (
								<div className="flex flex-shrink-0 items-center gap-2">
									<Button
										onClick={resetAppearanceDefaults}
										size="sm"
										variant="destructive"
									>
										Confirm reset
									</Button>
									<Button
										onClick={() => setAppearanceResetConfirm(false)}
										size="sm"
										variant="ghost"
									>
										Cancel
									</Button>
								</div>
							) : (
								<Button
									className="flex-shrink-0"
									onClick={() => setAppearanceResetConfirm(true)}
									size="sm"
									variant="ghost"
								>
									Reset to defaults
								</Button>
							)
						}
						description="Restore every appearance setting to its default. Saved custom theme presets are kept."
						title="Reset appearance"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	return (
		<SettingsSubpages
			backLabel="Appearance"
			intro={themeIntro}
			label="Customize"
			pages={[
				{
					id: "language",
					title: "Language & vibe",
					hint: "Choose an official locale or a community-created voice pack.",
					icon: TextFontIcon,
					tint: "purple",
					content: <LanguageSettings />,
				},
				{
					id: "layout",
					title: "Layout & text",
					hint: "Density, widths, and the fonts the interface is set in.",
					icon: TextFontIcon,
					tint: "indigo",
					content: layoutPage,
				},
				{
					id: "motion",
					title: "Motion & effects",
					hint: "How much the interface animates, and the seasonal extras.",
					icon: SparklesIcon,
					tint: "pink",
					content: motionPage,
				},
				{
					id: "interface",
					title: "Interface",
					hint: "The sidebar, the cursor, shadows, and how lists are grouped.",
					icon: DashboardSquare01Icon,
					tint: "blue",
					content: interfacePage,
				},
				{
					id: "chat",
					title: "Chat",
					hint: "How much detail a conversation shows while it runs.",
					icon: Chat01Icon,
					tint: "teal",
					content: chatPage,
				},
				{
					id: "usage",
					title: "Usage meter",
					hint: "Whether the spend meter is shown, and in what shape.",
					icon: ChartLineData01Icon,
					tint: "green",
					content: usagePage,
				},
				{
					id: "diff",
					title: "Diff viewer",
					hint: "How code changes are drawn: layout, themes, and markers.",
					icon: GitCompareIcon,
					tint: "orange",
					content: diffPage,
				},
				{
					id: "files",
					title: "File tree",
					hint: "Density, icons, and behaviour of the file browser.",
					icon: Folder01Icon,
					tint: "yellow",
					content: filesPage,
				},
				{
					id: "reset",
					title: "Reset",
					hint: "Put every appearance setting back to its default.",
					icon: Delete02Icon,
					tint: "red",
					content: resetPage,
				},
			]}
			revealPageId={pendingSubpage}
		/>
	);
}
