// useIslandChat: the renderer-side chat state machine for the expanded island.
//
// It drives Core's real agent path via the `window.island.core.chatStream` IPC
// (started in U2). The main process owns the HTTP/SSE connection; this hook only
// sends a request, accumulates `text-delta` parts into the streaming assistant
// message, and aborts on demand. The conversation_id is generated once per app
// session and reused so the thread continues in Core's conversation store.
//
// Agent routing: the chat routes to the configured `island-agents.voiceAgent`
// (default the flagship `ryu`; empty = Core's default local model). enable_long_term
// is false (privacy by default). The companion_source flag marks the turn as
// island-originated for Gateway DLP. When `island-tts` is enabled, each finished
// assistant reply is spoken aloud through Core's `/api/voice/speak`.

import { useCallback, useEffect, useRef, useState } from "react";
import {
	agentIdOrUndefined,
	DEFAULT_ISLAND_AGENT_PREFS,
	parseIslandAgentPrefs,
} from "../../../shared/agents.ts";
import type {
	CoreFilePart,
	CoreStreamEndEvent,
	CoreStreamPartEvent,
	IslandAttachment,
	IslandMeetingEvent,
	ShadowContext,
} from "../../../shared/ipc.ts";
import {
	DEFAULT_ISLAND_TTS_PREFS,
	type IslandTtsPrefs,
	parseIslandTtsPrefs,
} from "../../../shared/tts.ts";

export interface ChatMessage {
	content: string;
	id: string;
	role: "assistant" | "user";
	/** True while the assistant message is still streaming tokens. */
	streaming?: boolean;
}

export interface IslandChatState {
	/** Inline error when Core is unreachable or the stream fails. */
	error: string | null;
	messages: ChatMessage[];
	/**
	 * Out-of-band notes from Core's server-side turn-hooks (goal/proof/double-check),
	 * streamed as `data-plugin_note` frames. Surfaced apart from the transcript so
	 * they never read as assistant replies. Reset at the start of each turn.
	 */
	notes: string[];
	/** True between send and the terminal stream-end event. */
	sending: boolean;
}

/** The plugin flag key Core's double-check turn-hook reads on the request body. */
const DOUBLE_CHECK_FLAG = "io.ryu.double-check";
/** The SSE part type carrying a turn-hook note. */
const PLUGIN_NOTE_PART = "data-plugin_note";

const OCR_LIMIT = 1200;

// Compose the screen-grounding preamble from the current Shadow context. Mirrors
// the desktop ask-screen intent: app, window title, and a truncated OCR sample.
function buildScreenPreamble(ctx: ShadowContext): string {
	const app = ctx.app_name ?? "the current window";
	const title = ctx.window_title ? ` titled "${ctx.window_title}"` : "";
	const selection = ctx.selected_text?.trim();
	const ocr = ctx.ocr_text?.trim();
	let body = "No readable text was captured from the screen.";
	if (selection) {
		body = `Selected text:\n${selection}`;
	} else if (ocr) {
		body = `Visible text on screen:\n${ocr.slice(0, OCR_LIMIT)}`;
	}
	return `Context from my screen (${app}${title}):\n${body}\n\n`;
}

let sessionConversationId: string | null = null;

// Reuse one conversation id for the whole app session so the Core thread
// continues across sends. Lazily created on first use.
function getConversationId(): string {
	if (!sessionConversationId) {
		sessionConversationId = `island-${crypto.randomUUID()}`;
	}
	return sessionConversationId;
}

export function useIslandChat(options?: {
	getAcpPayload?: () => {
		acp_config?: Record<string, string>;
		acp_mode?: string;
		acp_model?: string;
	};
	/** Read the current double-check toggle when a turn is sent (kept via ref). */
	getDoubleCheck?: () => boolean;
}) {
	const getAcpPayloadRef = useRef(options?.getAcpPayload);
	getAcpPayloadRef.current = options?.getAcpPayload;
	const getDoubleCheckRef = useRef(options?.getDoubleCheck);
	getDoubleCheckRef.current = options?.getDoubleCheck;
	const [state, setState] = useState<IslandChatState>({
		messages: [],
		sending: false,
		error: null,
		notes: [],
	});

	// The id of the assistant message currently receiving tokens, and the active
	// stream id used to route part events and aborts.
	const activeAssistantId = useRef<string | null>(null);
	const activeStreamId = useRef<string | null>(null);
	// Accumulated text of the in-flight assistant reply, so the terminal event can
	// hand the full reply to text-to-speech without re-reading React state.
	const assistantTextRef = useRef("");

	// Agent + TTS routing, kept current from Core prefs (read once on mount, then
	// updated live via SSE). Refs (not state) because the stream handlers read them
	// without needing to re-render.
	const voiceAgentRef = useRef(DEFAULT_ISLAND_AGENT_PREFS.voiceAgent);
	const ttsPrefsRef = useRef<IslandTtsPrefs>(DEFAULT_ISLAND_TTS_PREFS);
	/** Meeting ids currently recording — suppresses read-back while non-empty. */
	const meetingRecordingIdsRef = useRef<Set<string>>(new Set());
	// The audio element currently speaking a reply, so a new reply (or stop())
	// can interrupt it.
	const playingAudio = useRef<HTMLAudioElement | null>(null);

	useEffect(() => {
		window.island.agents
			.get()
			.then((raw) => {
				voiceAgentRef.current = parseIslandAgentPrefs(raw).voiceAgent;
			})
			.catch(() => undefined);
		window.island.tts
			.get()
			.then((raw) => {
				ttsPrefsRef.current = parseIslandTtsPrefs(raw);
			})
			.catch(() => undefined);
		const offAgents = window.island.agents.onChanged((value) => {
			voiceAgentRef.current = parseIslandAgentPrefs(value).voiceAgent;
		});
		const offTts = window.island.tts.onChanged((value) => {
			ttsPrefsRef.current = parseIslandTtsPrefs(value);
		});
		const offMeetings = window.island.meetings?.onEvent(
			(event: IslandMeetingEvent) => {
				const ids = meetingRecordingIdsRef.current;
				switch (event.type) {
					case "started":
						if (event.meeting.status === "recording") {
							ids.add(event.meeting.id);
						} else {
							ids.delete(event.meeting.id);
						}
						break;
					case "status":
						if (event.status === "recording") {
							ids.add(event.meeting_id);
						} else {
							ids.delete(event.meeting_id);
						}
						break;
					case "finalized":
						ids.delete(event.meeting.id);
						break;
					default:
						break;
				}
			}
		);
		return () => {
			offAgents();
			offTts();
			offMeetings?.();
		};
	}, []);

	// Stop any reply currently being spoken (new reply starting, or user stop()).
	const stopSpeaking = useCallback((): void => {
		const audio = playingAudio.current;
		if (audio) {
			audio.pause();
			playingAudio.current = null;
		}
	}, []);

	// Speak a finished assistant reply through Core, when TTS is enabled. Best
	// effort: a synthesis failure (e.g. engine not installed) is swallowed so it
	// never disrupts the chat.
	const speakReply = useCallback(
		async (text: string): Promise<void> => {
			const prefs = ttsPrefsRef.current;
			const trimmed = text.trim();
			if (
				!prefs.enabled ||
				trimmed.length === 0 ||
				meetingRecordingIdsRef.current.size > 0
			) {
				return;
			}
			const result = await window.island.tts.speak({
				text: trimmed,
				engine: prefs.engine,
				voice: prefs.voice || undefined,
			});
			if (!result.available) {
				return;
			}
			stopSpeaking();
			const blob = new Blob([result.audio], { type: result.mime });
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			playingAudio.current = audio;
			audio.addEventListener("ended", () => {
				URL.revokeObjectURL(url);
				if (playingAudio.current === audio) {
					playingAudio.current = null;
				}
			});
			try {
				await audio.play();
			} catch {
				// Autoplay/playback rejected: drop it, never disrupt the chat.
				URL.revokeObjectURL(url);
			}
		},
		[stopSpeaking]
	);

	// Subscribe once to the streamed-part and stream-end events. The handlers
	// append deltas to the in-flight assistant message and finalize on end.
	useEffect(() => {
		const onPart = (event: CoreStreamPartEvent): void => {
			if (event.streamId !== activeStreamId.current) {
				return;
			}
			const { part } = event;
			if (part.type === "text-delta" && typeof part.delta === "string") {
				const delta = part.delta;
				assistantTextRef.current += delta;
				setState((prev) => ({
					...prev,
					messages: prev.messages.map((message) =>
						message.id === activeAssistantId.current
							? { ...message, content: message.content + delta }
							: message
					),
				}));
			} else if (part.type === "error" && typeof part.errorText === "string") {
				const errorText = part.errorText;
				setState((prev) => ({ ...prev, error: errorText }));
			} else if (part.type === PLUGIN_NOTE_PART) {
				// A turn-hook note (goal/proof/double-check). OtherPart's index
				// signature pollutes union narrowing, so read `data.text` defensively.
				const data = (part as { data?: { text?: unknown } }).data;
				const noteText = typeof data?.text === "string" ? data.text.trim() : "";
				if (noteText.length > 0) {
					setState((prev) => ({ ...prev, notes: [...prev.notes, noteText] }));
				}
			}
		};

		const onEnd = (event: CoreStreamEndEvent): void => {
			if (event.streamId !== activeStreamId.current) {
				return;
			}
			const reason = event.reason;
			const endError = event.error ?? null;
			const finishedText = assistantTextRef.current;
			setState((prev) => ({
				...prev,
				sending: false,
				error: reason === "error" ? (endError ?? "Stream failed.") : prev.error,
				messages: prev.messages.map((message) =>
					message.id === activeAssistantId.current
						? { ...message, streaming: false }
						: message
				),
			}));
			activeAssistantId.current = null;
			activeStreamId.current = null;
			// Speak the completed reply (no-op unless TTS is enabled). Only on a
			// clean finish — not on abort or error.
			if (reason === "done") {
				speakReply(finishedText).catch(() => undefined);
			}
		};

		const offPart = window.island.core.onStreamPart(onPart);
		const offEnd = window.island.core.onStreamEnd(onEnd);
		return () => {
			offPart();
			offEnd();
		};
	}, [speakReply]);

	const send = useCallback(
		async (
			text: string,
			options?: { withScreen?: boolean; attachments?: IslandAttachment[] }
		): Promise<void> => {
			const trimmed = text.trim();
			const attachments = options?.attachments ?? [];
			// A bare attachment with no caption is still a valid turn ("describe this
			// image"), so allow an empty draft when images are attached.
			if (
				(trimmed.length === 0 && attachments.length === 0) ||
				activeStreamId.current !== null
			) {
				return;
			}

			let outgoing = trimmed;
			if (options?.withScreen) {
				const result = await window.island.shadow.getCurrentContext();
				if (result.available) {
					outgoing = buildScreenPreamble(result.context) + trimmed;
				}
			}

			// Map staged images to AI SDK v6 file-parts; Core forwards them to the
			// model as `image_url` content. Only attached to this single turn.
			const fileParts: CoreFilePart[] = attachments.map((a) => ({
				type: "file",
				mediaType: a.mimeType,
				filename: a.name,
				url: a.dataUrl,
			}));

			// An image-only turn has no caption; show the file names in the bubble so
			// the user message is never an empty row.
			const displayText =
				trimmed.length > 0
					? trimmed
					: attachments.map((a) => a.name).join(", ");
			const userMessage: ChatMessage = {
				id: crypto.randomUUID(),
				role: "user",
				content: displayText,
			};
			const assistantMessage: ChatMessage = {
				id: crypto.randomUUID(),
				role: "assistant",
				content: "",
				streaming: true,
			};
			activeAssistantId.current = assistantMessage.id;
			assistantTextRef.current = "";

			// Build the Core message history from prior turns plus this one. The
			// outgoing user content may carry the screen preamble; the displayed
			// bubble keeps the clean text.
			const history = state.messages.map((message) => ({
				role: message.role,
				content: message.content,
			}));

			setState((prev) => ({
				...prev,
				error: null,
				sending: true,
				// Fresh turn: drop any notes from the previous answer.
				notes: [],
				messages: [...prev.messages, userMessage, assistantMessage],
			}));

			try {
				const handle = await window.island.core.chatStream({
					agent_id: agentIdOrUndefined(voiceAgentRef.current),
					conversation_id: getConversationId(),
					enable_long_term: false,
					companion_source: true,
					plugin_flags: {
						[DOUBLE_CHECK_FLAG]: getDoubleCheckRef.current?.() ?? false,
					},
					...getAcpPayloadRef.current?.(),
					messages: [
						...history,
						{
							role: "user",
							content: outgoing,
							...(fileParts.length > 0 ? { parts: fileParts } : {}),
						},
					],
				});
				activeStreamId.current = handle.streamId;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activeAssistantId.current = null;
				setState((prev) => ({
					...prev,
					sending: false,
					error: `Could not reach Core: ${message}`,
					messages: prev.messages.filter(
						(item) => item.id !== assistantMessage.id
					),
				}));
			}
		},
		[state.messages]
	);

	const stop = useCallback((): void => {
		stopSpeaking();
		const streamId = activeStreamId.current;
		if (streamId) {
			window.island.core.abortStream(streamId).catch(() => {
				// Aborting a stream that already finished is a no-op; ignore.
			});
		}
	}, [stopSpeaking]);

	// Dismiss the surfaced turn-hook notes (the banner's ✕).
	const clearNotes = useCallback((): void => {
		setState((prev) => ({ ...prev, notes: [] }));
	}, []);

	return { ...state, send, stop, clearNotes };
}
