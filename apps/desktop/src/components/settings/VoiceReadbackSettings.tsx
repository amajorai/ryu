// Desktop chat read-back: automatically speak assistant replies when a text turn
// finishes. Separate from island-tts (island companion) and from the realtime
// voice-mode WebSocket session (which always speaks via Core while active).

import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_VOICE_MODE_READBACK_PREFS,
	getVoiceModeReadbackPrefs,
	setVoiceModeReadbackPrefs,
} from "@/src/lib/api/preferences.ts";
import {
	useVoicePreference,
	useVoicePreferenceScope,
	type VoicePreferenceAuthority,
	VoicePreferenceStatus,
} from "./voice-preference-state.tsx";

export function VoiceReadbackSettings() {
	const scope = useVoicePreferenceScope();
	return (
		<VoiceReadbackSettingsForTarget
			key={scope.id}
			resource={scope.resource}
			target={scope.target}
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
			caption="Desktop chat only. Paused while a meeting records."
			title="Read back responses"
		>
			<VoicePreferenceStatus error={error} pending={pending} retry={retry} />
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={prefs.enabled}
							disabled={disabled}
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
