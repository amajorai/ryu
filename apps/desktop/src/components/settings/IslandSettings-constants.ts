import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { VoiceInputMode } from "@/src/lib/api/preferences.ts";

/** Option value standing in for "Core's default local model" (no agent). */
export const LOCAL_MODEL_OPTION = "__local__";

/** Activation-mode choices for the push-to-talk shortcut. */
export const VOICE_MODE_OPTIONS: { value: VoiceInputMode; label: string }[] = [
	{ value: "toggle", label: "Press to start / stop" },
	{ value: "push-to-talk", label: "Hold to talk" },
];

/** Debounce for the offset slider's Core write (the slider fires continuously). */
export const EDGE_OFFSET_WRITE_DEBOUNCE_MS = 200;

/**
 * Fullscreen hiding relies on a Windows-only detection signal, so the toggle is
 * disabled elsewhere rather than shown as a silent no-op.
 */
export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** Resolves the scoped computer (or active node) a preference write targets. */
export type IslandTargetGetter = () => ApiTarget;

/** Persists one optimistic preference change, rolling back on failure. */
export type PersistIslandPreferenceChange = (
	key: string,
	write: Promise<boolean>,
	onFailure: () => void,
	onSuccess?: () => void
) => void;
