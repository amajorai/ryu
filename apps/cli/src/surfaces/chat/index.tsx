/* @jsxImportSource @opentui/react */
// Chat surface - the reference home surface (path /chat), restructured toward the
// desktop AgentChat layout: an empty-state header with an agent/group mode picker,
// a scrolling message list, a WorkspaceBar (project + model) above the composer,
// and the composer/InputBar itself. It conforms to the SurfaceProps contract
// (see src/workspace/router.ts) and is the default tab the shell boots on.
//
// Migrated from the legacy src/tabs/chat.tsx: same SSE streaming via
// src/core/chatStream.ts, agent picker (Ctrl+A), and slash commands
// (/btw /goal /proof /check /model /group /sessions /queue /theme /help /new
// /newchat). /goal, /proof
// and /check are Core server-side plugin turn-hooks: /goal and /proof pass through
// as normal messages, /check arms the double-check hook via plugin_flags and its
// output arrives as data-plugin_note frames. Keyboard is OWNED here
// and gated on being the active tab of the FOCUSED pane, so a split with two chat
// panes only routes keys to the focused one.
//
// The surface body is split by responsibility into the sibling index-*.ts(x)
// hooks; this file owns the state and composes them.

import type { TextareaRenderable } from "@opentui/core";
import { fetchAgents } from "@ryuhq/core-client/agents";
import type { Workflow } from "@ryuhq/core-client/workflows";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { AutocompleteState } from "../../core/autocomplete.ts";
import { useChatIntent } from "../../core/ChatIntentContext.tsx";
import { useContributions } from "../../core/ContributionsContext.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useCoreHealth } from "../../core/CoreHealthContext.tsx";
import { dequeueChatTurn, type QueuedChatTurn } from "../../core/chatQueue.ts";
import type { AgentSlashCommand } from "../../core/contributions.ts";
import type { ConversationRow } from "../../core/conversations.ts";
import { listRecentConversations } from "../../core/conversations.ts";
import { type HerdrState, takeStartupResume } from "../../core/herdr.ts";
import {
	useSetInputFocused,
	useShellKeyboardCaptured,
} from "../../core/InputFocusContext.tsx";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import {
	formatSessionMeter,
	summarizeSessionUsage,
} from "../../core/turnReceipt.ts";
import { useOverlay } from "../../overlays/OverlayHost.tsx";
import { useTerminalTheme } from "../../ui/TerminalThemeProvider.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";
import { useChatCommands } from "./index-commands.ts";
import { useChatComposeKeys } from "./index-compose-keys.ts";
import {
	type ConfiguredModel,
	EMPTY_AGENT_COMMANDS,
	EMPTY_RECENTS,
	nextStarterPlaceholder,
	RECENT_CONVERSATION_LIMIT,
} from "./index-constants.ts";
import type { ChatSurfaceState } from "./index-context.ts";
import { useChatPromptHistory } from "./index-history.ts";
import { renderChatSurface, useChatComposerDock } from "./index-layout.tsx";
import { useChatMentions } from "./index-mentions.ts";
import { useChatOverlayKeys } from "./index-overlay-keys.ts";
import { useChatRunners } from "./index-runners.ts";
import { useChatSend } from "./index-send.ts";
import { useChatSubmit } from "./index-submit.ts";
import { useChatTurnControls } from "./index-turn-controls.ts";
import { useTranscriptScroll } from "./transcriptScroll.tsx";
import type { Message, Overlay } from "./types.ts";

function ChatSurface({ active, paneId }: SurfaceProps) {
	const { target } = useCore();
	const health = useCoreHealth();
	const recheckHealth = health?.recheck;
	// Only a confirmed outage of the current node shows the banner; "unknown"
	// (first check in flight) and a stale node's result never do.
	const coreDown = health?.state === "down" && health.url === target.url;
	const {
		reload: reloadContributions,
		slashCommands: contributedSlashCommands,
		slashCommandState,
	} = useContributions();
	const { effectiveMode } = useCliProductMode();
	const simpleInterface = effectiveMode === "bot";
	const theme = useTheme();
	const {
		availableModes,
		availablePresets,
		setMode: setThemeMode,
		setPreset: setThemePreset,
	} = useTerminalTheme();
	const { notify } = useToast();
	const shellKeyboardCaptured = useShellKeyboardCaptured();
	const { openId: externalOverlayId, openOverlay } = useOverlay();
	const { focusedPaneId, panes } = useWorkspace();
	// With several tabs in this pane, Alt+1..9 belongs to the shell's tab strip.
	const paneHasManyTabs =
		(panes.find((pane) => pane.id === paneId)?.tabIds.length ?? 0) > 1;
	const setInputFocused = useSetInputFocused();
	const { pending: chatIntent, clear: clearChatIntent } = useChatIntent();

	// Focused = this surface is the active tab AND its pane owns the keyboard.
	const focused = active && focusedPaneId === paneId;
	const [startupResume] = useState(takeStartupResume);
	const herdrId = useRef(Symbol("chat"));
	const herdrTurn = useRef<{
		id: symbol;
		report: (state: HerdrState, message?: string) => void;
	} | null>(null);

	const [messages, setMessages] = useState<Message[]>([]);
	// Conversation usage for the workspace bar. It derives from the messages,
	// so /new, /resume, and /fork (which replace them) reset it.
	const sessionMeter = useMemo(
		() =>
			formatSessionMeter(
				summarizeSessionUsage(messages.map((message) => message.usage))
			),
		[messages]
	);
	const transcriptScroll = useTranscriptScroll(messages);
	const scrollTranscript = transcriptScroll.scroll;
	const [composer, setComposer] = useState("");
	const {
		historyLoadedUrlRef,
		historySealer,
		historyTargetUrl,
		updatePromptHistory,
	} = useChatPromptHistory({ coreDown, target });
	const composerInputRef = useRef<TextareaRenderable | null>(null);
	// Collapsed bracketed pastes: placeholder token -> pasted text, expanded
	// back into the prompt when it is sent.
	const pastedTextRef = useRef(new Map<string, string>());
	const pasteSequenceRef = useRef(0);
	const [streaming, setStreaming] = useState(false);
	// The last turn's failure, as a Herdr attention message. It keeps the pane
	// "blocked" until the user engages again (types, submits, or starts over);
	// an abort or Esc-cancel never sets it.
	const [turnError, setTurnError] = useState<string | null>(null);
	// The conversation title once resume or /rename provides one; the shell
	// shows it in the terminal title.
	const [conversationTitle, setConversationTitle] = useState<string | null>(
		null
	);
	// Status-row activity for the in-flight turn: when it started (for the
	// elapsed counter) and the tool it is running, newest first.
	const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
	const [activeTool, setActiveTool] = useState<string | null>(null);
	const activeToolsRef = useRef(new Map<string, string>());
	// Ctrl+O: show long user prompts in full instead of their first lines.
	const [expandPrompts, setExpandPrompts] = useState(false);
	const [queuedMessages, setQueuedMessages] = useState<QueuedChatTurn[]>([]);
	// Esc mid-turn pauses the queue: nothing auto-dispatches until Enter on an
	// empty composer (send next), a typed prompt, or Esc again (clear).
	const [queuePaused, setQueuePaused] = useState(false);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(
		startupResume?.options.agentId ?? null
	);
	const [selectedTeam, setSelectedTeam] = useState<string | null>(
		startupResume?.options.teamId ?? null
	);
	const [advertisedAcpCommands, setAdvertisedAcpCommands] = useState<
		Record<string, AgentSlashCommand[]>
	>({});
	const routeAgent = simpleInterface ? "ryu" : selectedAgent;
	const routeTeam = simpleInterface ? null : selectedTeam;
	const activeCommandRouteKey = selectedTeam
		? `team:${selectedTeam}`
		: `agent:${routeAgent ?? "ryu"}`;
	const activeAcpCommands =
		advertisedAcpCommands[activeCommandRouteKey] ?? EMPTY_AGENT_COMMANDS;
	const [acpModel, setAcpModel] = useState<string | null>(
		startupResume?.options.acpModel ?? null
	);
	// The model the routed agent is configured with, resolved from Core so the
	// workspace bar and turn receipts name it instead of "default".
	const [configuredModel, setConfiguredModel] =
		useState<ConfiguredModel | null>(null);
	const configuredModelRef = useRef<ConfiguredModel | null>(null);
	configuredModelRef.current = configuredModel;
	useEffect(() => {
		if (simpleInterface || routeTeam || !routeAgent) {
			setConfiguredModel(null);
			return;
		}
		let cancelled = false;
		fetchAgents(target)
			.then((agents) => {
				if (cancelled) {
					return;
				}
				const model = agents
					.find((agent) => agent.id === routeAgent)
					?.model?.trim();
				setConfiguredModel(model ? { agentId: routeAgent, model } : null);
			})
			.catch(() => {
				if (!cancelled) {
					setConfiguredModel(null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [routeAgent, routeTeam, simpleInterface, target]);
	const [acpMode, setAcpMode] = useState<string | null>(
		startupResume?.options.acpMode ?? null
	);
	const [acpConfig, setAcpConfig] = useState<Record<string, string>>(
		startupResume?.options.acpConfig ?? {}
	);
	const [doubleCheckOn, setDoubleCheckOn] = useState(
		startupResume?.options.pluginFlags?.["io.ryu.double-check"] ?? false
	);
	const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
	const [queueFocused, setQueueFocused] = useState(false);
	const [queueSelectedIndex, setQueueSelectedIndex] = useState(0);
	const [autocomplete, setAutocomplete] = useState<AutocompleteState | null>(
		null
	);
	const [dismissedSlashArgumentValue, setDismissedSlashArgumentValue] =
		useState<string | null>(null);
	const [workflowDirectory, setWorkflowDirectory] = useState<{
		target: { token: string | null; url: string; userJwt: string | null };
		workflows: Workflow[];
	} | null>(null);

	const conversationIdRef = useRef<string>(crypto.randomUUID());
	const resumeRequestSequence = useRef(0);
	const resumeIdentity = JSON.stringify([
		target.url,
		target.token ?? null,
		target.userJwt ?? null,
	]);
	const latestResumeIdentity = useRef(resumeIdentity);
	latestResumeIdentity.current = resumeIdentity;
	useEffect(
		() => () => {
			resumeRequestSequence.current += 1;
		},
		[resumeIdentity]
	);
	// Recent conversations for the empty state: best effort, keyed to the node
	// that answered so a node switch never shows another node's history.
	const [recentConversations, setRecentConversations] = useState<{
		identity: string;
		rows: ConversationRow[];
	} | null>(null);
	const transcriptEmpty = messages.length === 0;
	useEffect(() => {
		if (!(active && transcriptEmpty)) {
			return;
		}
		let cancelled = false;
		const identity = resumeIdentity;
		listRecentConversations(target, RECENT_CONVERSATION_LIMIT)
			.catch(() => EMPTY_RECENTS)
			.then((rows) => {
				if (!cancelled && identity === latestResumeIdentity.current) {
					setRecentConversations({ identity, rows });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [active, transcriptEmpty, resumeIdentity, target]);
	const recentRows =
		recentConversations?.identity === resumeIdentity
			? recentConversations.rows
			: EMPTY_RECENTS;
	// How many of those rows the hero fits on screen; Alt+N reaches only these.
	const [visibleRecentCount, setVisibleRecentCount] = useState(0);
	const [starterPlaceholder, setStarterPlaceholder] = useState(
		nextStarterPlaceholder
	);
	const teamPickerRequestRef = useRef(0);
	const abortRef = useRef<AbortController | null>(null);
	// The conversation the in-flight turn was sent on, so Stop cancels that turn
	// on Core even after /new has minted a fresh conversation id.
	const turnConversationRef = useRef<string | undefined>(undefined);
	// An Esc Stop still waiting for Core to confirm the cancel (see the Esc key).
	const pendingStopRef = useRef<Promise<void> | null>(null);
	const composerRef = useRef(composer);
	composerRef.current = composer;
	// The textarea owns its buffer; app-driven changes (history, completion,
	// reset, submit) go through here so the buffer, ref, and state agree. The
	// ref is updated first so the resulting content-change event is recognised
	// as app-driven and keeps the history cursor.
	const setComposerText = useCallback((value: string) => {
		composerRef.current = value;
		setComposer(value);
		const editor = composerInputRef.current;
		if (editor && editor.plainText !== value) {
			editor.setText(value);
			editor.gotoBufferEnd();
		}
	}, []);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const overlayOpen = overlay.kind !== "none";
	const chat: ChatSurfaceState = {
		abortRef,
		acpConfig,
		acpMode,
		acpModel,
		active,
		activeAcpCommands,
		activeTool,
		activeToolsRef,
		autocomplete,
		availableModes,
		availablePresets,
		chatIntent,
		clearChatIntent,
		composer,
		composerInputRef,
		composerRef,
		configuredModel,
		configuredModelRef,
		contributedSlashCommands,
		conversationIdRef,
		conversationTitle,
		coreDown,
		dismissedSlashArgumentValue,
		doubleCheckOn,
		expandPrompts,
		externalOverlayId,
		focused,
		herdrId,
		herdrTurn,
		historyLoadedUrlRef,
		historySealer,
		historyTargetUrl,
		latestResumeIdentity,
		messages,
		messagesRef,
		notify,
		openOverlay,
		overlay,
		overlayOpen,
		paneHasManyTabs,
		paneId,
		pastedTextRef,
		pasteSequenceRef,
		pendingStopRef,
		queuedMessages,
		queueFocused,
		queuePaused,
		queueSelectedIndex,
		recentRows,
		recheckHealth,
		reloadContributions,
		resumeIdentity,
		resumeRequestSequence,
		routeAgent,
		routeTeam,
		scrollTranscript,
		selectedAgent,
		selectedTeam,
		sessionMeter,
		setAcpConfig,
		setAcpMode,
		setAcpModel,
		setActiveTool,
		setAdvertisedAcpCommands,
		setAutocomplete,
		setComposer,
		setComposerText,
		setConversationTitle,
		setDismissedSlashArgumentValue,
		setDoubleCheckOn,
		setExpandPrompts,
		setInputFocused,
		setMessages,
		setOverlay,
		setQueuedMessages,
		setQueueFocused,
		setQueuePaused,
		setQueueSelectedIndex,
		setSelectedAgent,
		setSelectedTeam,
		setStarterPlaceholder,
		setStreaming,
		setStreamStartedAt,
		setThemeMode,
		setThemePreset,
		setTurnError,
		setVisibleRecentCount,
		setWorkflowDirectory,
		shellKeyboardCaptured,
		simpleInterface,
		slashCommandState,
		starterPlaceholder,
		startupResume,
		streamStartedAt,
		streaming,
		target,
		teamPickerRequestRef,
		theme,
		transcriptScroll,
		turnConversationRef,
		turnError,
		updatePromptHistory,
		visibleRecentCount,
		workflowDirectory,
	};
	const mentions = useChatMentions(chat);

	useEffect(() => {
		if (queuedMessages.length === 0) {
			setQueueSelectedIndex(0);
			setQueueFocused(false);
			setQueuePaused(false);
			if (overlay.kind === "queue") {
				setOverlay({ kind: "none" });
			}
			return;
		}
		setQueueSelectedIndex((index) =>
			Math.min(index, Math.max(0, queuedMessages.length - 1))
		);
	}, [overlay.kind, queuedMessages.length]);

	const turnControls = useChatTurnControls({ ...chat, ...mentions });
	const { send } = useChatSend({ ...chat, ...turnControls });

	// Keep Core single-flight: once a turn settles, submit the oldest queued
	// prompt. The effect also handles a queue populated by rapid key presses.
	// An Esc interrupt pauses the drain so the queue never fires on its own.
	useEffect(() => {
		if (streaming || queuePaused || queuedMessages.length === 0) {
			return;
		}
		const { turn, queue } = dequeueChatTurn(queuedMessages);
		if (turn === null) {
			return;
		}
		setQueuedMessages(queue);
		send(turn.text, turn.options);
	}, [queuePaused, queuedMessages, send, streaming]);

	const runners = useChatRunners({ ...chat, ...turnControls });
	const commands = useChatCommands({
		...chat,
		...turnControls,
		...runners,
	});
	const submit = useChatSubmit({
		...chat,
		...mentions,
		...turnControls,
		...runners,
		...commands,
		send,
	});
	const overlayKeys = useChatOverlayKeys({ ...chat, ...runners });
	const { handleComposerPaste, interruptTurn } = useChatComposeKeys({
		...chat,
		...turnControls,
		...runners,
		...commands,
		...submit,
		...overlayKeys,
	});
	const layout = useChatComposerDock({ ...chat, interruptTurn });
	return renderChatSurface({
		...chat,
		...commands,
		...overlayKeys,
		...submit,
		...layout,
		handleComposerPaste,
	});
}

/** The Chat surface module. Registered by src/workspace/router.ts as the home
 * surface (path /chat). */
export const chatSurface: SurfaceModule = {
	id: "chat",
	title: "Chat",
	icon: "",
	match: (path) => path === "/chat" || path.startsWith("/chat/"),
	Component: ChatSurface,
};
