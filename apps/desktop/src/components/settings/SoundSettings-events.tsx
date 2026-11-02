import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { previewSound } from "@/src/lib/sounds/play-sound.ts";
import {
	SOUND_SETTING_ROWS,
	type SoundGroup,
	type SoundSettingRow,
	type SoundSettingRowId,
} from "@/src/lib/sounds/sound-catalog.ts";
import {
	isSoundRowEnabled,
	type SoundPrefs,
	setSoundRowEnabled,
} from "@/src/lib/sounds/sound-preferences.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * Row titles as literals: the settings search index (and its test) anchors on
 * the visible title text, and the literal catalog localizes by English text.
 * `SoundSettings.test.tsx` keeps these equal to the catalog labels.
 */
export const SOUND_ROW_TITLES = {
	message: "Message received",
	"message-sent": "Message sent",
	alerts: "Alerts",
	"credit-alert": "Credit alert",
	"meeting-detected": "Meeting detected",
	"run-complete": "Run complete",
	"run-failed": "Run failed",
	"approval-needed": "Approval needed",
	calling: "Calling",
	"join-leave": "Join and leave",
	"mute-unmute": "Mute and unmute",
	"quest-suggest": "Quest suggestions",
	"quest-complete": "Quest completed",
	achievement: "Achievement unlocked",
} as const satisfies Record<SoundSettingRowId, string>;

/** Section headers, in display order. */
export const SOUND_GROUP_ORDER: readonly SoundGroup[] = [
	"Activity",
	"Agents",
	"Calls",
	"Rewards",
];

function SoundEventRow({
	disabled,
	enabled,
	row,
}: {
	disabled: boolean;
	enabled: boolean;
	row: SoundSettingRow;
}) {
	const tl = useLiteralMessages();
	const title = SOUND_ROW_TITLES[row.id];
	return (
		<SettingsItem
			actions={
				<div className="flex items-center gap-2">
					<Button
						aria-label={tl("Preview {sound}", { sound: tl(title) })}
						disabled={disabled}
						onClick={() => previewSound(row.ids[0])}
						size="sm"
						variant="ghost"
					>
						Preview
					</Button>
					<Switch
						aria-label={title}
						checked={enabled}
						disabled={disabled}
						onCheckedChange={(next) => setSoundRowEnabled(row.id, next)}
					/>
				</div>
			}
			description={row.description}
			settingsId={`sounds.events.${row.id}`}
			title={title}
		/>
	);
}

/**
 * One switch per event, grouped like the catalog. Preview plays a row's sound
 * even while that row is off; with the master switch off every control here is
 * disabled, because nothing (previews included) can play then.
 */
export function SoundSettingsEvents({
	disabled,
	prefs,
}: {
	disabled: boolean;
	prefs: SoundPrefs;
}) {
	return (
		<>
			{SOUND_GROUP_ORDER.map((group) => (
				<SettingsSection key={group} title={group}>
					<SettingsGroup>
						{SOUND_SETTING_ROWS.filter((row) => row.group === group).map(
							(row) => (
								<SoundEventRow
									disabled={disabled}
									enabled={isSoundRowEnabled(prefs, row.id)}
									key={row.id}
									row={row}
								/>
							)
						)}
					</SettingsGroup>
				</SettingsSection>
			))}
		</>
	);
}
