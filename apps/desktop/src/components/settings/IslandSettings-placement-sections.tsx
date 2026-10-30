import { useLiteralMessages } from "@ryu/i18n/react";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	DEFAULT_ISLAND_EDGE_OFFSET,
	MAX_ISLAND_EDGE_OFFSET,
	MIN_ISLAND_EDGE_OFFSET,
} from "@/src/lib/api/preferences.ts";
import { IS_WINDOWS } from "./IslandSettings-constants.ts";
import type { IslandPlacementPrefsState } from "./IslandSettings-placement-prefs.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** Appearance, edge offset, position, and privacy & visibility sections. */
export function IslandPlacementSections({
	autoJump,
	handleAutoJump,
	handleHideOnFullscreen,
	handleIslandBg,
	handleIslandEdgeOffset,
	handleNotchMode,
	handleScreenPrivacy,
	hideOnFullscreen,
	islandBg,
	islandEdgeOffset,
	notchMode,
	screenPrivacy,
}: IslandPlacementPrefsState) {
	const tl = useLiteralMessages();
	return (
		<>
			<SettingsSection caption="Native glass is the default: it uses Liquid Glass on newer macOS, vibrancy on older macOS, and Acrylic on Windows while the split gap stays clear. Translucent keeps a CSS-only floating surface whose blur reaches the Island's own contents. Mica uses a native material on Windows 11 and falls back to Acrylic elsewhere.">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Notch mode"
								checked={notchMode}
								onCheckedChange={handleNotchMode}
							/>
						}
						description="Attach Island to the camera notch on supported Macs. Uses a black surface and keeps controls below the camera. Falls back to floating mode when no notched display is available."
						title="Notch mode"
					/>

					<SettingsItem
						actions={
							<Select
								items={[
									{
										value: "translucent",
										label: "Translucent (tinted glass)",
									},
									{ value: "acrylic", label: "Native glass (default)" },
									{ value: "mica", label: "Mica (Windows 11 native blur)" },
								]}
								onValueChange={handleIslandBg}
								value={islandBg}
							>
								<SelectTrigger aria-label="Background" className="h-8 w-56">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="translucent">
										Translucent (tinted glass)
									</SelectItem>
									<SelectItem value="acrylic">
										Native glass (default)
									</SelectItem>
									<SelectItem value="mica">
										Mica (Windows 11 native blur)
									</SelectItem>
								</SelectContent>
							</Select>
						}
						title="Background"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption={tl(
					"One value, applied to each edge: a corner is inset on both axes at once. {defaultOffset}px is the default.",
					{ defaultOffset: DEFAULT_ISLAND_EDGE_OFFSET }
				)}
			>
				<SettingsCard>
					<FluidSlider
						format={(v) => `${v}px`}
						label="Offset from edge"
						max={MAX_ISLAND_EDGE_OFFSET}
						min={MIN_ISLAND_EDGE_OFFSET}
						onValueChange={handleIslandEdgeOffset}
						step={1}
						value={islandEdgeOffset}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="When on, the island follows you to whichever desktop/monitor you are active on (the one under your cursor), re-docking to the same corner or edge. Has no effect on a single-monitor setup."
				title="Position"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Auto-jump to active monitor"
								checked={autoJump}
								onCheckedChange={handleAutoJump}
							/>
						}
						title="Auto-jump to active monitor"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Hide on fullscreen keeps the island out of immersive content (videos, games, presentations) and is Windows-only for now. Hide from screen capture excludes the island from screenshots, screen recordings, and screen-sharing. You still see it, but a shared or recorded screen does not."
				title="Privacy & visibility"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Hide on fullscreen apps"
								checked={IS_WINDOWS && hideOnFullscreen}
								disabled={!IS_WINDOWS}
								onCheckedChange={handleHideOnFullscreen}
							/>
						}
						description={
							IS_WINDOWS
								? "Hide the island while another app is fullscreen, and bring it back when you exit."
								: "Hide the island while another app is fullscreen, and bring it back when you exit. Available on Windows only for now."
						}
						title="Hide on fullscreen apps"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Hide from screen capture"
								checked={screenPrivacy}
								onCheckedChange={handleScreenPrivacy}
							/>
						}
						description="Exclude the island from screenshots, screen recordings, and screen-sharing in meetings."
						title="Hide from screen capture"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}
