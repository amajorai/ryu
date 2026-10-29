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

import { z } from "zod";

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";

export interface TranscriptionDetail {
	segments: { startMs: number; endMs: number; text: string }[];
	text: string;
	words?: { startMs: number; endMs: number; text: string }[];
}
const transcriptionSegmentSchema = z
	.object({
		startMs: z.number().int().safe().nonnegative(),
		endMs: z.number().int().safe().max(7_200_000),
		text: z
			.string()
			.max(8000)
			.transform((text) => text.trim()),
	})
	.refine((segment) => segment.endMs >= segment.startMs);
const transcriptionDetailSchema = z
	.object({
		text: z.string().transform((text) => text.trim()),
		segments: z.array(transcriptionSegmentSchema).max(5000).default([]),
		words: z.array(transcriptionSegmentSchema).max(5000).optional(),
	})
	.transform((value): TranscriptionDetail => {
		const detail: TranscriptionDetail = {
			text: value.text,
			segments: value.segments,
		};
		if (value.words?.length) {
			detail.words = value.words;
		}
		return detail;
	});

export const parseTranscriptionDetail = z
	.unknown()
	.transform((value): TranscriptionDetail => {
		const result = transcriptionDetailSchema.safeParse(value);
		if (!result.success) {
			const issue = result.error.issues[0];
			if (issue?.path[0] === "segments") {
				throw new Error(
					issue.path.length === 1
						? "Invalid transcription segments"
						: "Invalid transcription segment"
				);
			}
			if (issue?.path[0] === "words") {
				throw new Error(
					issue.path.length === 1
						? "Invalid transcription words"
						: "Invalid transcription segment"
				);
			}
			throw new Error("Invalid transcription response");
		}
		return result.data;
	}).parse;
const errorResponseSchema = z.object({ error: z.string().optional() });
const textResponseSchema = z
	.object({ text: z.string().catch("") })
	.catch(() => ({ text: "" }));

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

/** Transcribe a recorded audio blob via Core's whisper proxy. Returns the text. */
async function transcriptionResponse(
	target: ApiTarget,
	audio: Blob,
	filename = "recording.wav",
	engine?: string,
	language?: string
): Promise<Response> {
	const form = new FormData();
	form.append("file", audio, filename);

	// Don't use makeHeaders' JSON content-type — FormData sets its own multipart
	// boundary. Carry only the bearer token when present.
	const headers = new Headers(makeHeaders(target.token, target.userJwt));
	headers.delete("Content-Type");

	const resp = await fetchForTarget(target)(
		apiUrl(target, transcriptionPath(engine, language)),
		{
			method: "POST",
			headers,
			body: form,
		}
	);

	if (!resp.ok) {
		let detail = `transcribe failed: ${resp.status}`;
		try {
			const body = errorResponseSchema.parse(await resp.json());
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
	const response = await transcriptionResponse(
		target,
		audio,
		filename,
		engine,
		language
	);
	return parseTranscriptionDetail(await response.json());
}
export async function transcribeAudio(
	target: ApiTarget,
	audio: Blob,
	filename = "recording.wav",
	language?: string
): Promise<string> {
	const response = await transcriptionResponse(
		target,
		audio,
		filename,
		undefined,
		language
	);
	return textResponseSchema.parse(await response.json()).text.trim();
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

export const speechProcessingEngineSchema = z.object({
	description: z.string(),
	display_name: z.string(),
	id: z.string(),
	installed: z.boolean(),
	languages: z.array(z.string()),
	loaded: z.boolean(),
	model: z.string(),
	sidecar: z.string(),
	size_mb: z.number(),
});
const speechProcessingEnginesResponseSchema = z.object({
	data: z.array(speechProcessingEngineSchema).default([]),
});

/** List the node's Speech Processing engines and their install/load state. */
export async function listSpeechProcessingEngines(
	target: ApiTarget
): Promise<SpeechProcessingEngine[]> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/speech-processing-engines"),
		{
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`Speech Processing engines failed: ${resp.status}`);
	}
	const body = speechProcessingEnginesResponseSchema.parse(await resp.json());
	return body.data ?? [];
}

/** Install the curated default Speech Processing model through Core. */
export async function installSpeechProcessingModel(
	target: ApiTarget,
	engine = "s1-mini"
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/speech-processing-model/install"),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ engine }),
		}
	);
	if (!resp.ok) {
		let detail = `Speech Processing install failed: ${resp.status}`;
		try {
			const body = errorResponseSchema.parse(await resp.json());
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
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/speech-processing"),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
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
			const body = errorResponseSchema.parse(await resp.json());
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// Keep the status-based message for a non-JSON error body.
		}
		throw new Error(detail);
	}
	const body = textResponseSchema.parse(await resp.json());
	return (body.text ?? "").trim();
}

/** One selectable text-to-speech engine, as Core's `/api/voice/tts-engines`
 * returns it (built-in OuteTTS + whatever the Ryu TTS sidecar registry serves). */
export interface TtsEngine {
	/** Additive capability fields; nodes before the studio contract omit them. */
	commercial_use?: boolean;
	default_voice: string;
	description: string;
	display_name: string;
	id: string;
	installed: boolean;
	languages: string[];
	license?: string;
	loaded: boolean;
	native_speed?: boolean;
	paralinguistic_tags?: string[];
	sample_rate: number;
	size_mb: number;
	supports_cloning: boolean;
	supports_design?: boolean;
	supports_instruct?: boolean;
	supports_seed?: boolean;
	voices: string[];
}

export const ttsEngineSchema = z.object({
	default_voice: z.string(),
	description: z.string(),
	display_name: z.string(),
	id: z.string(),
	installed: z.boolean(),
	languages: z.array(z.string()),
	loaded: z.boolean(),
	sample_rate: z.number(),
	size_mb: z.number(),
	supports_cloning: z.boolean(),
	voices: z.array(z.string()),
	commercial_use: z.boolean().optional(),
	license: z.string().optional(),
	native_speed: z.boolean().optional(),
	paralinguistic_tags: z.array(z.string()).optional(),
	supports_design: z.boolean().optional(),
	supports_instruct: z.boolean().optional(),
	supports_seed: z.boolean().optional(),
});
const ttsEnginesResponseSchema = z.object({
	data: z.array(ttsEngineSchema).default([]),
});

/** List the TTS engines available on this node (nothing hardcoded — Core mirrors
 * the sidecar registry). Always includes the built-in `outetts`. */
export async function listTtsEngines(target: ApiTarget): Promise<TtsEngine[]> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/tts-engines"),
		{
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`tts-engines failed: ${resp.status}`);
	}
	const body = ttsEnginesResponseSchema.parse(await resp.json());
	return body.data ?? [];
}

/** One curated, installable TTS model (voicebox-style), bound to its engine. */
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

export const ttsModelSchema = z.object({
	default: z.boolean(),
	display_name: z.string(),
	engine: z.string(),
	engine_display_name: z.string(),
	hf_repo_id: z.string(),
	installed: z.boolean(),
	languages: z.array(z.string()),
	model_name: z.string(),
	size_mb: z.number(),
});
const ttsModelsResponseSchema = z.object({
	data: z.array(ttsModelSchema).default([]),
});

/** List the curated, installable TTS models (the known-good set Core can install
 * + run), distinct from the raw HF text-to-speech browse in the Models tab. */
export async function listTtsModels(target: ApiTarget): Promise<TtsModel[]> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/tts-models"),
		{
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`tts-models failed: ${resp.status}`);
	}
	const body = ttsModelsResponseSchema.parse(await resp.json());
	return body.data ?? [];
}

/** Download a curated TTS model into Core's HF cache. Resolves when the snapshot
 * is present (idempotent — a cache hit returns immediately). */
export async function installTtsModel(
	target: ApiTarget,
	engine: string,
	modelName: string
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/tts-models/install"),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
			body: JSON.stringify({ engine, model_name: modelName }),
		}
	);
	if (!resp.ok) {
		let detail = `install failed: ${resp.status}`;
		try {
			const body = errorResponseSchema.parse(await resp.json());
			if (body.error) {
				detail = body.error;
			}
		} catch {
			// keep status-based message
		}
		throw new Error(detail);
	}
}

/** Bounds Core enforces on `/api/voice/speak`; hosts validate the same values. */
export const SPEAK_TEXT_MAX_CHARS = 50_000;
export const SPEAK_INSTRUCT_MAX_CHARS = 500;
export const SPEAK_REFERENCE_TEXT_MAX_CHARS = 1000;
export const SPEAK_MAX_EFFECTS = 12;
export const SPEAK_SEED_MAX = 4_294_967_295;
export const SPEAK_EFFECT_TYPES = [
	"gain",
	"highpass",
	"lowpass",
	"compressor",
	"reverb",
	"echo",
	"pitch_shift",
] as const;
export const SPEAK_NORMALIZE_MODES = ["off", "peak", "podcast", "acx"] as const;
export const SPEAK_FORMATS = ["wav", "mp3", "ogg", "flac"] as const;

export type SpeakEffectType = (typeof SPEAK_EFFECT_TYPES)[number];
export type SpeakNormalize = (typeof SPEAK_NORMALIZE_MODES)[number];
export type SpeakFormat = (typeof SPEAK_FORMATS)[number];
/** One post-synthesis effect; `params` are effect-specific finite numbers. */
export interface SpeakEffect {
	params?: Record<string, number>;
	type: SpeakEffectType;
}

/** Options for {@link speakText}. */
export interface SpeakOptions {
	appId?: string;
	appPermission?: string;
	/** Post-synthesis effect chain (sidecar engines only). */
	effects?: SpeakEffect[];
	/** Engine id; omit for the node default (the only case Core may fall back). */
	engine?: string;
	/** Output container; Core returns WAV from engines that cannot encode it. */
	format?: SpeakFormat;
	/** Delivery instruction or voice description for engines that support it. */
	instruct?: string;
	/** Language hint for multilingual engines. */
	language?: string;
	/** Loudness normalization target. */
	normalize?: SpeakNormalize;
	/** Reference wav path/URL for cloning-capable engines. */
	referenceAudio?: string;
	referenceAudioDataUrl?: string;
	/** Transcript of the reference sample. */
	referenceText?: string;
	requestId?: string;
	/** Deterministic sampling seed for engines that accept one. */
	seed?: number;
	/** Speaking-rate multiplier where supported. */
	speed?: number;
	/** Voice id (engine-specific); defaults to the engine's default voice. */
	voice?: string;
}

const SPEECH_AUDIO_MIME: Readonly<Record<string, string>> = {
	"audio/wav": "audio/wav",
	"audio/x-wav": "audio/wav",
	"audio/wave": "audio/wav",
	"audio/mpeg": "audio/mpeg",
	"audio/mp3": "audio/mpeg",
	"audio/ogg": "audio/ogg",
	"audio/flac": "audio/flac",
	"audio/x-flac": "audio/flac",
	// Gateway providers may hand back AAC; it is still a playable container.
	"audio/aac": "audio/aac",
	// Core's Gateway path also serves raw PCM when the provider returns it;
	// keep the type truthful so the caller can decide how to play it.
	"audio/pcm": "audio/pcm",
};

/** Map a speech response `Content-Type` to the MIME a data URL should carry.
 * An absent header is a pre-format node, which only ever served WAV; any other
 * unknown type is refused rather than mislabelled. */
export function speechAudioMime(contentType: string | null): string | null {
	const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (base === "") {
		return "audio/wav";
	}
	return SPEECH_AUDIO_MIME[base] ?? null;
}

/** JSON body for `/api/voice/speak`; unset options stay absent on the wire. */
export function speakRequestBody(text: string, options: SpeakOptions) {
	return {
		text,
		request_id: options.requestId,
		reference_audio_data_url: options.referenceAudioDataUrl,
		engine: options.engine,
		voice: options.voice,
		speed: options.speed,
		language: options.language,
		reference_audio: options.referenceAudio,
		seed: options.seed,
		instruct: options.instruct,
		reference_text: options.referenceText,
		effects: options.effects,
		normalize: options.normalize,
		format: options.format,
	};
}

/** Re-type a speech response blob from its allowlisted `Content-Type`. */
export async function speechResponseBlob(resp: Response): Promise<Blob> {
	const mime = speechAudioMime(resp.headers.get("content-type"));
	if (!mime) {
		throw new Error("speak returned an unsupported audio type");
	}
	const blob = await resp.blob();
	return blob.type === mime ? blob : new Blob([blob], { type: mime });
}

function speechRequestHeaders(target: ApiTarget, options: SpeakOptions) {
	const headers = { ...makeHeaders(target.token, target.userJwt) };
	if (options.appId && options.appPermission) {
		headers["x-ryu-app-id"] = options.appId;
		headers["x-ryu-app-permission"] = options.appPermission;
	}
	return headers;
}

/** Synthesize speech via Core's `/api/voice/speak`, returning a playable audio
 * blob typed with the container Core actually served (WAV unless `format` asked
 * for another one and the engine could encode it). The engine is whatever the
 * caller selects — Core routes built-ins to OuteTTS and everything else to the
 * universal Ryu TTS sidecar. */
export async function speakText(
	target: ApiTarget,
	text: string,
	options: SpeakOptions = {}
): Promise<Blob> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/speak"),
		{
			method: "POST",
			headers: speechRequestHeaders(target, options),
			body: JSON.stringify(speakRequestBody(text, options)),
		}
	);

	if (!resp.ok) {
		let detail = `speak failed: ${resp.status}`;
		try {
			const body = errorResponseSchema.parse(await resp.json());
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

const ttsEngineInstallSchema = z.object({
	engine: z.string(),
	installed: z.literal(true),
	already_installed: z.boolean().default(false),
});

/** Install a registered speech engine, retaining the owning app's attribution. */
export async function installTtsEngine(
	target: ApiTarget,
	engine: string,
	options: { appId?: string; appPermission?: string } = {}
): Promise<z.output<typeof ttsEngineInstallSchema>> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, "/api/voice/tts-engines/install"),
		{
			method: "POST",
			headers: speechRequestHeaders(target, options),
			body: JSON.stringify({ engine }),
		}
	);
	if (!resp.ok) {
		let detail = `TTS engine install failed: ${resp.status}`;
		const body = await resp.json().catch(() => null);
		const parsed = z
			.object({ error: z.string().optional(), detail: z.string().optional() })
			.safeParse(body);
		if (parsed.success) {
			detail =
				[parsed.data.error, parsed.data.detail].filter(Boolean).join(": ") ||
				detail;
		}
		throw new Error(detail);
	}
	const parsed = ttsEngineInstallSchema.safeParse(await resp.json());
	if (!parsed.success || parsed.data.engine !== engine) {
		throw new Error("Core did not confirm the speech engine install.");
	}
	return parsed.data;
}
