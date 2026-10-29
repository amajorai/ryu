import { z } from "zod";

// System-wide dictation preference: the cross-process contract persisted in Core
// under the `dictation` key. Owned by the `dictation` apps-store app (plugin enable
// is the single on/off switch); Island is the OS surface that registers shortcuts
// and runs capture → STT → insert. Separate from `voice-input` (`shared/voice.ts`)
// on purpose — voice input drops a transcript into the island chat to run an agent,
// while dictation types into whatever native app has OS focus (WhisprFlow /
// SuperWhisper style). Agent-ask is a second mode on this same surface: speak a
// question, run an agent, paste the finished answer.
//
// postProcess keeps the standard AgentSelection as an explicit compatibility
// override. When it is empty, cleanup uses the node's Speech Processing layer.
// Cross-app reach (Spaces, MCP tools from other apps) still lives on a chosen
// custom agent's allowlists — Dictation settings expose those inline.

import {
	type AgentSelection,
	EMPTY_AGENT_SELECTION,
	parseAgentSelectionWithLegacyAgent,
} from "./agent-selection.ts";
import { type VoiceEngine, voiceEngineSchema } from "./voice.ts";

export type { AgentSelection } from "./agent-selection.ts";
export {
	EMPTY_AGENT_SELECTION,
	isAgentSelectionEmpty,
	parseAgentSelection,
} from "./agent-selection.ts";

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const DICTATION_PREF_KEY = "dictation";

/** Stable plugin / fixture id for the Dictation apps-store app. */
export const DICTATION_PLUGIN_ID = "dictation";

/**
 * How the dictation shortcut behaves. Mirrors {@link VoiceInputMode}:
 * - `"push-to-talk"`: hold the key to record, release to stop + insert.
 * - `"toggle"`: press once to start, again to stop.
 */
export type DictationMode = "toggle" | "push-to-talk";

/**
 * Pipeline task after transcription:
 * - `"transcribe"`: insert the (optionally cleaned) transcript.
 * - `"ask"`: run an agent on the transcript and insert the agent's answer.
 */
export type DictationTask = "transcribe" | "ask";

/**
 * How the transcribed (and optionally post-processed) text lands in the focused
 * app:
 * - `"type"`: synthetic Unicode keystrokes via ghost (`ghost.ghost_type`).
 * - `"paste"`: clipboard + paste chord via ghost (`ghost.ghost_hotkey`).
 */
export type DictationInsertMode = "type" | "paste";

/**
 * Optional cleanup of the raw transcript before it is inserted. An empty
 * `selection` uses the node's Speech Processing layer (S1-mini by Superwhisper);
 * a non-empty selection preserves the older custom agent/model override. Fails
 * open when a cleanup engine is unavailable, so raw ASR text is still inserted.
 */
export interface DictationPostProcess {
	enabled: boolean;
	/** System prompt handed the cleanup model/agent. */
	prompt: string;
	/** Standard agent OR model selection (same as other plugins). */
	selection: AgentSelection;
}

/**
 * Agent-ask mode: speak a question anywhere, run an agent/model, paste the answer
 * into the focused app. Separate shortcut from plain dictation so the two never
 * fight. When `selection` names an agent, that agent's tool/Spaces allowlists
 * control cross-app reach (Ghost, Spaces, chats tooling, etc.).
 */
export interface DictationAskPrefs {
	enabled: boolean;
	mode: DictationMode;
	/** System prompt for the ask agent/model. */
	prompt: string;
	/** Standard agent OR model selection. */
	selection: AgentSelection;
	/** Electron accelerator for agent-ask (distinct from {@link DictationPrefs.shortcut}). */
	shortcut: string;
}

/** The dictation settings blob persisted under {@link DICTATION_PREF_KEY}. */
export interface DictationPrefs {
	/** Agent-ask mode (speak a question → paste the answer). */
	ask: DictationAskPrefs;
	/** Press Enter after inserting (send the message / newline). */
	autoSend: boolean;
	/**
	 * Operational on/off mirrored from the Dictation plugin enable state. The
	 * plugin is the product switch; this field is what Island reads for shortcut
	 * registration and is synced by Core on plugin enable/disable.
	 */
	enabled: boolean;
	/** Transcription engine — the `?engine=` value Core's transcribe endpoint takes. */
	engine: VoiceEngine;
	insertMode: DictationInsertMode;
	mode: DictationMode;
	/**
	 * Paste chord for `insertMode: "paste"`, as `+`-joined tokens (e.g. `"ctrl+v"`).
	 * Empty = platform default.
	 */
	pasteKeys: string;
	postProcess: DictationPostProcess;
	/** Restore the pre-paste clipboard after a paste insertion. */
	restoreClipboard: boolean;
	/** Electron accelerator string handed to `globalShortcut.register`. */
	shortcut: string;
}

/** Default prompt for the legacy custom cleanup agent/model override. */
export const DEFAULT_DICTATION_POSTPROCESS_PROMPT =
	"You clean up dictated speech into polished written text. Fix grammar, punctuation, and capitalization, and remove filler words (um, uh, like, you know) and false starts. Preserve the original meaning and wording as much as possible. Output ONLY the cleaned text, with no preamble, quotes, or commentary.";

/** Default ask prompt: answer the spoken question; output only the answer. */
export const DEFAULT_DICTATION_ASK_PROMPT =
	"You answer the user's spoken question. Be concise and directly useful. Output ONLY the answer text that should be pasted into their focused app — no preamble, no quotes, no commentary about the fact they dictated.";

/** Default dictation shortcut. */
export const DEFAULT_DICTATION_SHORTCUT = "CommandOrControl+Shift+D";

/** Default agent-ask shortcut (distinct chord so it never fights dictation). */
export const DEFAULT_DICTATION_ASK_SHORTCUT = "CommandOrControl+Shift+A";

/** Default agent-ask settings: off until the user opts in and picks a target. */
export const DEFAULT_DICTATION_ASK: DictationAskPrefs = {
	enabled: false,
	mode: "push-to-talk",
	prompt: DEFAULT_DICTATION_ASK_PROMPT,
	selection: EMPTY_AGENT_SELECTION,
	shortcut: DEFAULT_DICTATION_ASK_SHORTCUT,
};

/** Default dictation settings: enabled, hold-to-talk, parakeet, S1-mini cleanup. */
export const DEFAULT_DICTATION_PREFS: DictationPrefs = {
	ask: DEFAULT_DICTATION_ASK,
	autoSend: false,
	enabled: true,
	engine: "parakeet",
	insertMode: "type",
	mode: "push-to-talk",
	pasteKeys: "",
	postProcess: {
		enabled: true,
		prompt: DEFAULT_DICTATION_POSTPROCESS_PROMPT,
		selection: EMPTY_AGENT_SELECTION,
	},
	restoreClipboard: true,
	shortcut: DEFAULT_DICTATION_SHORTCUT,
};

const modeSchema = z.enum(["toggle", "push-to-talk"]).catch("push-to-talk");
const selectedTargetSchema = z.object({
	selection: z.unknown().optional(),
	agent: z.unknown().optional(),
});
const postProcessSchema = selectedTargetSchema
	.extend({
		enabled: z.boolean().catch(false),
		prompt: z
			.string()
			.refine((value) => value.trim().length > 0)
			.catch(DEFAULT_DICTATION_POSTPROCESS_PROMPT),
	})
	.transform(
		(value): DictationPostProcess => ({
			enabled: value.enabled,
			prompt: value.prompt,
			selection: parseAgentSelectionWithLegacyAgent(
				value.selection,
				value.agent
			),
		})
	)
	.catch({ ...DEFAULT_DICTATION_PREFS.postProcess, enabled: false });
const askSchema = selectedTargetSchema
	.extend({
		enabled: z.boolean().catch(false),
		mode: modeSchema,
		prompt: z
			.string()
			.refine((value) => value.trim().length > 0)
			.catch(DEFAULT_DICTATION_ASK_PROMPT),
		shortcut: z.string().trim().min(1).catch(DEFAULT_DICTATION_ASK_SHORTCUT),
	})
	.transform(
		(value): DictationAskPrefs => ({
			enabled: value.enabled,
			mode: value.mode,
			prompt: value.prompt,
			selection: parseAgentSelectionWithLegacyAgent(
				value.selection,
				value.agent
			),
			shortcut: value.shortcut,
		})
	)
	.catch(DEFAULT_DICTATION_ASK);
const dictationPrefsSchema = z
	.object({
		ask: askSchema,
		autoSend: z.boolean().catch(false),
		enabled: z.boolean().catch(true),
		engine: voiceEngineSchema,
		insertMode: z.enum(["type", "paste"]).catch("type"),
		mode: modeSchema,
		pasteKeys: z.string().trim().catch(""),
		postProcess: z.preprocess(
			(value) => (value == null ? { enabled: true } : value),
			postProcessSchema
		),
		restoreClipboard: z.boolean().catch(true),
		shortcut: z.string().trim().min(1).catch(DEFAULT_DICTATION_SHORTCUT),
	})
	.catch(DEFAULT_DICTATION_PREFS);

/** Parse persisted dictation settings, preserving field-level compatibility defaults. */
export function parseDictationPrefs(raw: string | null): DictationPrefs {
	if (!raw) {
		return DEFAULT_DICTATION_PREFS;
	}
	try {
		return dictationPrefsSchema.parse(JSON.parse(raw));
	} catch {
		return DEFAULT_DICTATION_PREFS;
	}
}
