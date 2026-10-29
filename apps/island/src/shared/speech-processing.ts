import { z } from "zod";
// Shared preference contract for the node-local Speech Processing layer.
//
// The desktop writes this JSON blob to Core and the Island reads it when a
// dictation recording finishes. Voice Recognition remains a separate engine:
// this layer only cleans the raw transcript after ASR.

/** Preference key shared with the desktop and Core KV store. */
export const SPEECH_PROCESSING_PREF_KEY = "speech-processing";

/** Speech Processing engines currently supported by Core. */
export type SpeechProcessingEngine = "s1-mini";

/** S1-mini's required styling control-line values. */
export type SpeechProcessingStyling =
	| "casual"
	| "semi-casual"
	| "semi-formal"
	| "formal";

/** S1-mini's required structure control-line values. */
export type SpeechProcessingStructure = "prose" | "lists";

/** S1-mini's required destination-context control-line values. */
export type SpeechProcessingContext = "general" | "email";

/** The JSON shape stored under {@link SPEECH_PROCESSING_PREF_KEY}. */
export interface SpeechProcessingPrefs {
	context: SpeechProcessingContext;
	engine: SpeechProcessingEngine;
	structure: SpeechProcessingStructure;
	styling: SpeechProcessingStyling;
}

/** Total engine list used by coercion and future layer additions. */
export const SPEECH_PROCESSING_ENGINE_VALUES: readonly SpeechProcessingEngine[] =
	["s1-mini"];

/** Default node-local cleanup configuration. */
export const DEFAULT_SPEECH_PROCESSING_PREFS: SpeechProcessingPrefs = {
	context: "general",
	engine: "s1-mini",
	structure: "prose",
	styling: "semi-formal",
};

const speechProcessingPrefsSchema = z
	.object({
		context: z.enum(["general", "email"]).catch("general"),
		engine: z.enum(["s1-mini"]).catch("s1-mini"),
		structure: z.enum(["prose", "lists"]).catch("prose"),
		styling: z
			.enum(["casual", "semi-casual", "semi-formal", "formal"])
			.catch("semi-formal"),
	})
	.catch(DEFAULT_SPEECH_PROCESSING_PREFS);

/** Parse a stored Speech Processing preference without trusting its JSON. */
export function parseSpeechProcessingPrefs(
	raw: string | null
): SpeechProcessingPrefs {
	if (!raw) {
		return DEFAULT_SPEECH_PROCESSING_PREFS;
	}
	try {
		return speechProcessingPrefsSchema.parse(JSON.parse(raw));
	} catch {
		return DEFAULT_SPEECH_PROCESSING_PREFS;
	}
}
