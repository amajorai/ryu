// Desktop chat read-back: automatically speak assistant replies when a text turn
// finishes. Separate from island-tts (island companion) and from the realtime
// voice-mode WebSocket session (which always speaks via Core while active).

import { Switch } from "@ryu/ui/components/switch.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_VOICE_MODE_READBACK_PREFS,
	getVoiceModeReadbackPrefs,
	setVoiceModeReadbackPrefs,
} from "@/src/lib/api/preferences.ts";
import {
	useVoicePreferenceScope,
	useVoicePreference,
	VoicePreferenceStatus,
	type VoicePreferenceAuthority,
} from "./voice-preference-state.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";

export function VoiceReadbackSettings() {
	const scope = useVoicePreferenceScope();
	return (
		<VoiceReadbackSettingsForTarget
			key={scope.id}
			target={scope.target}
			resource={scope.resource}
		/>
	);
}

function VoiceReadbackSettingsForTarget({
	target,
	resource,
}: {
	target: ApiTarget;
	resource: VoicePreferenceAuthority;
}) {
	const { prefs, persist, disabled, error, retry, pending } =
		useVoicePreference(
			target,
			DEFAULT_VOICE_MODE_READBACK_PREFS,
			getVoiceModeReadbackPrefs,
			setVoiceModeReadbackPrefs,
			resource
		);

	return (
		<SettingsSection
			caption="Applies to desktop chat. Read-back is automatically disabled while a meeting is recording, even when this toggle is on. Engine and voice come from the Audio section below."
			title="Read back responses"
		>
			<VoicePreferenceStatus error={error} retry={retry} pending={pending} />
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							disabled={disabled}
							checked={prefs.enabled}
							onCheckedChange={(enabled) => persist({ ...prefs, enabled })}
						/>
					}
					description="Speak assistant replies aloud when a chat turn finishes."
					title="Always read back responses"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
