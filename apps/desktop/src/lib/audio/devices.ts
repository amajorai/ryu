// Device preferences and microphone requests share the chat block's owner.
export {
	type AudioDevice,
	type AudioDeviceLists,
	applyDefaultSpeaker,
	DEFAULT_MIC_KEY,
	DEFAULT_SPEAKER_KEY,
	ensureMicPermission,
	getDefaultMicId,
	getDefaultSpeakerId,
	listAudioDevices,
	setDefaultMicId,
	setDefaultSpeakerId,
	supportsSinkId,
} from "@ryu/blocks/desktop/agent-elements/voice-devices.ts";
