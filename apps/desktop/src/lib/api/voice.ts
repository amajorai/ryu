import type { VoiceEngineInstallRecord } from "@ryu/app-host/rpc";
import {
	parseTranscriptionDetail,
	type SpeakEffect,
	type SpeakFormat,
	type SpeakNormalize,
	type SpeechProcessingEngine,
	type SpeechProcessingOptions,
	speakRequestBody,
	speechResponseBlob,
	type TranscriptionDetail,
	type TtsEngine,
	type TtsModel,
} from "@ryuhq/core-client/voice.ts";
import {
	speechProcessingEnginesWireSchema,
	transcriptionTextProjectionSchema,
	ttsEnginesWireSchema,
	ttsModelsWireSchema,
	voiceEngineInstallErrorProjectionSchema,
	voiceEngineInstallWireSchema,
	voiceErrorProjectionSchema,
	voiceTextProjectionSchema,
} from "./voice-wire-contracts.ts";
// apps/desktop/src/lib/api/voice.ts
//
// Typed client for Core's Voice Recognition data path (`POST /api/voice/transcribe`).
// Core proxies the uploaded audio to the selected local/cloud STT runtime and
// returns `{ text }`. The whisper/audio.cpp builds decode WAV, so the
// recorder uploads 16 kHz mono PCM WAV (see hooks/useVoiceRecorder.ts) rather
// than the browser's default webm/opus.
//
// Placement: this is a Core data-path call (it decides *what runs* — which local
// voice engine transcribes), reached through the same node target as every other
// Core client module.

import { type ApiTarget, authenticatedFetch } from "./client.ts";

export type {
	SpeechProcessingEngine,
	SpeechProcessingOptions,
	SpeechProcessingStyling,
	TtsEngine,
	TtsModel,
} from "@ryuhq/core-client/voice.ts";

/** `/api/voice/transcribe` with the optional engine and language hint. */
function transcriptionPath(engine?: string, language?: string): string {
	const query = new URLSearchParams();
	const selectedEngine = engine?.trim();
	if (selectedEngine) {
		query.set("engine", selectedEngine);
	}
	// An explicit `auto` is forwarded: it overrides a saved engine language
	// and asks the engine to detect the language.
	const hint = language?.trim();
	if (hint) {
		query.set("language", hint);
	}
	const search = query.toString();
	return search ? `/api/voice/transcribe?${search}` : "/api/voice/transcribe";
}

/** Transcribe a recorded audio blob via Core's selected STT runtime. */
async function transcriptionResponse(
	target: ApiTarget,
	audio: Blob,
	filename = "recording.wav",
	engine?: string,
	language?: string
): Promise<Response> {
	const form = new FormData();
	form.append("file", audio, filename);
	const path = transcriptionPath(engine, language);

	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		headers: { "Content-Type": null },
		body: form,
	});

	if (!resp.ok) {
		let detail = `transcribe failed: ${resp.status}`;
		try {
			const body = voiceErrorProjectionSchema.parse(await resp.json());
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	return resp;
}

/**
 * `language` is an optional BCP-47 hint for multilingual engines (empty sends
 * none and keeps the saved engine language; `auto` asks for detection and
 * overrides it); engines without language support ignore it.
 */
export async function transcribeAudioDetailed(
	target: ApiTarget,
	audio: Blob,
	filename = "recording.wav",
	engine?: string,
	language?: string
): Promise<TranscriptionDetail> {
	return parseTranscriptionDetail(
		await (
			await transcriptionResponse(target, audio, filename, engine, language)
		).json()
	);
}
export async function transcribeAudio(
	target: ApiTarget,
	audio: Blob,
	filename = "recording.wav",
	engine?: string,
	language?: string
): Promise<string> {
	const response = await transcriptionResponse(
		target,
		audio,
		filename,
		engine,
		language
	);
	const result = transcriptionTextProjectionSchema.safeParse(
		await response.json()
	);
	return result.success ? result.data.text.trim() : "";
}

/** List the node's Speech Processing engines and their install/load state. */
export async function listSpeechProcessingEngines(
	target: ApiTarget
): Promise<SpeechProcessingEngine[]> {
	const resp = await authenticatedFetch(
		target,
		"/api/voice/speech-processing-engines"
	);
	if (!resp.ok) {
		throw new Error(`Speech Processing engines failed: ${resp.status}`);
	}
	const body = speechProcessingEnginesWireSchema.parse(await resp.json());
	return body.data ?? [];
}

/** Install the curated default Speech Processing model through Core. */
export async function installSpeechProcessingModel(
	target: ApiTarget,
	engine = "s1-mini"
): Promise<void> {
	const resp = await authenticatedFetch(
		target,
		"/api/voice/speech-processing-model/install",
		{
			method: "POST",
			body: JSON.stringify({ engine }),
		}
	);
	if (!resp.ok) {
		let detail = `Speech Processing install failed: ${resp.status}`;
		try {
			const body = voiceErrorProjectionSchema.parse(await resp.json());
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Keep the status-based message for a non-JSON error body.
		}
		throw new Error(detail);
	}
}

/** Clean one raw Voice Recognition transcript with the selected local engine. */
export async function processSpeechText(
	target: ApiTarget,
	text: string,
	options: SpeechProcessingOptions = {}
): Promise<string> {
	const resp = await authenticatedFetch(
		target,
		"/api/voice/speech-processing",
		{
			method: "POST",
			body: JSON.stringify({
				text,
				engine: options.engine,
				styling: options.styling,
				structure: options.structure,
				context: options.context,
			}),
		}
	);
	if (!resp.ok) {
		let detail = `Speech Processing failed: ${resp.status}`;
		try {
			const body = voiceErrorProjectionSchema.parse(await resp.json());
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Keep the status-based message for a non-JSON error body.
		}
		throw new Error(detail);
	}
	const body = voiceTextProjectionSchema.parse(await resp.json());
	return (body.text ?? "").trim();
}

/** List the Audio engines available on this node. Core owns the built-in/native
 * rows and mirrors any additional RyuTTS engines. */
export async function listTtsEngines(target: ApiTarget): Promise<TtsEngine[]> {
	const resp = await authenticatedFetch(target, "/api/voice/tts-engines");
	if (!resp.ok) {
		throw new Error(`audio engines failed: ${resp.status}`);
	}
	const body = ttsEnginesWireSchema.parse(await resp.json());
	return body.data ?? [];
}

/** Install one registered TTS runtime through Core's managed sidecar. */
export async function installTtsEngine(
	target: ApiTarget,
	engine: string,
	options: { appId?: string; appPermission?: string } = {}
): Promise<VoiceEngineInstallRecord> {
	const headers =
		options.appId && options.appPermission
			? {
					"x-ryu-app-id": options.appId,
					"x-ryu-app-permission": options.appPermission,
				}
			: undefined;
	const resp = await authenticatedFetch(
		target,
		"/api/voice/tts-engines/install",
		{
			method: "POST",
			headers,
			body: JSON.stringify({ engine }),
		}
	);
	if (!resp.ok) {
		let detail = `TTS engine install failed: ${resp.status}`;
		try {
			const body = voiceEngineInstallErrorProjectionSchema.parse(
				await resp.json()
			);
			if (body.detail || body.error) {
				detail = [body.error, body.detail].filter(Boolean).join(": ");
			}
		} catch {
			// Keep the status-based message for a non-JSON response.
		}
		throw new Error(detail);
	}
	const parsed = voiceEngineInstallWireSchema.safeParse(await resp.json());
	const body = parsed.success ? parsed.data : null;
	if (body?.engine !== engine || body?.installed !== true) {
		throw new Error("Core did not confirm the speech engine install.");
	}
	return {
		already_installed: body.already_installed === true,
		engine,
		installed: true,
	};
}

/** List the curated, installable Audio models (the known-good set Core can install
 * + run), distinct from the raw HF text-to-speech browse in the Models tab. */
export async function listTtsModels(target: ApiTarget): Promise<TtsModel[]> {
	const resp = await authenticatedFetch(target, "/api/voice/tts-models");
	if (!resp.ok) {
		throw new Error(`audio models failed: ${resp.status}`);
	}
	const body = ttsModelsWireSchema.parse(await resp.json());
	return body.data ?? [];
}

/** Download a curated Audio model into Core's HF cache. Resolves when the snapshot
 * is present (idempotent — a cache hit returns immediately). */
export async function installTtsModel(
	target: ApiTarget,
	engine: string,
	modelName: string
): Promise<void> {
	const resp = await authenticatedFetch(
		target,
		"/api/voice/tts-models/install",
		{
			method: "POST",
			body: JSON.stringify({ engine, model_name: modelName }),
		}
	);
	if (!resp.ok) {
		let detail = `install failed: ${resp.status}`;
		try {
			const body = voiceErrorProjectionSchema.parse(await resp.json());
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// keep status-based message
		}
		throw new Error(detail);
	}
}

/** Options for {@link speakText}. */
export interface SpeakOptions {
	/** Host attribution for app-level generation ACLs. */
	appId?: string;
	/** Human-facing app permission required for this host-direct call. */
	appPermission?: string;
	/** Studio fields, forwarded to the Ryu Audio sidecar (see core-client). */
	effects?: SpeakEffect[];
	/** Engine id; omit (or `"outetts"`) for the built-in default. */
	engine?: string;
	format?: SpeakFormat;
	instruct?: string;
	/** Language hint for multilingual engines. */
	language?: string;
	normalize?: SpeakNormalize;
	/** Reference wav path/URL for cloning-capable engines. */
	referenceAudio?: string;
	/** Core-validated in-memory WAV sample for a Companion voice clone. */
	referenceAudioDataUrl?: string;
	referenceText?: string;
	/** Correlates this narration with an app-owned Gateway audit request. */
	requestId?: string;
	seed?: number;
	/** Speaking-rate multiplier where supported. */
	speed?: number;
	/** Voice id (engine-specific); defaults to the engine's default voice. */
	voice?: string;
}

/** Synthesize speech via Core's `/api/voice/speak`, returning a playable blob
 * typed with the container Core served (WAV unless `format` chose another).
 * The engine is whatever the caller selects — Core routes it to the matching
 * built-in, native audio.cpp, cloud, or RyuTTS runtime. */
export async function speakText(
	target: ApiTarget,
	text: string,
	options: SpeakOptions = {}
): Promise<Blob> {
	const resp = await authenticatedFetch(target, "/api/voice/speak", {
		method: "POST",
		headers:
			options.appId && options.appPermission
				? {
						"x-ryu-app-id": options.appId,
						"x-ryu-app-permission": options.appPermission,
					}
				: undefined,
		body: JSON.stringify(speakRequestBody(text, options)),
	});

	if (!resp.ok) {
		let detail = `speak failed: ${resp.status}`;
		try {
			const body = voiceErrorProjectionSchema.parse(await resp.json());
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	return await speechResponseBlob(resp);
}
