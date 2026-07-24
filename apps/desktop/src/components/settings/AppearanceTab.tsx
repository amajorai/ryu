import {
	ArrowDown01Icon,
	Cancel01Icon,
	FloppyDiskIcon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
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
import { ElasticSlider } from "@ryu/ui/components/elastic-slider";
import { Input } from "@ryu/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Switch } from "@ryu/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@ryu/ui/components/toggle-group";
import { cn } from "@ryu/ui/lib/utils";
import { useTheme } from "next-themes";
import { useCallback, useState } from "react";
import { resetBackgroundCustomization } from "@/src/hooks/useBackgroundCustomization.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
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
	resetDiffViewPrefs,
	setDiffViewPrefs,
	useDiffViewPrefs,
} from "@/src/hooks/useDiffViewPrefs.ts";
import {
	type FileTreePrefs,
	fileTreePrefsToOptions,
	resetFileTreePrefs,
	setFileTreePrefs,
	useFileTreePrefs,
} from "@/src/hooks/useFileTreePrefs.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import {
	setPointerCursor,
	usePointerCursor,
} from "@/src/hooks/usePointerCursor.ts";
import { useSidebarMode } from "@/src/hooks/useSidebarMode.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import {
	applyCustomTokensLive,
	CODE_FONTS,
	DEFAULT_CARD_SPACING,
	DEFAULT_CHAT_WIDTH,
	DEFAULT_RADIUS,
	DEFAULT_SIDEBAR_WIDTH,
	DEFAULT_SPACING,
	HEADING_FONTS,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	resetCardSpacing,
	SIDEBAR_WIDTH_KEY,
	setCardSpacing,
	setChatWidth,
	setCodeFont,
	setContrast,
	setDarkPreset,
	setHeadingFont,
	setLightPreset,
	setRadius,
	setSidebarWidthSetting,
	setSpacing,
	setUiFont,
	UI_FONTS,
} from "@/src/hooks/useThemePreset.ts";
import {
	resetUsageBarPrefs,
	setUsageBarPrefs,
	useUsageBarPrefs,
} from "@/src/hooks/useUsageBarPrefs.ts";
import {
	type CustomTokens,
	customTokensToVariant,
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	findVariant,
	getAllVariants,
	STORAGE_KEYS,
	saveCustomTheme,
	type ThemeVariant,
	variantToCustomTokens,
} from "@/src/lib/themes/presets.ts";
import { BackgroundCustomizationSettings } from "./BackgroundCustomizationSettings.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

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
	{ name: "ryu", label: "Ryu Blue", light: "#0088ff", dark: "#0088ff" },
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
	label: string;
	mode: "light" | "dark";
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
	variants: ThemeVariant[];
}

function ThemePanel({
	mode,
	label,
	variants,
	selectedId,
	tokens,
	dirty,
	saveDialogOpen,
	saveName,
	onSelectPreset,
	onTokenChange,
	onSaveClick,
	onDiscardClick,
	onSaveNameChange,
	onSaveConfirm,
	onSaveCancel,
}: ThemePanelProps) {
	const selected = findVariant(selectedId);

	return (
		<div className="space-y-3">
			<div>
				<h3 className="mb-1 font-medium text-sm">{label} theme</h3>
				<p className="mb-2 text-muted-foreground text-xs">
					Used when {mode} mode is active.
				</p>
				<Select onValueChange={onSelectPreset} value={dirty ? "" : selectedId}>
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
							<SelectValue />
						)}
					</SelectTrigger>
					<SelectContent>
						{variants.map((v) => (
							<PresetSelectItem key={v.id} variant={v} />
						))}
					</SelectContent>
				</Select>
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

// The "Tool detail" knob is a Fortnite-style preset over the three tool-display
// toggles (group / expand file edits / expand commands): one simple choice that
// most users never outgrow, with the individual toggles tucked into "Advanced"
// for anyone who wants to fine-grain. The preset is DERIVED from the toggles
// (no separate storage), so editing an individual toggle in Advanced simply
// lands on whichever preset matches — or "custom" when none does. Ordered by
// how much each surfaces: compact (all collapsed) → minimal (diffs open) →
// detailed (everything open, calls listed individually). `pinUserMessage` is
// intentionally NOT part of this — it is scroll behaviour, not tool detail.
const TOOL_DETAIL_PRESETS = {
	compact: { group: true, edits: false, commands: false },
	minimal: { group: true, edits: true, commands: false },
	detailed: { group: false, edits: true, commands: true },
} as const;

type ToolDetailPresetId = keyof typeof TOOL_DETAIL_PRESETS;
type ToolDetailValue = ToolDetailPresetId | "custom";

function deriveToolDetailPreset(
	group: boolean,
	edits: boolean,
	commands: boolean
): ToolDetailValue {
	for (const [id, preset] of Object.entries(TOOL_DETAIL_PRESETS)) {
		if (
			preset.group === group &&
			preset.edits === edits &&
			preset.commands === commands
		) {
			return id as ToolDetailPresetId;
		}
	}
	return "custom";
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
function FileTreePreview({ prefs }: { prefs: FileTreePrefs }) {
	const { model } = useFileTree({
		...fileTreePrefsToOptions(prefs),
		paths: FILE_TREE_PREVIEW_PATHS as unknown as string[],
	});
	return <FileTree className="h-full w-full" model={model} />;
}

export function AppearanceTab() {
	const { theme, setTheme } = useTheme();
	const pointerCursorEnabled = usePointerCursor();
	const chromeShadowsEnabled = useChromeShadows();
	const dialogOverlayBlurEnabled = useDialogOverlayBlur();
	const [friendlyNames, setFriendlyNames] = useFriendlyMode();
	const [groupChatsByDate, setGroupChatsByDate] = useChatDateGrouping();
	const [sidebarMode, setSidebarMode] = useSidebarMode();
	const [sidebarVariant, setSidebarVariant] = useSidebarVariant();
	const [sidebarOverflowPopover, setSidebarOverflowPopover] =
		usePersistedToggle("ryu:sidebar-overflow-popover", false);
	const usageBarPrefs = useUsageBarPrefs();
	const [groupToolUses, setGroupToolUses] = usePersistedToggle(
		"ryu:group-tool-uses",
		true
	);
	const [expandFileEdits, setExpandFileEdits] = usePersistedToggle(
		"ryu:expand-file-edits",
		false
	);
	const [expandCommands, setExpandCommands] = usePersistedToggle(
		"ryu:expand-commands",
		false
	);
	const [pinUserMessage, setPinUserMessage] = usePersistedToggle(
		"ryu:pin-user-message",
		true
	);
	const [animationsEnabled, setAnimationsEnabled] = usePersistedToggle(
		"ryu:animations-enabled",
		true
	);
	const [streamAnimation, setStreamAnimation] = usePersistedToggle(
		"ryu:stream-animation",
		true
	);
	const diffPrefs = useDiffViewPrefs();
	const fileTreePrefs = useFileTreePrefs();

	const toolDetailPreset = deriveToolDetailPreset(
		groupToolUses,
		expandFileEdits,
		expandCommands
	);
	const applyToolDetailPreset = useCallback(
		(id: ToolDetailPresetId) => {
			const preset = TOOL_DETAIL_PRESETS[id];
			setGroupToolUses(preset.group);
			setExpandFileEdits(preset.edits);
			setExpandCommands(preset.commands);
		},
		[setGroupToolUses, setExpandFileEdits, setExpandCommands]
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

	const [lightVariants, setLightVariants] = useState<ThemeVariant[]>(() =>
		getAllVariants("light")
	);
	const [darkVariants, setDarkVariants] = useState<ThemeVariant[]>(() =>
		getAllVariants("dark")
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
		setLightVariants(getAllVariants("light"));
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
		setDarkVariants(getAllVariants("dark"));
		setDarkPresetId(id);
		setDarkBaseTokens(darkTokens);
		setDarkSaveDialog(false);
		setDarkSaveName("");
		setDarkPreset(id);
	}, [darkSaveName, darkTokens]);

	const handleLightDiscard = useCallback(() => {
		setLightTokens(lightBaseTokens);
		applyCustomTokensLive("light", lightBaseTokens);
		setLightSaveDialog(false);
	}, [lightBaseTokens]);

	const handleDarkDiscard = useCallback(() => {
		setDarkTokens(darkBaseTokens);
		applyCustomTokensLive("dark", darkBaseTokens);
		setDarkSaveDialog(false);
	}, [darkBaseTokens]);

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
		// Theme mode + presets
		setTheme("system");
		handleLightPreset(DEFAULT_LIGHT_ID);
		handleDarkPreset(DEFAULT_DARK_ID);

		// Typography
		handleUiFont(UI_FONTS[0].value);
		handleHeadingFont(HEADING_FONTS[0].value);
		handleCodeFont(CODE_FONTS[0].value);

		// Sliders
		setContrastValue(50);
		setContrast(50);
		setRadiusValue(DEFAULT_RADIUS);
		setRadius(DEFAULT_RADIUS);
		setSpacingValue(DEFAULT_SPACING);
		setSpacing(DEFAULT_SPACING);
		setCardSpacingValue(DEFAULT_CARD_SPACING);
		resetCardSpacing();
		setChatWidthValue(DEFAULT_CHAT_WIDTH);
		setChatWidth(DEFAULT_CHAT_WIDTH);
		setSidebarWidthValue(DEFAULT_SIDEBAR_WIDTH);
		setSidebarWidthSetting(DEFAULT_SIDEBAR_WIDTH);

		// Friendly names (on by default)
		setFriendlyNames(true);

		// Pointer cursor
		setPointerCursor(false);

		// Navigation & sidebar shadows (on by default)
		setChromeShadows(true);

		// Dialog overlays (transparent by default)
		setDialogOverlayBlur(false);

		// Custom sidebar/page backgrounds (off by default)
		resetBackgroundCustomization();

		// Composer usage meters (visible, bar-on, percent-off, used mode)
		resetUsageBarPrefs();

		// Diff viewer options
		resetDiffViewPrefs();

		// File tree options
		resetFileTreePrefs();

		setPinUserMessage(true);

		setAppearanceResetConfirm(false);
	};

	return (
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
						label="Light"
						mode="light"
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
						variants={lightVariants}
					/>
					<ThemePanel
						baseTokens={darkBaseTokens}
						dirty={darkDirty}
						label="Dark"
						mode="dark"
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
						variants={darkVariants}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Layout & sizing">
				<SettingsCard className="space-y-3">
					<div className="space-y-1.5">
						<ElasticSlider
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

					<ElasticSlider
						formatValue={(v) => `${v.toFixed(3)}rem`}
						label="Roundness"
						max={1.5}
						min={0}
						onValueChange={handleRadius}
						step={0.025}
						value={radiusValue}
					/>

					<div className="space-y-1.5">
						<ElasticSlider
							formatValue={(v) => `${v.toFixed(3)}rem`}
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
						<ElasticSlider
							formatValue={(v) => `${v.toFixed(2)}rem`}
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

					<ElasticSlider
						formatValue={(v) => `${v}px`}
						label="Chat width"
						max={960}
						min={480}
						onValueChange={handleChatWidth}
						step={10}
						value={chatWidthValue}
					/>

					<ElasticSlider
						formatValue={(v) => `${v}px`}
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
				caption="Customize the fonts used across the interface."
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
						description="Master switch for in-app animations. Turn off for a fully static interface. Your system “reduce motion” setting always overrides this and disables animations regardless."
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
						description="Show plain-language model and skill names everywhere (catalog, downloads, agent pickers) instead of raw developer strings like “gemma-4-E2B-it-GGUF”. Turn off to see the exact technical names."
						title="Friendly names"
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
								checked={groupChatsByDate}
								id="group-chats-by-date-toggle"
								onCheckedChange={setGroupChatsByDate}
							/>
						}
						description="Group the sidebar's Chats into Today, Yesterday, Last week, and older buckets (like ChatGPT), each collapsible and reorderable under the Chats heading. Turn off for one flat list."
						title="Group chats by date"
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
								checked={sidebarOverflowPopover}
								id="sidebar-overflow-popover-toggle"
								onCheckedChange={setSidebarOverflowPopover}
							/>
						}
						description="When a section has more items than fit, open a searchable, infinite-scrolling popover to the right instead of expanding the list inline with Show more / Show less."
						title="Search overflow in a popover"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Chat">
				<SettingsGroup>
					<SettingsItem
						actions={
							<ToggleGroup
								className="rounded-lg bg-muted/60 p-0.5"
								id="tool-detail-preset"
								onValueChange={(v: string) => {
									// Ignore deselect (empty) and the non-applyable "custom"
									// pseudo-value; only real presets drive the toggles.
									if (v in TOOL_DETAIL_PRESETS) {
										applyToolDetailPreset(v as ToolDetailPresetId);
									}
								}}
								spacing={0}
								value={toolDetailPreset}
								variant="default"
							>
								<ToggleGroupItem className="h-7 px-2.5 text-xs" value="compact">
									Compact
								</ToggleGroupItem>
								<ToggleGroupItem className="h-7 px-2.5 text-xs" value="minimal">
									Minimal
								</ToggleGroupItem>
								<ToggleGroupItem
									className="h-7 px-2.5 text-xs"
									value="detailed"
								>
									Detailed
								</ToggleGroupItem>
								{toolDetailPreset === "custom" ? (
									<ToggleGroupItem
										className="h-7 px-2.5 text-xs"
										disabled
										value="custom"
									>
										Custom
									</ToggleGroupItem>
								) : null}
							</ToggleGroup>
						}
						description="How much of each tool call the chat shows. Compact keeps every call collapsed to a row; Minimal opens file diffs but keeps command output capped; Detailed expands diffs and output and lists every call individually. Fine-tune the pieces under Advanced."
						title="Tool detail"
					/>
				</SettingsGroup>

				<Collapsible
					onOpenChange={setToolDetailAdvancedOpen}
					open={toolDetailAdvancedOpen}
				>
					<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-[10px] px-3.5 py-2 text-left text-muted-foreground text-xs hover:bg-muted/40">
						<span>Advanced tool detail</span>
						<HugeiconsIcon
							className={cn(
								"size-4 shrink-0 transition-transform",
								toolDetailAdvancedOpen && "rotate-180"
							)}
							icon={ArrowDown01Icon}
						/>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-1">
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										checked={groupToolUses}
										id="group-tool-uses-toggle"
										onCheckedChange={setGroupToolUses}
									/>
								}
								description="Collapse consecutive tool calls (Tasks, Agents) into a single grouped row with a summary. Turn off to show every tool call individually."
								title="Group tool uses"
							/>
							<SettingsItem
								actions={
									<Switch
										checked={expandFileEdits}
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
										id="expand-commands-toggle"
										onCheckedChange={setExpandCommands}
									/>
								}
								description="Show command output expanded by default. When off, output is capped at a few lines."
								title="Auto-expand commands"
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
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Control the subscription usage meters shown for agents like Claude Code and Codex — beside the composer and, optionally, next to each agent in the sidebar."
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
						description="Syntax-highlight theme for diffs. Auto follows the app's light/dark mode."
						title="Theme"
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

			<SettingsSection
				caption="How the workspace Files tab renders your project tree. Density and search also live in that tab's toolbar."
				title="File tree"
			>
				<SettingsCard className="overflow-hidden p-0">
					<div className="border-border/60 border-b px-3 py-1.5 text-muted-foreground text-xs">
						Live preview
					</div>
					<div className="h-52 overflow-hidden text-xs">
						<FileTreePreview
							key={JSON.stringify(fileTreePrefs)}
							prefs={fileTreePrefs}
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
						description="Restore theme, typography, and layout to their defaults. Saved custom presets are kept."
						title="Reset appearance"
					/>
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
