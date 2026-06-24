// apps/desktop/src/lib/api/voice.ts
//
// Typed client for Core's speech-to-text data path (`POST /api/voice/transcribe`).
// Core proxies the uploaded audio to the whisper.cpp voice sidecar's `/inference`
// endpoint and returns `{ text }`. The whisper-server build decodes WAV, so the
// recorder uploads 16 kHz mono PCM WAV (see hooks/useVoiceRecorder.ts) rather
// than the browser's default webm/opus.
//
// Placement: this is a Core data-path call (it decides *what runs* — which local
// voice engine transcribes), reached through the same node target as every other
// Core client module.

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

/** Transcribe a recorded audio blob via Core's whisper proxy. Returns the text. */
export async function transcribeAudio(
	target: ApiTarget,
	audio: Blob,
	filename = "recording.wav"
): Promise<string> {
	const form = new FormData();
	form.append("file", audio, filename);

	// Don't use makeHeaders' JSON content-type — FormData sets its own multipart
	// boundary. Carry only the bearer token when present.
	const headers: Record<string, string> = {};
	const auth = makeHeaders(target.token).Authorization;
	if (auth) {
		headers.Authorization = auth;
	}

	const resp = await fetch(apiUrl(target, "/api/voice/transcribe"), {
		method: "POST",
		headers,
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

/** One selectable text-to-speech engine, as Core's `/api/voice/tts-engines`
 * returns it (built-in OuteTTS + whatever the Ryu TTS sidecar registry serves). */
export interface TtsEngine {
	id: string;
	display_name: string;
	description: string;
	voices: string[];
	default_voice: string;
	sample_rate: number;
	supports_cloning: boolean;
	languages: string[];
	size_mb: number;
	installed: boolean;
	loaded: boolean;
}

/** List the TTS engines available on this node (nothing hardcoded — Core mirrors
 * the sidecar registry). Always includes the built-in `outetts`. */
export async function listTtsEngines(target: ApiTarget): Promise<TtsEngine[]> {
	const resp = await fetch(apiUrl(target, "/api/voice/tts-engines"), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`tts-engines failed: ${resp.status}`);
	}
	const body = (await resp.json()) as { data?: TtsEngine[] };
	return body.data ?? [];
}

/** One curated, installable TTS model (voicebox-style), bound to its engine. */
export interface TtsModel {
	model_name: string;
	display_name: string;
	engine: string;
	engine_display_name: string;
	hf_repo_id: string;
	size_mb: number;
	languages: string[];
	default: boolean;
	installed: boolean;
}

/** List the curated, installable TTS models (the known-good set Core can install
 * + run), distinct from the raw HF text-to-speech browse in the Models tab. */
export async function listTtsModels(target: ApiTarget): Promise<TtsModel[]> {
	const resp = await fetch(apiUrl(target, "/api/voice/tts-models"), {
		headers: makeHeaders(target.token),
	});
	if (!resp.ok) {
		throw new Error(`tts-models failed: ${resp.status}`);
	}
	const body = (await resp.json()) as { data?: TtsModel[] };
	return body.data ?? [];
}

/** Download a curated TTS model into Core's HF cache. Resolves when the snapshot
 * is present (idempotent — a cache hit returns immediately). */
export async function installTtsModel(
	target: ApiTarget,
	engine: string,
	modelName: string
): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/voice/tts-models/install"), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify({ engine, model_name: modelName }),
	});
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
	/** Voice id (engine-specific); defaults to the engine's default voice. */
	voice?: string;
	/** Speaking-rate multiplier where supported. */
	speed?: number;
	/** Language hint for multilingual engines. */
	language?: string;
	/** Reference wav path/URL for cloning-capable engines. */
	referenceAudio?: string;
}

/** Synthesize speech via Core's `/api/voice/speak`, returning a playable WAV blob.
 * The engine is whatever the caller selects — Core routes built-ins to OuteTTS and
 * everything else to the universal Ryu TTS sidecar. */
export async function speakText(
	target: ApiTarget,
	text: string,
	options: SpeakOptions = {}
): Promise<Blob> {
	const resp = await fetch(apiUrl(target, "/api/voice/speak"), {
		method: "POST",
		headers: makeHeaders(target.token),
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
