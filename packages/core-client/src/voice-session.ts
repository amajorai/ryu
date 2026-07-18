/// <reference lib="dom" />
// packages/core-client/src/voice-session.ts
//
// Shared client for Core's realtime voice mode (`GET /api/voice/ws`) — the
// ChatGPT-style continuous voice loop. One transport for every renderer surface
// (desktop Tauri webview, island Electron renderer): capture mic → stream 16 kHz
// PCM16 up, receive control frames + WAV audio down, play it, and stop instantly
// on a server barge-in. All the intelligence (VAD, endpointing, turn-taking) is
// server-side; this client is a thin audio pipe. Wire contract:
//
//   Client -> server (FIRST frame MUST be `start`):
//     - start:  text `{ type:"start", sample_rate, conversation_id?, ... }`
//     - audio:  BINARY little-endian PCM16 mono @ `sample_rate` (streamed live)
//     - text:   text `{ type:"text", content }`   (typed fallback)
//     - abort:  text `{ type:"abort" }`           (manual stop/interrupt)
//
//   Server -> client:
//     - control: text `VoiceServerMsg` (ready/state/stt/chat_delta/stop_playback/…)
//     - audio:   BINARY WAV, one frame per synthesized sentence
//
// Browsers can't set headers on a WS upgrade, so the node token rides `?token=`.
// Uses the global `WebSocket` + Web Audio (present in both renderer surfaces).

import {
	parseVoiceServerMsg,
	type VoiceServerMsg,
	type VoiceState,
} from "@ryuhq/protocol/voice";
import { type ApiTarget, apiUrl } from "./client.ts";

/** Rate the server's VAD + STT expect; the client resamples the mic to this. */
const TARGET_SAMPLE_RATE = 16_000;
/** ScriptProcessor buffer size (frames). 4096 ≈ 85 ms @ 48 kHz — low latency. */
const CAPTURE_BUFFER_SIZE = 4096;
/** `WebSocket.OPEN`. */
const WEBSOCKET_OPEN = 1;

/** Lifecycle + per-frame callbacks. All optional. */
export interface VoiceSessionHandlers {
	/** Assistant turn ended. */
	onChatEnd?: (conversationId: string) => void;
	/** Socket closed. */
	onClose?: () => void;
	/** One streamed assistant-text chunk (live captions). */
	onDelta?: (text: string) => void;
	/** A protocol/processing error frame. */
	onError?: (code: string, message: string) => void;
	/** Socket opened + session started. */
	onOpen?: () => void;
	/** VAD detected the user's speech onset. */
	onSpeechStart?: () => void;
	/** Turn-phase change (idle/listening/thinking/speaking) for the UI. */
	onState?: (state: VoiceState) => void;
	/** The user's live/partial or final transcript. */
	onTranscript?: (text: string, final: boolean) => void;
}

export interface VoiceSessionOptions {
	/** Route turns through a specific agent/persona. */
	agentId?: string;
	/** Bind turns to an existing conversation, or omit for an ephemeral session. */
	conversationId?: string;
	handlers?: VoiceSessionHandlers;
	/** The user-identity JWT (Better Auth). Omit for the local user. */
	jwt?: string | null;
	/** STT engine hint (`"whisper"` default | `"parakeet"`). */
	sttEngine?: string;
	/** TTS engine hint (`"outetts"` | a RyuTTS engine id). */
	ttsEngine?: string;
	/** TTS voice id (engine-specific). */
	ttsVoice?: string;
}

/** Build the `ws(s)://…/api/voice/ws?token=&jwt=` URL from a node target. */
export function voiceWsUrl(target: ApiTarget, jwt?: string | null): string {
	const url = new URL(apiUrl(target, "/api/voice/ws"));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	if (target.token) {
		url.searchParams.set("token", target.token);
	}
	if (jwt) {
		url.searchParams.set("jwt", jwt);
	}
	return url.toString();
}

/** Downsample mono Float32 PCM to the target rate (linear interpolation). */
function downsample(
	input: Float32Array,
	inRate: number,
	outRate: number
): Float32Array {
	if (outRate >= inRate) {
		return input;
	}
	const ratio = inRate / outRate;
	const outLength = Math.floor(input.length / ratio);
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = input[idx] ?? 0;
		const b = input[idx + 1] ?? a;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

/** Convert mono Float32 (−1..1) to little-endian PCM16 bytes. */
function floatToPcm16(samples: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(samples.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(i * 2, s < 0 ? s * 0x80_00 : s * 0x7f_ff, true);
	}
	return buffer;
}

/**
 * One voice-mode session over a single WebSocket. Construct with a node target +
 * options, then {@link start}; {@link close} tears everything down. Reconnection
 * is left to the caller (a surface knows when the node is reachable), keeping this
 * a thin, honest mapping over one socket + the mic/playback graph.
 */
export class VoiceSessionConnection {
	private socket: WebSocket | null = null;
	private readonly url: string;
	private readonly options: VoiceSessionOptions;

	// Capture graph.
	private mic: MediaStream | null = null;
	private audioCtx: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private processor: ScriptProcessorNode | null = null;

	// Playback queue (sequential WAV sentences).
	private playbackCtx: AudioContext | null = null;
	private nextStartTime = 0;
	private readonly playing = new Set<AudioBufferSourceNode>();

	constructor(target: ApiTarget, options: VoiceSessionOptions = {}) {
		this.options = options;
		this.url = voiceWsUrl(target, options.jwt);
	}

	/** Open the socket + mic and begin streaming. Rejects if mic access fails. */
	async start(): Promise<void> {
		if (this.socket) {
			return;
		}
		// Acquire the mic first — with AEC/NS/AGC so the assistant's own TTS output
		// doesn't feed back into the mic and cause false barge-in.
		this.mic = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});

		const socket = new WebSocket(this.url);
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		const { handlers } = this.options;

		socket.onopen = () => {
			this.sendStart();
			this.startCapture();
			handlers?.onOpen?.();
		};
		socket.onmessage = (event) => this.dispatch(event);
		socket.onclose = () => {
			this.teardownAudio();
			handlers?.onClose?.();
		};
		socket.onerror = () => handlers?.onError?.("socket", "voice socket error");
	}

	/** Send a typed message (fallback path; runs a turn without STT). */
	sendText(content: string): void {
		this.sendJson({ type: "text", content });
	}

	/** Manual barge-in / stop: abort the in-flight reply + drop local playback. */
	abort(): void {
		this.stopPlayback();
		this.sendJson({ type: "abort" });
	}

	/** Close the socket and tear down the mic + playback graph. */
	close(): void {
		this.stopPlayback();
		this.teardownAudio();
		this.socket?.close();
		this.socket = null;
	}

	// ── Uplink: mic capture ──────────────────────────────────────────────────

	private sendStart(): void {
		const o = this.options;
		this.sendJson({
			type: "start",
			sample_rate: TARGET_SAMPLE_RATE,
			conversation_id: o.conversationId,
			agent_id: o.agentId,
			stt_engine: o.sttEngine,
			tts_engine: o.ttsEngine,
			tts_voice: o.ttsVoice,
		});
	}

	private startCapture(): void {
		if (!this.mic) {
			return;
		}
		const ctx = new AudioContext();
		this.audioCtx = ctx;
		const source = ctx.createMediaStreamSource(this.mic);
		this.source = source;
		const processor = ctx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
		this.processor = processor;

		processor.onaudioprocess = (e) => {
			const input = e.inputBuffer.getChannelData(0);
			// We already advertised 16 kHz in `start`, so resample to that.
			const pcm = downsample(input, ctx.sampleRate, TARGET_SAMPLE_RATE);
			if (this.socket?.readyState === WEBSOCKET_OPEN) {
				this.socket.send(floatToPcm16(pcm));
			}
		};

		source.connect(processor);
		// A ScriptProcessor only fires when connected to a destination. It writes no
		// output, so nothing is played back through it (no echo).
		processor.connect(ctx.destination);
	}

	private teardownAudio(): void {
		this.processor?.disconnect();
		this.source?.disconnect();
		this.processor = null;
		this.source = null;
		for (const track of this.mic?.getTracks() ?? []) {
			track.stop();
		}
		this.mic = null;
		if (this.audioCtx && this.audioCtx.state !== "closed") {
			this.audioCtx.close().catch(() => {
				// Context already closing/closed — nothing to do.
			});
		}
		this.audioCtx = null;
	}

	// ── Downlink: control + audio ─────────────────────────────────────────────

	private dispatch(event: MessageEvent): void {
		if (event.data instanceof ArrayBuffer) {
			this.enqueueAudio(event.data);
			return;
		}
		if (typeof event.data === "string") {
			const msg = parseVoiceServerMsg(event.data);
			if (msg) {
				this.dispatchControl(msg);
			}
		}
	}

	private dispatchControl(msg: VoiceServerMsg): void {
		const h = this.options.handlers;
		switch (msg.type) {
			case "state":
				h?.onState?.(msg.value);
				break;
			case "speech_start":
				h?.onSpeechStart?.();
				break;
			case "stt":
				h?.onTranscript?.(msg.text, msg.final);
				break;
			case "chat_delta":
				h?.onDelta?.(msg.text);
				break;
			case "chat_end":
				h?.onChatEnd?.(msg.conversation_id);
				break;
			case "stop_playback":
				// Barge-in: the server killed the turn; drop what we're playing NOW.
				this.stopPlayback();
				break;
			case "error":
				h?.onError?.(msg.code, msg.message);
				break;
			default:
				// ready / tts_start / tts_end / pong — no client action needed.
				break;
		}
	}

	/** Decode one WAV sentence and schedule it to play after the queued audio. */
	private enqueueAudio(wav: ArrayBuffer): void {
		if (!this.playbackCtx) {
			this.playbackCtx = new AudioContext();
		}
		const ctx = this.playbackCtx;
		// `decodeAudioData` detaches its input, so hand it a private copy.
		ctx.decodeAudioData(wav.slice(0)).then(
			(buffer) => {
				const src = ctx.createBufferSource();
				src.buffer = buffer;
				src.connect(ctx.destination);
				const now = ctx.currentTime;
				const startAt = Math.max(now, this.nextStartTime);
				src.start(startAt);
				this.nextStartTime = startAt + buffer.duration;
				this.playing.add(src);
				src.onended = () => this.playing.delete(src);
			},
			() => {
				// A malformed/partial WAV frame is dropped; the next sentence recovers.
			}
		);
	}

	/** Stop + flush all queued/playing audio (barge-in). */
	private stopPlayback(): void {
		for (const src of this.playing) {
			try {
				src.stop();
			} catch {
				// Already stopped/ended — ignore.
			}
		}
		this.playing.clear();
		this.nextStartTime = 0;
	}

	private sendJson(payload: unknown): void {
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.socket.send(JSON.stringify(payload));
		}
	}
}
