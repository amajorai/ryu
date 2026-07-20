// apps/desktop/src/lib/audio/devices.ts
//
// Audio input/output device preferences for the desktop. The default microphone
// drives voice input (hooks/useVoiceRecorder.ts) and the default speaker is
// applied to playback elements via `setSinkId` where the webview supports it.
//
// Choices are stored locally (per-device, not per-account) — which physical mic
// or speaker to use is a property of *this machine*, so localStorage is the right
// home rather than Core/server state.

export const DEFAULT_MIC_KEY = "ryu_default_microphone";
export const DEFAULT_SPEAKER_KEY = "ryu_default_speaker";

/** A selectable audio device (input or output). */
export interface AudioDevice {
	deviceId: string;
	label: string;
}

export interface AudioDeviceLists {
	inputs: AudioDevice[];
	outputs: AudioDevice[];
}

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value) {
			localStorage.setItem(key, value);
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// Storage unavailable — selection simply won't persist.
	}
}

/** The saved default microphone deviceId, or null for the system default. */
export function getDefaultMicId(): string | null {
	return read(DEFAULT_MIC_KEY);
}

export function setDefaultMicId(deviceId: string | null): void {
	write(DEFAULT_MIC_KEY, deviceId);
}

/** The saved default speaker deviceId, or null for the system default. */
export function getDefaultSpeakerId(): string | null {
	return read(DEFAULT_SPEAKER_KEY);
}

export function setDefaultSpeakerId(deviceId: string | null): void {
	write(DEFAULT_SPEAKER_KEY, deviceId);
}

/**
 * Prompt for microphone permission once. Device *labels* are only exposed by
 * `enumerateDevices` after a getUserMedia grant, so the settings picker calls
 * this before listing. Tracks are stopped immediately — we only want the grant.
 */
export async function ensureMicPermission(): Promise<boolean> {
	if (!navigator.mediaDevices?.getUserMedia) {
		return false;
	}
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		for (const track of stream.getTracks()) {
			track.stop();
		}
		return true;
	} catch {
		return false;
	}
}

/** Enumerate audio input and output devices (labels require a prior grant). */
export async function listAudioDevices(): Promise<AudioDeviceLists> {
	if (!navigator.mediaDevices?.enumerateDevices) {
		return { inputs: [], outputs: [] };
	}
	const devices = await navigator.mediaDevices.enumerateDevices();
	const inputs: AudioDevice[] = [];
	const outputs: AudioDevice[] = [];
	for (const d of devices) {
		if (d.kind === "audioinput") {
			inputs.push({ deviceId: d.deviceId, label: d.label || "Microphone" });
		} else if (d.kind === "audiooutput") {
			outputs.push({ deviceId: d.deviceId, label: d.label || "Speaker" });
		}
	}
	return { inputs, outputs };
}

/** Whether the running webview supports routing audio output via `setSinkId`. */
export function supportsSinkId(): boolean {
	return (
		typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId ===
		"function"
	);
}

/**
 * Route a media element to the saved default speaker. No-op (returns false) when
 * the webview lacks `setSinkId` (common in WebView2/WKWebView) or no speaker is
 * selected — callers should treat output routing as best-effort.
 */
export async function applyDefaultSpeaker(
	element: HTMLMediaElement
): Promise<boolean> {
	const sinkId = getDefaultSpeakerId();
	if (!(sinkId && supportsSinkId())) {
		return false;
	}
	try {
		await (
			element as HTMLMediaElement & {
				setSinkId: (id: string) => Promise<void>;
			}
		).setSinkId(sinkId);
		return true;
	} catch {
		return false;
	}
}
