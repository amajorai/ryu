import previewStyles from "../settings/settings-preview.module.css";
import type { PreviewStyle } from "../settings/settings-preview-style.ts";
// The onboarding look-and-feel step. It is deliberately the same three knobs the
// Settings → Appearance panel leads with (mode, a preset per mode, roundness)
// driven through the *same* setters, so whatever the user picks here is already
// persisted and published to Core by the time onboarding finishes — there is no
// separate onboarding theme state to reconcile later.
//
// The panel's own `ThemePanel` / `PresetSwatch` / `PresetSelectItem` are module
// private to AppearanceTab.tsx, so the ~20 lines of swatch presentation are
// mirrored here rather than imported. The per-token colour grid and save-as-preset
// flow are intentionally left in Settings: they only make sense alongside the
// dirty/save/discard state machine, and half of it would strand a first-run user
// on an unsaved theme.

import { Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useTheme } from "next-themes";
import { type ReactNode, useMemo, useState } from "react";
import {
	DEFAULT_RADIUS,
	setDarkPreset,
	setLightPreset,
	setRadius,
} from "@/src/hooks/useThemePreset.ts";
import {
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	getAllVariants,
	STORAGE_KEYS,
	type ThemeVariant,
} from "@/src/lib/themes/presets.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

// Same three cards (and artwork) the Appearance panel uses, so the control the
// user meets on day one is the one they'll recognise in Settings later.
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

const RADIUS_MIN = 0;
const RADIUS_MAX = 1.5;
const RADIUS_STEP = 0.025;

function readStoredRadius(): number {
	// 0 is a legitimate setting (square window corners), so the guard is only
	// against a missing or garbage entry — never against the slider's minimum.
	// Read the raw string first: `Number(null)` is 0, which would silently turn an
	// unset preference into square corners.
	const raw = localStorage.getItem(STORAGE_KEYS.radius);
	if (!raw) {
		return DEFAULT_RADIUS;
	}
	const stored = Number(raw);
	return Number.isFinite(stored) && stored >= 0 ? stored : DEFAULT_RADIUS;
}

/** Three-band preview of a preset: page, surface, accent. */
function PresetSwatch({ variant }: { variant: ThemeVariant }) {
	const backgroundStyle: PreviewStyle = {
		"--settings-preview-background": variant.preview.bg,
	};
	const surfaceStyle: PreviewStyle = {
		"--settings-preview-background": variant.preview.surface,
	};
	const primaryStyle: PreviewStyle = {
		"--settings-preview-background": variant.preview.primary,
	};
	return (
		<span className="inline-flex h-5 w-8 shrink-0 flex-col overflow-hidden rounded-sm border border-border">
			<span
				className={`block flex-1 ${previewStyles.paint}`}
				style={backgroundStyle}
			/>
			<span
				className={`block h-1 ${previewStyles.paint}`}
				style={surfaceStyle}
			/>
			<span
				className={`block h-1 ${previewStyles.paint}`}
				style={primaryStyle}
			/>
		</span>
	);
}

function PresetLabel({ variant }: { variant: ThemeVariant }) {
	return (
		<span className="flex items-center gap-2">
			<PresetSwatch variant={variant} />
			<span>{variant.label}</span>
		</span>
	);
}

function PresetSelect({
	caption,
	label,
	onChange,
	value,
	variants,
}: {
	caption: string;
	label: string;
	// Base UI can emit `null` (a deselect); the step has no "no theme" state, so
	// that is simply ignored rather than clearing the preset.
	onChange: (id: string | null) => void;
	value: string;
	variants: ThemeVariant[];
}) {
	// Base UI resolves the closed trigger's content from `items`, so the swatch +
	// name on the trigger is literally the same node as the row in the list and
	// the raw preset id is never rendered.
	const items = useMemo(() => {
		const map: Record<string, ReactNode> = {};
		for (const variant of variants) {
			map[variant.id] = <PresetLabel variant={variant} />;
		}
		return map;
	}, [variants]);

	return (
		<div className="flex flex-col gap-1.5">
			<div>
				<p className="font-medium text-sm">{label}</p>
				<p className="text-detail text-muted-foreground">{caption}</p>
			</div>
			<Select items={items} onValueChange={onChange} value={value}>
				<SelectTrigger className="h-9 w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{variants.map((variant) => (
						<SelectItem key={variant.id} value={variant.id}>
							<PresetLabel variant={variant} />
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

interface ColorStepProps {
	/** Onboarding is finishing; the step locks so the user can't double-submit. */
	busy?: boolean;
	onContinue: () => void;
}

export function ColorStep({ busy = false, onContinue }: ColorStepProps) {
	const { theme, setTheme } = useTheme();
	const [lightPreset, setLightPresetId] = useState(
		() => localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID
	);
	const [darkPreset, setDarkPresetId] = useState(
		() => localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID
	);
	const [radius, setRadiusValue] = useState(readStoredRadius);

	// Custom themes can only appear if the user already ran Ryu, so in practice
	// this is the built-in set. Read once: nothing here creates a preset.
	const lightVariants = useMemo(() => getAllVariants("light"), []);
	const darkVariants = useMemo(() => getAllVariants("dark"), []);

	const handleLightPreset = (id: string | null) => {
		if (!id) {
			return;
		}
		setLightPresetId(id);
		setLightPreset(id);
	};

	const handleDarkPreset = (id: string | null) => {
		if (!id) {
			return;
		}
		setDarkPresetId(id);
		setDarkPreset(id);
	};

	const handleRadius = (value: number) => {
		setRadiusValue(value);
		setRadius(value);
	};

	return (
		<ActivationStepShell
			subtitle="Pick a look. You can change any of it later in Settings."
			title="Make it yours"
		>
			<div className="flex flex-col gap-2">
				<p className="font-medium text-sm">Appearance</p>
				<div className="flex gap-4">
					{MODES.map(({ value, label, image }) => (
						<label
							className="flex cursor-pointer flex-col items-center gap-2"
							key={value}
						>
							<input
								checked={theme === value}
								className="sr-only"
								name="onboarding-theme"
								onChange={() => setTheme(value)}
								type="radio"
								value={value}
							/>
							{/* static preview art, sized by the class */}
							<img
								alt={label}
								className={cn(
									"rounded-lg border transition-[border-color,box-shadow] duration-150",
									theme === value
										? "border-transparent ring-2 ring-primary ring-offset-2 ring-offset-background"
										: "border-border hover:border-muted-foreground"
								)}
								height={70}
								src={safeMediaUrl(image) ?? undefined}
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
				</div>
			</div>

			<PresetSelect
				caption="Used whenever light mode is active."
				label="Light theme"
				onChange={handleLightPreset}
				value={lightPreset}
				variants={lightVariants}
			/>

			<PresetSelect
				caption="Used whenever dark mode is active."
				label="Dark theme"
				onChange={handleDarkPreset}
				value={darkPreset}
				variants={darkVariants}
			/>

			<FluidSlider
				format={(v) => `${v.toFixed(3)}rem`}
				label="Roundness"
				max={RADIUS_MAX}
				min={RADIUS_MIN}
				onValueChange={handleRadius}
				step={RADIUS_STEP}
				value={radius}
			/>

			<OnboardingActions>
				<OnboardingCta disabled={busy} onClick={onContinue}>
					{busy ? "Finishing…" : "Continue"}
				</OnboardingCta>
			</OnboardingActions>
		</ActivationStepShell>
	);
}
