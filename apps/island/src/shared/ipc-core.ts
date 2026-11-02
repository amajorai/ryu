// Part of the Island IPC type contract; `./ipc.ts` re-exports it, so import
// from there. Type-only: the sandboxed preload loads `./ipc.ts` at runtime.

import type { LanguagePack } from "@ryu/i18n/core";
import type { AcpConfig } from "./acp.ts";
import type { IslandIpcValue } from "./ipc.ts";

// ── Core: chat stream (AI SDK v6 UI Message Stream) ──────────────────────────

/**
 * An AI SDK v6 file part (image attachment). Core's chat-stream adapter reads
 * `parts` for any `type: "file"` with an `image/*` `mediaType` and forwards the
 * base64 from the data `url` to the model — the same shape the desktop composer
 * sends. Non-image files are not wired (the default island agent has no file
 * tools), so the attach action only stages images.
 */
export interface CoreFilePart {
	filename?: string;
	/** MIME type, e.g. `image/png`. */
	mediaType: string;
	type: "file";
	/** A `data:<mime>;base64,...` URL carrying the image bytes. */
	url: string;
}

/** A single chat message in the AI SDK UIMessage shape Core accepts. */
export interface CoreChatMessage {
	/** Plain text content. Core also accepts a `parts` array but text is enough. */
	content: string;
	/** Optional image attachments for this turn (multimodal user messages). */
	parts?: CoreFilePart[];
	role: "user" | "assistant" | "system";
}

/**
 * An image the user attached via the island's attach action. Read into a data
 * URL in the main process so the renderer can both preview it (chip thumbnail)
 * and send it to Core as a {@link CoreFilePart} without touching the filesystem.
 */
export interface IslandAttachment {
	/** `data:<mime>;base64,...` URL of the file bytes. */
	dataUrl: string;
	mimeType: string;
	/** Display name (basename). */
	name: string;
	/** Absolute source path (stable id + de-dupe key). */
	path: string;
}

/**
 * A message on the streaming chat request. Deliberately WIDER than
 * {@link CoreChatMessage}: `/api/chat/stream` takes the full AI SDK `UIMessage`,
 * and the island now posts back the entire message history the chat runtime
 * holds — including assistant turns whose `parts` carry tool calls and results.
 * Narrowing those to `{role, content}` would erase every prior tool call from
 * the model's view of the conversation on the second turn.
 *
 * `parts` is `unknown[]` rather than a mirrored part union on purpose: the part
 * shapes are the AI SDK's, they grow with the SDK, and the main process only
 * forwards this object to Core verbatim. Typing them here would be a copy that
 * silently rots.
 */
export interface CoreUiMessage {
	/** Legacy plain-text form. Omitted when `parts` carries the content. */
	content?: string;
	id?: string;
	parts?: unknown[];
	role: "user" | "assistant" | "system";
}

/** Body for `POST /api/chat/stream` (subset of Core's `ChatStreamRequest`). */
export interface CoreChatStreamRequest {
	acp_config?: Record<string, string>;
	acp_mode?: string;
	acp_model?: string;
	agent_id?: string;
	/** True when this turn originates from the context companion (DLP path). */
	companion_source?: boolean;
	conversation_id?: string;
	/** Opt-in cross-session memory. Defaults to false (privacy by default). */
	enable_long_term?: boolean;
	messages: CoreUiMessage[];
	/**
	 * Whether Core should persist this turn to the conversation store. Core
	 * defaults to `true`; the proactive suggestion engine sets it `false` so each
	 * background suggestion does not leave an orphan "App: …" conversation behind.
	 */
	persist?: boolean;
	/**
	 * Opt-in per-turn plugin toggles Core's server-side turn-hooks read. The island
	 * surfaces `"io.ryu.double-check"`; Core reviews the answer only when it is true.
	 */
	plugin_flags?: Record<string, boolean>;
}

// AI SDK v6 UI Message Stream parts emitted by Core over SSE. Each `data:` line
// carries one JSON object discriminated by `type`. The parser (`parseSsePart`)
// decodes these; the main process forwards every part to the renderer as a
// `core:streamPart` event.

export interface StartPart {
	type: "start";
}
export interface TextStartPart {
	id: string;
	type: "text-start";
}
export interface TextDeltaPart {
	delta: string;
	id: string;
	type: "text-delta";
}
export interface TextEndPart {
	id: string;
	type: "text-end";
}
export interface ToolInputAvailablePart {
	dynamic?: boolean;
	input: unknown;
	toolCallId: string;
	toolName: string;
	type: "tool-input-available";
}
export interface ToolOutputAvailablePart {
	dynamic?: boolean;
	output: unknown;
	toolCallId: string;
	type: "tool-output-available";
}
export interface FinishPart {
	type: "finish";
}
export interface ErrorPart {
	errorText: string;
	type: "error";
}
/**
 * An out-of-band note from a Core server-side turn-hook (goal/proof/double-check).
 * Streamed as an EXTRA SSE frame in the same response — never assistant history —
 * so the island renders it as a distinct system note, not a chat bubble.
 */
export interface PluginNotePart {
	data: { text: string };
	type: "data-plugin_note";
}

/** Any unrecognized part still carries a string `type` discriminator. */
export interface OtherPart {
	type: string;
	[key: string]: IslandIpcValue;
}

export type CoreStreamPart =
	| StartPart
	| TextStartPart
	| TextDeltaPart
	| TextEndPart
	| ToolInputAvailablePart
	| ToolOutputAvailablePart
	| FinishPart
	| ErrorPart
	| PluginNotePart
	| OtherPart;

/** Envelope the renderer receives for each streamed part. */
export interface CoreStreamPartEvent {
	part: CoreStreamPart;
	streamId: string;
}

/** Terminal envelope: the stream ended (cleanly, via abort, or with error). */
export interface CoreStreamEndEvent {
	/** Human-readable error message when `reason === "error"`. */
	error?: string;
	/** Reason the stream ended. `done` is the normal [DONE] terminator. */
	reason: "done" | "aborted" | "error";
	streamId: string;
}

/** Handle returned by `chatStream` so the renderer can abort the stream. */
export interface CoreChatStreamHandle {
	streamId: string;
}

// ── Core: non-streaming completions + tools + sidecars ───────────────────────

/** Result of a graceful health probe. Never rejects to the renderer. */
export interface AvailabilityResult {
	available: boolean;
	/** Why the service is unavailable (timeout, connection refused, …). */
	reason?: string;
}

/** Body for `POST /v1/chat/completions`. `model` omitted = local Gemma 4 E2B. */
export interface CoreCompletionsRequest {
	messages: CoreChatMessage[];
	model?: string;
}

/** Result of a non-streaming completion. */
export type CoreCompletionsResult =
	| { available: true; text: string }
	| { available: false; reason: string };

/** Body for `POST /api/mcp/tools/call`. */
export interface CoreToolCallRequest {
	/** Required by Core to resolve the per-agent allowlist. */
	agent_id: string;
	arguments: Record<string, IslandIpcValue>;
	tool: string;
}

/** Result of an MCP tool call. */
export type CoreToolCallResult =
	| { available: true; ok: boolean; output?: unknown; error?: string }
	| { available: false; reason: string };

/** Body for `POST /api/voice/transcribe` (multipart, built in the main process). */
export interface CoreTranscribeRequest {
	/** 16 kHz mono WAV bytes captured in the renderer. */
	audio: ArrayBuffer;
	/** Transcription engine (`"whisper"` | `"audiocpp"` | `"parakeet"`), the `?engine=` value. */
	engine: string;
	/** Optional transcription request options (see {@link CoreTranscribeOptions}). */
	options?: CoreTranscribeOptions;
}

/** Optional per-request transcription options. */
export interface CoreTranscribeOptions {
	/** Also return Core's timed segments/words (`detail`). */
	detailed?: boolean;
	/** Multipart filename for the upload; defaults to `audio.wav`. */
	filename?: string;
}

/** Result of a transcription request. Never rejects to the renderer. */
export type CoreTranscribeResult =
	| {
			available: true;
			text: string;
			/** Timed segments/words, present only when `detailed` was requested. */
			detail?: import("@ryuhq/core-client/voice").TranscriptionDetail;
	  }
	| { available: false; reason: string };

/** Request for Core's node-local Speech Processing cleanup stage. */
export interface CoreSpeechProcessingRequest {
	context?: "general" | "email";
	engine: string;
	structure?: "prose" | "lists";
	styling?: "casual" | "semi-casual" | "semi-formal" | "formal";
	text: string;
}

/** Result of Speech Processing. Empty text is valid for filler-only input. */
export type CoreSpeechProcessingResult =
	| { available: true; text: string }
	| { available: false; reason: string };

/** Request for `POST /api/voice/speak` (text-to-speech), built in the main process. */
export interface CoreSpeakRequest {
	/** TTS engine id; omit (or `"outetts"`) for the built-in default. */
	engine?: string;
	/** Text to synthesize. */
	text: string;
	/** Voice id (engine-specific); omit for the engine's default voice. */
	voice?: string;
}

/** Result of a speak request. Carries the WAV bytes for the renderer to play. */
export type CoreSpeakResult =
	| { available: true; audio: ArrayBuffer; mime: string }
	| { available: false; reason: string };

/**
 * Result of a dictation submission: the renderer hands captured WAV to the main
 * process, which transcribes, optionally post-processes, and inserts the text
 * into the focused app. `ok` false carries a short reason the renderer can flash
 * on the recording pill (empty capture, engine not running, transcribe/insert
 * failure); `text` is the inserted text on success, for an optional confirmation.
 */
export type DictationSubmitResult =
	| { ok: true; text: string }
	| { ok: false; reason: string };

/** A single sidecar's status from `GET /api/sidecar/status`. */
export interface SidecarStatus {
	name: string;
	running: boolean;
}

/** Result of a sidecar status probe. */
export type SidecarStatusResult =
	| { available: true; sidecars: SidecarStatus[] }
	| { available: false; reason: string };

/** Result of the main-process installed language-pack read. */
export type LanguagePacksResult =
	| { available: true; packs: LanguagePack[] }
	| { available: false; reason: string };

// ── Core: agents + conversations (command palette data) ──────────────────────
//
// The expanded island's command surface lists the installed agents and recent
// conversations as palette entries. Both are read in the main process (CORS) and
// degrade gracefully to an `{ available: false }` envelope.

/** One installed agent, as the command palette needs it. */
export interface CoreAgentSummary {
	/** Derived from registry built-ins that serialize `transport`. */
	builtIn?: boolean;
	description: string | null;
	engine: string | null;
	id: string;
	model: string | null;
	name: string;
	/** True for the flagship default (the locked `ryu` card). */
	recommended: boolean;
	transport: string | null;
}

/** Result of an agent list probe. */
export type AgentsResult =
	| { available: true; agents: CoreAgentSummary[] }
	| { available: false; reason: string };

/** Result of an ACP config probe for one agent. */
export type AcpConfigResult =
	| { available: true; config: AcpConfig }
	| { available: false; reason: string };

/** Per-engine chat model catalog from Core. */
export type EngineModelsResult =
	| { available: true; models: Record<string, { id: string; name: string }[]> }
	| { available: false; reason: string };

/** One recent conversation, as the command palette needs it. */
export interface CoreConversationSummary {
	id: string;
	title: string;
}

/** Result of a conversation list probe. */
export type ConversationsResult =
	| { available: true; conversations: CoreConversationSummary[] }
	| { available: false; reason: string };

/** Result of a sidecar start request. */
export type SidecarStartResult =
	| { available: true; success: boolean; error?: string }
	| { available: false; reason: string };
