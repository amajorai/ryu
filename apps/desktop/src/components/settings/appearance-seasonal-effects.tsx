import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect } from "react";
import {
	getCurrentSeason,
	getSeasonDisplayEmoji,
	SEASONS,
} from "@/src/components/layout/SeasonalEffects.tsx";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import {
	previewSeasonalTheme,
	type SeasonalThemeSetting,
	setSeasonalThemeSetting,
	usePreviewSeasonalTheme,
	useSeasonalThemeSetting,
} from "@/src/hooks/useSeasonalEffects.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
} from "@/src/lib/appearance-settings.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export const SEASON_OPTIONS = [
	{ value: "auto", label: "Automatic" },
	...SEASONS.map((s) => ({
		value: s.id,
		label: `${getSeasonDisplayEmoji(s)} ${s.label}`,
	})),
] satisfies { value: SeasonalThemeSetting; label: string }[];

/**
 * The seasonal titlebar effects: the on/off switch, which season to show, and a
 * timed preview so a season can be seen without waiting for its date.
 *
 * Both rows follow the Motion master switch — falling particles are an
 * animation, so "Enable animations" (and the OS reduce-motion preference, which
 * overrides everything) must turn them off too.
 */
export function SeasonalEffectsSettings() {
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
					description="Off by default. Holiday particles in the title bar; needs animations on."
					title="Seasonal effects"
				/>
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							<Select<SeasonalThemeSetting>
								items={SEASON_OPTIONS}
								onValueChange={(v) => {
									if (v === null) {
										return;
									}
									setSeasonalThemeSetting(v);
								}}
								value={seasonSetting}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									disabled={!(animationsEnabled && seasonalEffects)}
									size="sm"
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
					description="Automatic follows the calendar. Preview works even while effects are off."
					title="Season"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
