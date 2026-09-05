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

/** Transcribe a recorded audio blob via Core's selected STT runtime. */
export async function transcribeAudio(
	target: ApiTarget,
	audio: Blob,
	filename = "recording.wav",
	engine?: string
): Promise<string> {
	const form = new FormData();
	form.append("file", audio, filename);
	const selectedEngine = engine?.trim();
	const path = selectedEngine
		? `/api/voice/transcribe?engine=${encodeURIComponent(selectedEngine)}`
		: "/api/voice/transcribe";

	const resp = await authenticatedFetch(target, path, {
		method: "POST",
		headers: { "Content-Type": null },
		body: form,
	});

	if (!resp.ok) {
		let detail = `transcribe failed: ${resp.status}`;
		try {
			const body = (await resp.json()) as { error?: string };
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	const body = (await resp.json()) as { text?: string };
	return (body.text ?? "").trim();
}

/** S1-mini styling controls exposed by the Speech Processing layer. */
export type SpeechProcessingStyling =
	| "casual"
	| "semi-casual"
	| "semi-formal"
	| "formal";

/** One node-local engine that can clean a raw Voice Recognition transcript. */
export interface SpeechProcessingEngine {
	description: string;
	display_name: string;
	id: string;
	installed: boolean;
	languages: string[];
	loaded: boolean;
	model: string;
	sidecar: string;
	size_mb: number;
}

/** S1-mini request controls. The defaults are applied by Core when omitted. */
export interface SpeechProcessingOptions {
	context?: "general" | "email";
	engine?: string;
	structure?: "prose" | "lists";
	styling?: SpeechProcessingStyling;
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
	const body = (await resp.json()) as {
		data?: SpeechProcessingEngine[];
	};
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
			const body = (await resp.json()) as { error?: string };
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
			const body = (await resp.json()) as { error?: string };
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Keep the status-based message for a non-JSON error body.
		}
		throw new Error(detail);
	}
	const body = (await resp.json()) as { text?: string };
	return (body.text ?? "").trim();
}

/** One selectable Audio engine, as Core's `/api/voice/tts-engines`
 * returns it (built-in OuteTTS, native audio.cpp, and RyuTTS entries). */
export interface TtsEngine {
	default_voice: string;
	description: string;
	display_name: string;
	id: string;
	installed: boolean;
	languages: string[];
	loaded: boolean;
	sample_rate: number;
	size_mb: number;
	supports_cloning: boolean;
	voices: string[];
}

/** List the Audio engines available on this node. Core owns the built-in/native
 * rows and mirrors any additional RyuTTS engines. */
export async function listTtsEngines(target: ApiTarget): Promise<TtsEngine[]> {
	const resp = await authenticatedFetch(target, "/api/voice/tts-engines");
	if (!resp.ok) {
		throw new Error(`audio engines failed: ${resp.status}`);
	}
	const body = (await resp.json()) as { data?: TtsEngine[] };
	return body.data ?? [];
}

/** One curated, installable Audio model (voicebox-style), bound to its engine. */
export interface TtsModel {
	default: boolean;
	display_name: string;
	engine: string;
	engine_display_name: string;
	hf_repo_id: string;
	installed: boolean;
	languages: string[];
	model_name: string;
	size_mb: number;
}

/** List the curated, installable Audio models (the known-good set Core can install
 * + run), distinct from the raw HF text-to-speech browse in the Models tab. */
export async function listTtsModels(target: ApiTarget): Promise<TtsModel[]> {
	const resp = await authenticatedFetch(target, "/api/voice/tts-models");
	if (!resp.ok) {
		throw new Error(`audio models failed: ${resp.status}`);
	}
	const body = (await resp.json()) as { data?: TtsModel[] };
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
			const body = (await resp.json()) as { error?: string };
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
	/** Engine id; omit (or `"outetts"`) for the built-in default. */
	engine?: string;
	/** Language hint for multilingual engines. */
	language?: string;
	/** Reference wav path/URL for cloning-capable engines. */
	referenceAudio?: string;
	/** Speaking-rate multiplier where supported. */
	speed?: number;
	/** Voice id (engine-specific); defaults to the engine's default voice. */
	voice?: string;
}

/** Synthesize speech via Core's `/api/voice/speak`, returning a playable WAV blob.
 * The engine is whatever the caller selects — Core routes it to the matching
 * built-in, native audio.cpp, cloud, or RyuTTS runtime. */
export async function speakText(
	target: ApiTarget,
	text: string,
	options: SpeakOptions = {}
): Promise<Blob> {
	const resp = await authenticatedFetch(target, "/api/voice/speak", {
		method: "POST",
		body: JSON.stringify({
			text,
			engine: options.engine,
			voice: options.voice,
			speed: options.speed,
			language: options.language,
			reference_audio: options.referenceAudio,
		}),
	});

	if (!resp.ok) {
		let detail = `speak failed: ${resp.status}`;
		try {
			const body = (await resp.json()) as { error?: string };
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Non-JSON error body — keep the status-based message.
		}
		throw new Error(detail);
	}

	return await resp.blob();
}
