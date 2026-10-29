// useIslandChat: the expanded island's chat state, running on the SAME chat
// runtime as the desktop app.
//
// It drives the AI SDK `useChat` over `createIslandChatTransport`, which bridges
// Core's SSE (owned by the main process — the renderer is cross-origin to Core)
// into a `ReadableStream<UIMessageChunk>`. The hook therefore holds real
// `UIMessage[]` with full `parts`, not accumulated text, which is what lets the
// island render the desktop message list verbatim: tool rows, MCP widgets,
// generated images, reasoning and citations all arrive as parts.
//
// The conversation_id is generated once per app session and reused so the thread
// continues in Core's conversation store.
//
// Agent routing: the chat routes to the configured `island-agents.voiceAgent`
// (default the flagship `ryu`; empty = Core's default local model). enable_long_term
// is false (privacy by default). The companion_source flag marks the turn as
// island-originated for Gateway DLP. When `island-tts` is enabled, each finished
// assistant reply is spoken aloud through Core's `/api/voice/speak`.

import { useChat } from "@ai-sdk/react";
import {
	latestPluginNote,
	latestStreamedAcpConfig,
	latestStreamedAcpMode,
} from "@ryu/blocks/composer/streamed-parts";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	agentIdOrUndefined,
	DEFAULT_ISLAND_AGENT_PREFS,
	parseIslandAgentPrefs,
} from "../../../shared/agents.ts";
import type {
	CoreFilePart,
	IslandAttachment,
	IslandMeetingEvent,
	ShadowContext,
} from "../../../shared/ipc.ts";
import {
	DEFAULT_ISLAND_TTS_PREFS,
	type IslandTtsPrefs,
	parseIslandTtsPrefs,
} from "../../../shared/tts.ts";
import { createIslandChatTransport } from "../../lib/island-chat-transport.ts";

/** The plugin flag key Core's double-check turn-hook reads on the request body. */
const DOUBLE_CHECK_FLAG = "io.ryu.double-check";

/**
 * Tells Core this surface shows generative UI as one live screen, so the model is
 * told to render (and re-render) whole compact screens with `ui.render`.
 */
const GENERATIVE_UI_FLAG = "io.ryu.generative-ui";

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

/** Concatenate an assistant message's text parts (for read-back). */
function textOf(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export function useIslandChat(options?: {
	getAcpPayload?: () => {
		acp_config?: Record<string, string>;
		acp_mode?: string;
		acp_model?: string;
	};
	/** Read the current double-check toggle when a turn is sent (kept via ref). */
	getDoubleCheck?: () => boolean;
	/**
	 * An agent-requested session-config write-back arrived on the stream. `key` is
	 * this emission's identity, so the composer can dedupe on the PART rather than
	 * the value — an agent re-emits the byte-identical map every cycle and each
	 * emission must land.
	 */
	onAcpConfig?: (config: Record<string, string>, key: string) => void;
	/** An agent-initiated permission-mode switch arrived on the stream. */
	onAcpMode?: (modeId: string) => void;
}) {
	const getAcpPayloadRef = useRef(options?.getAcpPayload);
	getAcpPayloadRef.current = options?.getAcpPayload;
	const getDoubleCheckRef = useRef(options?.getDoubleCheck);
	getDoubleCheckRef.current = options?.getDoubleCheck;
	// Refs, not deps: the transport is created once, and these callbacks are
	// re-created by the composer on every render.
	const onAcpConfigRef = useRef(options?.onAcpConfig);
	onAcpConfigRef.current = options?.onAcpConfig;
	const onAcpModeRef = useRef(options?.onAcpMode);
	onAcpModeRef.current = options?.onAcpMode;

	// Agent + TTS routing, kept current from Core prefs (read once on mount, then
	// updated live via SSE). Refs (not state) because the send path reads them
	// without needing to re-render.
	const voiceAgentRef = useRef(DEFAULT_ISLAND_AGENT_PREFS.voiceAgent);
	const ttsPrefsRef = useRef<IslandTtsPrefs>(DEFAULT_ISLAND_TTS_PREFS);
	/** Meeting ids currently recording — suppresses read-back while non-empty. */
	const meetingRecordingIdsRef = useRef<Set<string>>(new Set());
	// The audio element currently speaking a reply, so a new reply (or stop())
	// can interrupt it.
	const playingAudio = useRef<HTMLAudioElement | null>(null);

	// Server-only text per user message id: the screen-grounding preamble goes to
	// the model, the transcript bubble keeps the clean text the user typed.
	const serverTextRef = useRef<Map<string, string>>(new Map());

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
	const speakReplyRef = useRef(speakReply);
	speakReplyRef.current = speakReply;

	// One transport for the session. Every per-turn field is read through a getter
	// at send time, so a picker changed between turns takes effect on the next one
	// without re-creating the chat.
	const transport = useMemo(
		() =>
			createIslandChatTransport({
				getRequest: () => ({
					agent_id: agentIdOrUndefined(voiceAgentRef.current),
					conversation_id: getConversationId(),
					enable_long_term: false,
					companion_source: true,
					plugin_flags: {
						[DOUBLE_CHECK_FLAG]: getDoubleCheckRef.current?.() ?? false,
						[GENERATIVE_UI_FLAG]: true,
					},
					...getAcpPayloadRef.current?.(),
				}),
				serverTextFor: (messageId) => serverTextRef.current.get(messageId),
			}),
		[]
	);

	const {
		messages,
		sendMessage,
		status,
		error,
		stop: stopChat,
	} = useChat({
		id: getConversationId(),
		transport,
		onFinish: ({ message, isAbort, isError }) => {
			// Speak the completed reply (no-op unless TTS is enabled). Only on a
			// clean finish — not on abort or error.
			if (isAbort || isError || message.role !== "assistant") {
				return;
			}
			speakReplyRef.current(textOf(message)).catch(() => undefined);
		},
	});

	const sending = status === "submitted" || status === "streaming";
	const sendingRef = useRef(sending);
	sendingRef.current = sending;

	// ── Side-channel parts ────────────────────────────────────────────────────
	// `data-ryu-acp-*` and `data-plugin_note` ride the same stream but are not
	// transcript content; they land in `message.parts` and are read back out here.
	// Same derivation the desktop chat uses (@ryu/blocks/composer/streamed-parts).

	const streamedAcpMode = useMemo(
		() => latestStreamedAcpMode(messages),
		[messages]
	);
	useEffect(() => {
		if (streamedAcpMode) {
			onAcpModeRef.current?.(streamedAcpMode);
		}
	}, [streamedAcpMode]);

	const streamedAcpConfig = useMemo(
		() => latestStreamedAcpConfig(messages),
		[messages]
	);
	const lastAcpConfigKey = useRef<string | null>(null);
	useEffect(() => {
		// Keyed by EMISSION, not value: a second plan cycle re-emits the identical
		// map and must still land, or the Plan pill stays armed and the next turn
		// re-enters plan mode, refusing the edits the user just approved. A
		// re-derive over the same messages yields the same key, so a mid-stream
		// re-render no-ops instead of stomping a manual pick.
		if (
			!streamedAcpConfig ||
			streamedAcpConfig.key === lastAcpConfigKey.current
		) {
			return;
		}
		lastAcpConfigKey.current = streamedAcpConfig.key;
		onAcpConfigRef.current?.(streamedAcpConfig.value, streamedAcpConfig.key);
	}, [streamedAcpConfig]);

	// The latest turn-hook note (goal/proof/double-check), until dismissed.
	// Surfaced apart from the transcript so it never reads as an assistant reply.
	const [dismissedNoteKey, setDismissedNoteKey] = useState<string | null>(null);
	const pluginNote = useMemo(() => latestPluginNote(messages), [messages]);
	const notes = useMemo(
		() =>
			pluginNote && pluginNote.key !== dismissedNoteKey
				? [pluginNote.value]
				: [],
		[pluginNote, dismissedNoteKey]
	);
	const clearNotes = useCallback((): void => {
		setDismissedNoteKey(pluginNote?.key ?? null);
	}, [pluginNote]);

	const send = useCallback(
		async (
			text: string,
			sendOptions?: { withScreen?: boolean; attachments?: IslandAttachment[] }
		): Promise<void> => {
			const trimmed = text.trim();
			const attachments = sendOptions?.attachments ?? [];
			// A bare attachment with no caption is still a valid turn ("describe this
			// image"), so allow an empty draft when images are attached.
			if (
				(trimmed.length === 0 && attachments.length === 0) ||
				sendingRef.current
			) {
				return;
			}

			let outgoing = trimmed;
			if (sendOptions?.withScreen) {
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

			const messageId = crypto.randomUUID();
			if (outgoing !== displayText) {
				serverTextRef.current.set(messageId, outgoing);
			}

			sendMessage({
				messageId,
				parts: [{ type: "text", text: displayText }, ...fileParts],
			});
		},
		[sendMessage]
	);

	const stop = useCallback((): void => {
		stopSpeaking();
		stopChat();
	}, [stopSpeaking, stopChat]);

	return {
		clearNotes,
		error: error?.message ?? null,
		messages,
		notes,
		send,
		sending,
		status,
		stop,
	};
}
