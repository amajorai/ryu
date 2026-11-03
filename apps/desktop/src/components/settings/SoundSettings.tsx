import { formatPercent } from "@ryu/i18n/format-percent";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef } from "react";
import { previewSound } from "@/src/lib/sounds/play-sound.ts";
import {
	SOUND_PACK_IDS,
	SOUND_PACKS,
	type SoundPackId,
} from "@/src/lib/sounds/sound-packs.ts";
import {
	setSoundPrefs,
	setSoundVolume,
	useSoundPrefs,
	useSoundVolume,
} from "@/src/lib/sounds/sound-preferences.ts";
import { SoundSettingsEvents } from "./SoundSettings-events.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** How long the volume must rest before its sample plays (one per gesture). */
export const VOLUME_PREVIEW_DELAY_MS = 300;

const PACK_ITEMS = SOUND_PACK_IDS.map((id) => ({
	label: SOUND_PACKS[id].label,
	value: id,
}));

/** Whether this host can play Web Audio at all. */
export function soundsSupported(): boolean {
	const scope = globalThis as {
		AudioContext?: unknown;
		webkitAudioContext?: unknown;
	};
	return Boolean(scope.AudioContext ?? scope.webkitAudioContext);
}

/**
 * Plays one volume sample once the slider settles, so a drag or a run of arrow
 * presses previews the level it ended on instead of chirping every step.
 */
function useVolumePreview(): (volume: number) => void {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) {
				clearTimeout(timer.current);
			}
		},
		[]
	);
	return (volume: number) => {
		if (timer.current) {
			clearTimeout(timer.current);
		}
		timer.current = setTimeout(() => {
			timer.current = null;
			if (volume > 0) {
				previewSound("message");
			}
		}, VOLUME_PREVIEW_DELAY_MS);
	};
}

/**
 * The Sounds tab: the master switch, this device's volume, the sound pack and
 * the Do Not Disturb rule, then one switch and Preview per event.
 */
export function SoundSettings() {
	const prefs = useSoundPrefs();
	const volume = useSoundVolume();
	const schedulePreview = useVolumePreview();
	const supported = soundsSupported();
	const locked = !supported;

	return (
		<>
			{!supported && (
				<SettingsSection>
					<SettingsCard>
						<p className="text-muted-foreground text-sm" role="status">
							Sounds aren't available in this browser.
						</p>
					</SettingsCard>
				</SettingsSection>
			)}
			<SettingsSection
				caption="Sound choices sync across your devices. Volume is set per device."
				title="Sounds"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Play sounds"
								checked={prefs.enabled}
								disabled={locked}
								onCheckedChange={(next) => setSoundPrefs({ enabled: next })}
							/>
						}
						description="Short Ryu cues for messages, runs, calls and rewards."
						settingsId="sounds.general.play-sounds"
						title="Play sounds"
					/>
					<SettingsItem
						bare
						description="Set for this device only."
						settingsId="sounds.general.volume"
						title="Volume"
					>
						<FluidSlider
							aria-label="Volume"
							disabled={locked || !prefs.enabled}
							format={(value) => formatPercent(value / 100)}
							label=""
							max={100}
							min={0}
							onValueChange={(value) => {
								const next = value / 100;
								setSoundVolume(next);
								schedulePreview(next);
							}}
							step={1}
							value={Math.round(volume * 100)}
						/>
					</SettingsItem>
					<SettingsItem
						actions={
							<Select<SoundPackId>
								disabled={locked || !prefs.enabled}
								items={PACK_ITEMS}
								onValueChange={(next) => {
									setSoundPrefs({ pack: next });
									previewSound("run-complete");
								}}
								value={prefs.pack}
							>
								<SelectTrigger aria-label="Sound pack" className="h-8 w-40">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									{PACK_ITEMS.map((item) => (
										<SelectItem
											key={item.value}
											textValue={item.label}
											value={item.value}
										>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description={SOUND_PACKS[prefs.pack].description}
						settingsId="sounds.general.sound-pack"
						title="Sound pack"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Quiet while Do Not Disturb"
								checked={prefs.quietInDnd}
								disabled={locked || !prefs.enabled}
								onCheckedChange={(next) => setSoundPrefs({ quietInDnd: next })}
							/>
						}
						description="Notification and reward sounds stay silent. Your own actions and calls still play."
						settingsId="sounds.general.quiet-dnd"
						title="Quiet while Do Not Disturb"
					/>
				</SettingsGroup>
			</SettingsSection>
			<SoundSettingsEvents disabled={locked || !prefs.enabled} prefs={prefs} />
		</>
	);
}
