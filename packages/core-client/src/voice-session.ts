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
// Browsers can't set headers on a WS upgrade, so this client exchanges its HTTP
// credentials for a short-lived, one-use ticket. Only that opaque ticket rides
// the upgrade URL. Uses the global `WebSocket` + Web Audio (present in both
// renderer surfaces).

import {
	parseVoiceServerMsg,
	type RvpCallEnded,
	type VoiceClientMsg,
	type VoiceServerMsg,
	type VoiceState,
	voiceServerMsgSchema,
} from "@ryuhq/protocol/voice";
import { z } from "zod";
import {
	type ApiTarget,
	apiUrl,
	appendWebSocketTicket,
	requestWebSocketTicket,
} from "./client.ts";
import { startVoiceRingback } from "./voice-ringback.ts";

/** Rate the server's VAD + STT expect; the client resamples the mic to this. */
const TARGET_SAMPLE_RATE = 16_000;
/** ScriptProcessor buffer size (frames). 4096 ≈ 85 ms @ 48 kHz — low latency. */
const CAPTURE_BUFFER_SIZE = 4096;
/** Visual gain applied to the mic RMS before it reaches the UI (0..1). */
const AUDIO_LEVEL_GAIN = 5;
/** `WebSocket.OPEN`. */
const WEBSOCKET_OPEN = 1;

/** Lifecycle + per-frame callbacks. All optional. */
export interface VoiceSessionHandlers {
	/** Normalized mic RMS level for the current capture frame (0..1). */
	onAudioLevel?: (level: number) => void;
	/** Core saved the user-side call summary. */
	onCallEnded?: (summary: RvpCallEnded) => void;
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
	/** Core accepted the call. */
	onReady?: () => void;
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
	/** STT engine hint (`"whisper"` | `"audiocpp"` | `"parakeet"`). */
	sttEngine?: string;
	/** TTS engine hint (`"outetts"` | a RyuTTS engine id). */
	ttsEngine?: string;
	/** TTS voice id (engine-specific). */
	ttsVoice?: string;
}

/** Build the credential-free `ws(s)://…/api/voice/ws` URL from a node target. */
export function voiceWsUrl(target: ApiTarget, _jwt?: string | null): string {
	const url = new URL(apiUrl(target, "/api/voice/ws"));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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

/** Convert one mono Float32 frame into a visual-friendly normalized RMS level. */
function audioLevel(samples: Float32Array): number {
	let sumSquares = 0;
	for (const sample of samples) {
		sumSquares += sample * sample;
	}
	const rms = Math.sqrt(sumSquares / (samples.length || 1));
	return Math.min(1, rms * AUDIO_LEVEL_GAIN);
}

/**
 * One voice-mode session over a single WebSocket. Construct with a node target +
 * options, then {@link start}; {@link close} tears everything down. Reconnection
 * is left to the caller (a surface knows when the node is reachable), keeping this
 * a thin, honest mapping over one socket + the mic/playback graph.
 */
export class VoiceSessionConnection {
	private socket: WebSocket | null = null;
	private readonly target: ApiTarget;
	private readonly url: string;
	private readonly options: VoiceSessionOptions;

	// Capture graph.
	private mic: MediaStream | null = null;
	private audioCtx: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private processor: ScriptProcessorNode | null = null;
	private muted = false;
	private closed = false;
	private ending = false;
	private summaryReceived = false;
	private stopRingback: (() => void) | null = null;
	private endTimer: ReturnType<typeof setTimeout> | null = null;

	// Playback queue (sequential WAV sentences).
	private playbackCtx: AudioContext | null = null;
	private nextStartTime = 0;
	private readonly playing = new Set<AudioBufferSourceNode>();

	constructor(target: ApiTarget, options: VoiceSessionOptions = {}) {
		this.target =
			options.jwt === undefined ? target : { ...target, userJwt: options.jwt };
		this.options = options;
		this.url = voiceWsUrl(target, options.jwt);
	}

	/** Open the socket + mic and begin streaming. Rejects if mic access fails. */
	async start(): Promise<void> {
		if (this.socket) {
			return;
		}
		this.muted = false;
		if (this.closed) {
			return;
		}
		this.stopRingback = startVoiceRingback();
		// Acquire the mic first — with AEC/NS/AGC so the assistant's own TTS output
		// doesn't feed back into the mic and cause false barge-in.
		let mic: MediaStream;
		try {
			mic = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
		} catch (error) {
			this.stopRinging();
			throw error;
		}
		if (this.closed) {
			for (const track of mic.getTracks()) {
				track.stop();
			}
			return;
		}
		this.mic = mic;

		let ticket: string;
		try {
			ticket = await requestWebSocketTicket(this.target, {
				roomId: this.options.conversationId,
				route: "voice",
			});
		} catch (error) {
			this.stopRinging();
			this.teardownAudio();
			throw error;
		}
		if (this.closed) {
			return;
		}

		const socket = new WebSocket(appendWebSocketTicket(this.url, ticket));
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		const { handlers } = this.options;

		socket.onopen = () => {
			this.sendStart();
			handlers?.onOpen?.();
		};
		socket.onmessage = (event) => this.dispatch(event);
		socket.onclose = () => {
			this.closed = true;
			this.socket = null;
			this.stopRinging();
			if (this.endTimer) {
				clearTimeout(this.endTimer);
			}
			this.stopPlayback();
			this.teardownAudio();
			handlers?.onClose?.();
		};
		socket.onerror = () => {
			this.stopRinging();
			// Hanging up a still-connecting socket closes it at once, and that
			// close fires `error` by spec: not a transport failure to surface.
			// A failure after hanging up an open call (while waiting for the
			// summary) is still reported, like a server `error` frame then.
			if (this.closed) {
				return;
			}
			handlers?.onError?.("socket", "voice socket error");
			this.close();
		};
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

	/** Pause microphone frames without ending the voice session or playback. */
	setMuted(muted: boolean): void {
		this.muted = muted;
		if (muted) {
			this.options.handlers?.onAudioLevel?.(0);
		}
	}

	/** Close the socket and tear down the mic + playback graph. */
	close(): void {
		if (this.closed || this.ending) {
			return;
		}
		this.ending = true;
		this.stopRinging();
		this.stopPlayback();
		this.teardownAudio();
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.sendJson({ type: "end" });
			// Older nodes may not understand `end`; release the socket regardless.
			this.endTimer = setTimeout(() => this.socket?.close(), 5000);
			return;
		}
		this.closed = true;
		this.socket?.close();
		this.socket = null;
	}

	private stopRinging(): void {
		this.stopRingback?.();
		this.stopRingback = null;
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
			if (this.muted) {
				this.options.handlers?.onAudioLevel?.(0);
				return;
			}
			this.options.handlers?.onAudioLevel?.(audioLevel(input));
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
		this.muted = false;
	}

	// ── Downlink: control + audio ─────────────────────────────────────────────

	private dispatch(event: MessageEvent): void {
		if (event.data instanceof ArrayBuffer) {
			if (this.ending || this.closed) {
				return;
			}
			this.enqueueAudio(event.data);
			return;
		}
		const controlFrame = z.string().safeParse(event.data);
		if (controlFrame.success) {
			const supported = voiceServerMsgSchema.safeParse(
				parseVoiceServerMsg(controlFrame.data)
			);
			if (supported.success) {
				this.dispatchControl(supported.data);
			}
		}
	}

	private dispatchControl(msg: VoiceServerMsg): void {
		const h = this.options.handlers;
		if (this.ending && msg.type !== "call_ended" && msg.type !== "error") {
			return;
		}
		switch (msg.type) {
			case "ready":
				this.stopRinging();
				if (!this.ending) {
					this.startCapture();
					h?.onReady?.();
					h?.onState?.("idle");
				}
				break;
			case "call_ended":
				if (this.summaryReceived) {
					return;
				}
				this.summaryReceived = true;
				this.stopRinging();
				h?.onCallEnded?.(msg);
				this.socket?.close();
				break;
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
				this.stopRinging();
				h?.onError?.(msg.code, msg.message);
				if (this.ending) {
					this.socket?.close();
				}
				break;
			default:
				// tts_start / tts_end / pong — no client action needed.
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
				if (this.ending || this.closed) {
					return;
				}
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
		if (
			this.playbackCtx &&
			this.playbackCtx.state !== "closed" &&
			(this.ending || this.closed)
		) {
			this.playbackCtx.close().catch(() => undefined);
			this.playbackCtx = null;
		}
	}

	private sendJson(payload: VoiceClientMsg): void {
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.socket.send(JSON.stringify(payload));
		}
	}
}
