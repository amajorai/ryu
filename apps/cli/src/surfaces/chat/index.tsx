import type {
	ConversationRow,
	ResumedConversationMessage,
} from "../../core/conversations.ts";
/* @jsxImportSource @opentui/react */
import { readMemoryConsent } from "../../core/memoryConsent.ts";
import {
	nativeErrorMessage as errText,
	humanizeError,
} from "../../core/native-errors.ts";
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

import {
	type BoxRenderable,
	decodePasteBytes,
	type KeyBinding,
	type KeyEvent,
	type PasteEvent,
	type ScrollBoxRenderable,
	stripAnsiSequences,
	type TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { fetchAcpConfig } from "@ryuhq/core-client/acp";
import { fetchAgents } from "@ryuhq/core-client/agents";
import { askBtw } from "@ryuhq/core-client/btw";
import type { MentionTargetUser } from "@ryuhq/core-client/notifications";
import { type AppInfo, fetchApps } from "@ryuhq/core-client/plugins";
import { listSessionsForConversation } from "@ryuhq/core-client/sessions";
import { fetchTeams } from "@ryuhq/core-client/teams";
import { fetchWorkflows, type Workflow } from "@ryuhq/core-client/workflows";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { ChatQueueBar } from "../../components/ChatQueueBar.tsx";
import { ChatQueueOverlay } from "../../components/ChatQueueOverlay.tsx";
import {
	acpPickerChoices,
	applyAcpPickerChoice,
} from "../../core/acpPicker.ts";
import {
	type AutocompleteState,
	type AutocompleteSuggestion,
	agentSuggestions,
	applyAutocomplete,
	appPluginSuggestions,
	commandSuggestions,
	getAutocompleteContext,
	humanSuggestions,
	moveAutocompleteIndex,
	resolveWorkflowMention,
	runsOnEnter,
	slashArgumentSuggestions,
	workflowSuggestions,
} from "../../core/autocomplete.ts";
import { isLocal } from "../../core/bootstrap.ts";
import { useChatIntent } from "../../core/ChatIntentContext.tsx";
import { useContributions } from "../../core/ContributionsContext.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useCoreHealth } from "../../core/CoreHealthContext.tsx";
import { chatActivity } from "../../core/chatActivity.ts";
import {
	type ChatPermission,
	type ChatPermissionOption,
	isRejectPermissionOption,
	parseChatPermission,
	permissionToolCallId,
	permissionToolDetail,
	respondToChatPermission,
} from "../../core/chatPermission.ts";
import {
	type ChatQuestionAnswer,
	parseChatQuestion,
	respondToChatQuestion,
} from "../../core/chatQuestion.ts";
import {
	clearChatQueue,
	dequeueChatTurn,
	enqueueChatTurn,
	moveQueuedChatTurn,
	type QueuedChatTurn,
	removeQueuedChatTurn,
} from "../../core/chatQueue.ts";
import {
	type ChatStreamOptions,
	type ChatTurn,
	coalesceStreamDeltas,
	stopChatTurn,
	streamChat,
	type TurnUsage,
} from "../../core/chatStream.ts";
import {
	appendContinuationText,
	appendErrorPart,
	appendReasoningPart,
	appendTextPart,
	appendToolInputPart,
	appendToolOutputPart,
	asRecord,
	type ChatPart,
	chatPartsSchema,
	closeReasoningPart,
	readTodos,
	replaceTodoPart,
	settleRunningToolParts,
	type ToolSettleOutcome,
} from "../../core/chatTranscript.ts";
import {
	type CommandAction,
	dispatchCommand,
	isAdvertisedAgentCommand,
	isContributedPluginCommand,
} from "../../core/commands.ts";
import {
	expandPastePlaceholders,
	normalizePastedText,
	pastePlaceholderToken,
	shouldCollapsePaste,
} from "../../core/composerPaste.ts";
import {
	type AgentSlashCommand,
	acpSlashCommandsFromData,
} from "../../core/contributions.ts";
import {
	deleteConversation,
	forkConversation,
	listRecentConversations,
	renameConversation,
	resumeConversation,
	setConversationPinned,
} from "../../core/conversations.ts";
import { searchFiles } from "../../core/fileMentions.ts";
import {
	type HerdrState,
	herdrErrorMessage,
	herdrReporter,
	takeStartupResume,
} from "../../core/herdr.ts";
import {
	type ActiveAccountIdentity,
	fetchActiveAccountIdentity,
	inboxEnabled,
	listMentionTargetUsers,
	notifyMentionedUsers,
	type SelectedHumanMention,
	selectHumanNotificationTargets,
} from "../../core/humanMentions.ts";
import {
	useInterruptHandler,
	useSetInputFocused,
	useShellKeyboardCaptured,
} from "../../core/InputFocusContext.tsx";
import {
	acpModelPickerChoices,
	agentModelPickerChoices,
	type ModelPickerChoice,
	withDefaultModelChoice,
} from "../../core/modelPicker.ts";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import {
	coreHistorySealer,
	historyEntryFor,
	initialPromptHistory,
	loadAndMigratePromptHistory,
	mergeLoadedHistory,
	nextPrompt,
	type PromptHistoryState,
	previousPrompt,
	recordPrompt,
	resetPromptNavigation,
	saveSealedPromptHistory,
} from "../../core/promptHistory.ts";
import { RYU_THEME_PRESETS } from "../../core/themePreferences.ts";
import {
	formatSessionMeter,
	mergeUsage,
	summarizeSessionUsage,
} from "../../core/turnReceipt.ts";
import { useOverlay } from "../../overlays/OverlayHost.tsx";
import { useStatusContribution } from "../../ui/StatusContext.tsx";
import { useTerminalTheme } from "../../ui/TerminalThemeProvider.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";
import { AutocompleteView } from "./autocomplete.tsx";
import { OverlayView } from "./overlays.tsx";
import { PermissionPrompt } from "./PermissionPrompt.tsx";
import { busyActivityLabel, StatusLine, WorkspaceBar } from "./statusBar.tsx";
import { Transcript } from "./transcript.tsx";
import {
	JumpToLatestStrip,
	transcriptScrollForKey,
	useTranscriptScroll,
} from "./transcriptScroll.tsx";
import type { Message, Overlay } from "./types.ts";

const EMPTY_APPS: AppInfo[] = [];
const EMPTY_AGENT_COMMANDS: AgentSlashCommand[] = [];
const EMPTY_MENTION_USERS: MentionTargetUser[] = [];
const EMPTY_WORKFLOWS: Workflow[] = [];
const EMPTY_RECENTS: ConversationRow[] = [];
/** Recent conversations offered on the empty state (Alt+1..3 resumes one). */
const RECENT_CONVERSATION_LIMIT = 3;
/** Typing pause before an `@path` directory listing runs. */
const FILE_SEARCH_DEBOUNCE_MS = 80;

// Enter sends; Shift+Enter and Alt+Enter (where the terminal reports the
// modifier) and Ctrl+J (always: it arrives as a line feed) insert a newline.
const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
	{ name: "return", action: "submit" },
	{ name: "kpenter", action: "submit" },
	{ name: "return", shift: true, action: "newline" },
	{ name: "return", meta: true, action: "newline" },
	{ name: "kpenter", meta: true, action: "newline" },
	{ name: "linefeed", action: "newline" },
	{ name: "j", ctrl: true, action: "newline" },
];
const COMPOSER_MIN_MAX_ROWS = 6;

/**
 * The composer grows with its draft up to a third of the terminal (at least
 * six rows), but never past half of it so the transcript keeps some room.
 */
function composerMaxHeight(terminalHeight: number): number {
	const preferred = Math.max(
		COMPOSER_MIN_MAX_ROWS,
		Math.floor(terminalHeight / 3)
	);
	return Math.max(1, Math.min(preferred, Math.floor(terminalHeight / 2) - 2));
}
/**
 * Real starter tasks for the empty Console/OS composer, one per conversation
 * (no timer). Each keeps the "Message ·" lead the idle composer always shows.
 */
const STARTER_PLACEHOLDERS = [
	"Message · e.g. plan a feature, then hand it off",
	"Message · e.g. explain an error you're stuck on",
	"Message · e.g. draft a workflow from a goal",
	"Message · e.g. summarise recent changes",
] as const;
let starterCounter = 0;
function nextStarterPlaceholder(): string {
	const starter =
		STARTER_PLACEHOLDERS[starterCounter % STARTER_PLACEHOLDERS.length] ??
		STARTER_PLACEHOLDERS[0];
	starterCounter += 1;
	return starter;
}

/** The model a configured agent runs, so "default" can name a real model. */
interface ConfiguredModel {
	agentId: string;
	model: string;
}

/** Receipt label for the turn's route: the agent or group it went to. */
function receiptRouteLabel(options: ChatStreamOptions): string | undefined {
	if (options.teamId) {
		return `team:${options.teamId}`;
	}
	return options.agentId;
}

/** Permission prompt navigation: arrows and vim keys in both orientations. */
const PERMISSION_PREVIOUS_KEYS = new Set(["up", "k", "left", "h"]);
const PERMISSION_NEXT_KEYS = new Set(["down", "j", "right", "l"]);
const PERMISSION_DIGIT = /^[1-9]$/;
/** Rows a page key moves the permission prompt's detail body. */
const PERMISSION_BODY_PAGE_ROWS = 5;

let nextMessageId = 1;
const BOT_ROUTING_NOTICE =
	"Bot chats are pinned to Ryu; agent and group routing is available in Agent or OS.";

function commandRouteKey(options: ChatStreamOptions): string {
	return options.teamId
		? `team:${options.teamId}`
		: `agent:${options.agentId ?? "ryu"}`;
}

/** Chat's contribution to the shell status bar (Ctrl+A opens the agent picker). */
const CHAT_AGENT_HINT = { keys: "^A", label: "agent" };

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
	const [promptHistory, setPromptHistoryState] = useState(() =>
		initialPromptHistory()
	);
	// History navigation runs inside key handlers that also rewrite the
	// composer buffer, so it reads and writes this ref synchronously instead of
	// relying on a (possibly deferred) state updater.
	const promptHistoryRef = useRef(promptHistory);
	const updatePromptHistory = useCallback(
		(update: (state: PromptHistoryState) => PromptHistoryState) => {
			const next = update(promptHistoryRef.current);
			promptHistoryRef.current = next;
			setPromptHistoryState(next);
		},
		[]
	);
	// The history file is sealed by the local Core. Without a reachable Core
	// the history is kept in memory only and nothing is written.
	const historySealer = useMemo(
		() => (coreDown ? null : coreHistorySealer(target)),
		[coreDown, target]
	);
	// The node URL whose sealed history was loaded. Saves are allowed only for
	// that node: after a node switch the file is re-read through the new Core
	// (which may not hold the key) before anything is written back.
	const historyLoadedUrlRef = useRef<string | null>(null);
	const historyTargetUrl = target.url;
	useEffect(() => {
		if (!historySealer || historyLoadedUrlRef.current === historyTargetUrl) {
			return;
		}
		historyLoadedUrlRef.current = null;
		let cancelled = false;
		loadAndMigratePromptHistory(historySealer)
			.then((loaded) => {
				if (cancelled) {
					return;
				}
				historyLoadedUrlRef.current = historyTargetUrl;
				updatePromptHistory((current) => mergeLoadedHistory(loaded, current));
			})
			.catch(() => {
				// Core is unreachable or could not open the sealed file: stay
				// in memory-only mode and never save over the existing file. A
				// later Core reconnect retries the load.
			});
		return () => {
			cancelled = true;
		};
	}, [historySealer, historyTargetUrl, updatePromptHistory]);
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
	const workflowsRef = useRef<Workflow[]>([]);
	const availableWorkflows =
		!simpleInterface &&
		workflowDirectory?.target.url === target.url &&
		workflowDirectory.target.token === (target.token ?? null) &&
		workflowDirectory.target.userJwt === (target.userJwt ?? null)
			? workflowDirectory.workflows
			: EMPTY_WORKFLOWS;
	workflowsRef.current = availableWorkflows;
	const mentionRequestIdRef = useRef(0);
	const mentionAppsCacheRef = useRef<{
		apps: AppInfo[];
		targetKey: string;
	} | null>(null);
	const mentionAppsRequestRef = useRef<{
		promise: Promise<AppInfo[]>;
		targetKey: string;
	} | null>(null);
	const mentionPeopleCacheRef = useRef<{
		directory: {
			identity: ActiveAccountIdentity | null;
			users: MentionTargetUser[];
		};
		targetKey: string;
	} | null>(null);
	const mentionPeopleRequestRef = useRef<{
		promise: Promise<{
			identity: ActiveAccountIdentity | null;
			users: MentionTargetUser[];
		}>;
		targetKey: string;
	} | null>(null);
	const selectedHumanMentionsRef = useRef<SelectedHumanMention[]>([]);
	const mentionTargetKey = JSON.stringify([
		target.url,
		target.token ?? null,
		target.userJwt ?? null,
	]);
	const loadMentionApps = useCallback(() => {
		if (mentionAppsCacheRef.current?.targetKey === mentionTargetKey) {
			return Promise.resolve(mentionAppsCacheRef.current.apps);
		}
		if (mentionAppsRequestRef.current?.targetKey === mentionTargetKey) {
			return mentionAppsRequestRef.current.promise;
		}

		const promise = fetchApps(target).then((apps) => {
			if (mentionAppsRequestRef.current?.promise === promise) {
				mentionAppsCacheRef.current = { apps, targetKey: mentionTargetKey };
			}
			return apps;
		});
		mentionAppsRequestRef.current = { promise, targetKey: mentionTargetKey };
		const clearPending = () => {
			if (mentionAppsRequestRef.current?.promise === promise) {
				mentionAppsRequestRef.current = null;
			}
		};
		void promise.then(clearPending, clearPending);
		return promise;
	}, [mentionTargetKey, target]);
	const loadHumanMentionDirectory = useCallback(() => {
		if (mentionPeopleCacheRef.current?.targetKey === mentionTargetKey) {
			return Promise.resolve(mentionPeopleCacheRef.current.directory);
		}
		if (mentionPeopleRequestRef.current?.targetKey === mentionTargetKey) {
			return mentionPeopleRequestRef.current.promise;
		}

		const promise = Promise.all([
			listMentionTargetUsers(target),
			fetchActiveAccountIdentity(target),
		]).then(([users, identity]) => {
			const directory = { identity, users };
			if (mentionPeopleRequestRef.current?.promise === promise) {
				mentionPeopleCacheRef.current = {
					directory,
					targetKey: mentionTargetKey,
				};
			}
			return directory;
		});
		mentionPeopleRequestRef.current = { promise, targetKey: mentionTargetKey };
		const clearPending = () => {
			if (mentionPeopleRequestRef.current?.promise === promise) {
				mentionPeopleRequestRef.current = null;
			}
		};
		void promise.then(clearPending, clearPending);
		return promise;
	}, [mentionTargetKey, target]);

	useEffect(() => {
		if (simpleInterface) {
			setWorkflowDirectory(null);
			return;
		}
		const controller = new AbortController();
		const source = {
			token: target.token ?? null,
			url: target.url,
			userJwt: target.userJwt ?? null,
		};
		fetchWorkflows(target, controller.signal)
			.then((workflows) => setWorkflowDirectory({ target: source, workflows }))
			.catch(() => {
				if (!controller.signal.aborted) {
					setWorkflowDirectory({ target: source, workflows: [] });
				}
			});
		return () => controller.abort();
	}, [simpleInterface, target]);

	const overlayOpen = overlay.kind !== "none";

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

	// Slash commands are local and immediate. Mention candidates come from the
	// same Core agent catalog as Ctrl+A, but stale responses never replace newer
	// input.
	useEffect(() => {
		const requestId = mentionRequestIdRef.current + 1;
		mentionRequestIdRef.current = requestId;
		const context = getAutocompleteContext(composer, contributedSlashCommands);
		if (!context) {
			setAutocomplete(null);
			return;
		}
		if (context.kind === "slash-argument") {
			if (dismissedSlashArgumentValue === composer) {
				setAutocomplete(null);
				return;
			}
			const suggestions: AutocompleteSuggestion[] =
				slashArgumentSuggestions(context);
			if (slashCommandState === "error") {
				suggestions.push({ kind: "retry-slash-commands" });
			}
			setAutocomplete({ context, suggestions, index: 0 });
			return;
		}
		if (context.kind === "slash") {
			const suggestions: AutocompleteSuggestion[] = commandSuggestions(
				context.query,
				contributedSlashCommands,
				activeAcpCommands
			).filter(
				(suggestion) =>
					!simpleInterface ||
					suggestion.kind !== "command" ||
					(suggestion.name !== "model" &&
						suggestion.name !== "reasoning" &&
						suggestion.name !== "agent" &&
						suggestion.name !== "group")
			);
			if (slashCommandState === "error") {
				suggestions.push({ kind: "retry-slash-commands" });
			}
			setAutocomplete({ context, suggestions, index: 0 });
			return;
		}
		if (simpleInterface) {
			setAutocomplete(null);
			return;
		}
		if (context.kind === "file") {
			// File paths come from this machine, so they only describe the node's
			// workspace when Core runs locally.
			if (!isLocal(target.url)) {
				setAutocomplete({
					context,
					index: 0,
					notice: "File mentions need a local node",
					suggestions: [],
				});
				return;
			}
			setAutocomplete({ context, index: 0, loading: true, suggestions: [] });
			let cancelled = false;
			const timer = setTimeout(() => {
				void searchFiles(process.cwd(), context.query).then((paths) => {
					if (cancelled || mentionRequestIdRef.current !== requestId) {
						return;
					}
					setAutocomplete({
						context,
						index: 0,
						suggestions: paths.map((path) => ({ kind: "file", path })),
					});
				});
			}, FILE_SEARCH_DEBOUNCE_MS);
			return () => {
				cancelled = true;
				clearTimeout(timer);
			};
		}
		setAutocomplete({ context, index: 0, loading: true, suggestions: [] });
		void Promise.all([
			fetchAgents(target).catch(() => []),
			loadMentionApps().catch(() => EMPTY_APPS),
		]).then(async ([agents, mentionApps]) => {
			const inboxIsEnabled = mentionApps.some(
				(app) => app.id === "@ryu/approvals" && app.enabled
			);
			const people = inboxIsEnabled
				? await loadHumanMentionDirectory().catch(() => ({
						identity: null,
						users: EMPTY_MENTION_USERS,
					}))
				: { identity: null, users: EMPTY_MENTION_USERS };
			if (
				composerRef.current !== composer ||
				mentionRequestIdRef.current !== requestId
			) {
				return;
			}
			const latest = getAutocompleteContext(composer);
			if (latest?.kind !== "mention") {
				return;
			}
			const workflows = workflowSuggestions(workflowsRef.current, latest.query);
			const appsAndPlugins = appPluginSuggestions(mentionApps, latest.query);
			const humans = humanSuggestions(
				people.users,
				latest.query,
				people.identity?.userId ?? null
			);
			setAutocomplete({
				context: latest,
				suggestions: [
					...agentSuggestions(agents, latest.query),
					...humans,
					...appsAndPlugins,
					...workflows,
				],
				index: 0,
			});
		});
	}, [
		activeAcpCommands,
		availableWorkflows,
		composer,
		contributedSlashCommands,
		dismissedSlashArgumentValue,
		loadHumanMentionDirectory,
		loadMentionApps,
		slashCommandState,
		simpleInterface,
		target,
	]);

	const notifySelectedHumanMentions = useCallback(
		(content: string) => {
			const directory =
				mentionPeopleCacheRef.current?.targetKey === mentionTargetKey
					? mentionPeopleCacheRef.current.directory
					: null;
			const mentions = selectHumanNotificationTargets({
				content,
				currentUserId: directory?.identity?.userId ?? null,
				selected: selectedHumanMentionsRef.current,
			});
			selectedHumanMentionsRef.current = [];
			if (simpleInterface || mentions.length === 0) {
				return;
			}
			const senderName =
				directory?.identity?.name?.trim() ||
				directory?.identity?.email?.trim() ||
				"Someone";
			void inboxEnabled(target)
				.then((enabled) =>
					enabled
						? notifyMentionedUsers({
								content,
								mentions,
								senderName,
								target,
							})
						: { failedNames: [] }
				)
				.then(({ failedNames }) => {
					if (failedNames.length > 0) {
						notify(
							`Couldn't notify ${failedNames.join(", ")}`.slice(0, 180),
							"error"
						);
					}
				})
				.catch(() => {
					notify(
						`Couldn't notify ${mentions.map((mention) => mention.label).join(", ")}`.slice(
							0,
							180
						),
						"error"
					);
				});
		},
		[mentionTargetKey, notify, simpleInterface, target]
	);

	// Claim raw input while focused so shell plain-key globals (the bare "?"
	// shortcuts key) stay quiet, including while a chat-local overlay such as a
	// free-text question answer owns typing.
	useEffect(() => {
		setInputFocused(
			focused && !queueFocused && !shellKeyboardCaptured && !externalOverlayId
		);
		return () => setInputFocused(false);
	}, [
		externalOverlayId,
		focused,
		shellKeyboardCaptured,
		queueFocused,
		setInputFocused,
	]);

	// Stop the in-flight turn: abort the local read and cancel the turn on Core,
	// which otherwise keeps generating a persisted turn (and any goal or
	// auto-continue loop) after the client stops reading. Resolves once Core has
	// answered; `null` when no turn is in flight.
	const cancelActiveTurn = useCallback((): Promise<void> | null => {
		const controller = abortRef.current;
		if (!controller) {
			return null;
		}
		abortRef.current = null;
		return stopChatTurn(target, turnConversationRef.current, controller);
	}, [target]);

	const clearTurnActivity = useCallback(() => {
		activeToolsRef.current.clear();
		setActiveTool(null);
		setStreamStartedAt(null);
	}, []);

	const resetChat = useCallback(() => {
		resumeRequestSequence.current += 1;
		// The new chat gets a new conversation id, so its first turn cannot be
		// hit by this cancel; no need to wait for it.
		cancelActiveTurn();
		conversationIdRef.current = crypto.randomUUID();
		setConversationTitle(null);
		setTurnError(null);
		setMessages([]);
		setComposerText("");
		pastedTextRef.current.clear();
		updatePromptHistory(resetPromptNavigation);
		setQueuedMessages([]);
		setQueuePaused(false);
		setStreaming(false);
		clearTurnActivity();
		setOverlay({ kind: "none" });
		setAutocomplete(null);
		setAdvertisedAcpCommands({});
		setDismissedSlashArgumentValue(null);
		setStarterPlaceholder(nextStarterPlaceholder());
		selectedHumanMentionsRef.current = [];
		notify("Started a new chat", "info");
	}, [
		cancelActiveTurn,
		notify,
		clearTurnActivity,
		setComposerText,
		updatePromptHistory,
	]);

	const buildOptions = useCallback((): ChatStreamOptions => {
		const conversationId = conversationIdRef.current;
		const enableLongTerm = readMemoryConsent();
		// Arm Core's double-check turn-hook for this turn when the toggle is on.
		const pluginFlags = doubleCheckOn
			? { "io.ryu.double-check": true }
			: undefined;
		if (simpleInterface) {
			return {
				conversationId,
				enableLongTerm,
				agentId: "ryu",
				pluginFlags,
			};
		}
		if (selectedTeam) {
			return {
				conversationId,
				enableLongTerm,
				teamId: selectedTeam,
				acpModel: acpModel ?? undefined,
				acpMode: acpMode ?? undefined,
				acpConfig,
				pluginFlags,
			};
		}
		return {
			conversationId,
			enableLongTerm,
			agentId: selectedAgent ?? undefined,
			acpModel: acpModel ?? undefined,
			acpMode: acpMode ?? undefined,
			acpConfig,
			pluginFlags,
		};
	}, [
		selectedTeam,
		selectedAgent,
		acpModel,
		acpMode,
		acpConfig,
		doubleCheckOn,
		simpleInterface,
	]);

	const buildOptionsForPrompt = useCallback(
		(text: string): ChatStreamOptions => {
			const options = buildOptions();
			if (simpleInterface) {
				return options;
			}
			const workflowId = resolveWorkflowMention(text, workflowsRef.current);
			return workflowId ? { ...options, workflowId } : options;
		},
		[buildOptions, simpleInterface]
	);

	useEffect(() => {
		const blocked =
			overlay.kind === "permission" || overlay.kind === "question";
		herdrReporter?.update(
			herdrId.current,
			{
				focused,
				state: blocked
					? "blocked"
					: streaming
						? "working"
						: turnError
							? "blocked"
							: "idle",
				message: blocked
					? overlay.kind === "permission"
						? "Waiting for tool permission"
						: "Waiting for an answer"
					: (turnError ?? undefined),
				options: messages.length > 0 ? buildOptions() : undefined,
			},
			target.url
		);
	});
	useEffect(() => {
		const id = herdrId.current;
		return () => herdrReporter?.remove(id);
	}, []);

	const activityModel = simpleInterface
		? null
		: (acpModel ??
			(configuredModel?.agentId === routeAgent ? configuredModel.model : null));
	useEffect(() => {
		chatActivity.update(herdrId.current, {
			focused,
			streaming,
			title: conversationTitle,
			model: activityModel,
		});
	}, [focused, streaming, conversationTitle, activityModel]);
	useEffect(() => {
		const id = herdrId.current;
		return () => chatActivity.remove(id);
	}, []);

	const pushPluginNote = useCallback((text: string) => {
		setOverlay((o) =>
			o.kind === "plugin_note"
				? { kind: "plugin_note", notes: [...o.notes, text] }
				: { kind: "plugin_note", notes: [text] }
		);
	}, []);

	const send = useCallback(
		(text: string, optionsOverride?: ChatStreamOptions) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				return;
			}
			resumeRequestSequence.current += 1;
			// A failed turn leaves an assistant message with no content (its error
			// lives in an `error` part); drop it so providers never see an empty
			// assistant turn and the error text never reaches the model.
			const priorTurns: ChatTurn[] = messagesRef.current
				.filter((m) => m.role !== "assistant" || m.content.trim() !== "")
				.map((m) => ({
					role: m.role,
					content: m.content,
				}));
			const turns: ChatTurn[] = [
				...priorTurns,
				{ role: "user", content: trimmed },
			];
			const options = optionsOverride ?? buildOptions();
			const routeKey = commandRouteKey(options);
			turnConversationRef.current = options.conversationId;

			const userMessageId = nextMessageId++;
			const assistantMessageId = nextMessageId++;
			setMessages((prev) => [
				...prev,
				{
					id: userMessageId,
					role: "user",
					content: trimmed,
					parts: [{ type: "text", text: trimmed }],
				},
				{ id: assistantMessageId, role: "assistant", content: "", parts: [] },
			]);
			setStreaming(true);
			setTurnError(null);
			activeToolsRef.current.clear();
			setActiveTool(null);
			setStreamStartedAt(Date.now());

			const controller = new AbortController();
			abortRef.current = controller;
			const ownsTurn = () => abortRef.current === controller;
			const acceptsEvent = () => ownsTurn() && !controller.signal.aborted;
			const updateTurnAssistant = (update: (message: Message) => Message) => {
				if (!acceptsEvent()) {
					return;
				}
				setMessages((previous) =>
					previous.map((message) =>
						message.id === assistantMessageId && message.role === "assistant"
							? update(message)
							: message
					)
				);
			};
			// Settled turns (done, error, or Esc abort) stamp the trailing reasoning
			// part and settle every still-running tool so no row keeps spinning.
			// This bypasses acceptsEvent() on purpose (an aborted turn must still
			// settle) but stays scoped to this turn's assistant message, so a
			// superseded turn never rewrites a newer turn's parts.
			const settleTurn = (outcome: ToolSettleOutcome, reason?: string) => {
				const now = Date.now();
				setMessages((previous) =>
					previous.map((message) =>
						message.id === assistantMessageId && message.role === "assistant"
							? {
									...message,
									parts: settleRunningToolParts(
										closeReasoningPart(message.parts, now),
										outcome,
										reason,
										now
									),
								}
							: message
					)
				);
			};
			// Esc and chat resets abort synchronously; settle in the same tick so
			// interrupted rows go static immediately instead of after the fetch
			// promise unwinds.
			controller.signal.addEventListener(
				"abort",
				() => settleTurn("interrupted"),
				{ once: true }
			);
			const startedAt = Date.now();
			// ACP re-sends its usage meter many times a turn; keep the latest
			// snapshot here and write it to the message only when the turn
			// settles, so usage never forces a transcript redraw mid-stream.
			let latestUsage: TurnUsage | undefined;
			let turnFailed = false;
			const stampUsage = () => {
				const usage = latestUsage;
				if (!usage) {
					return;
				}
				setMessages((previous) =>
					previous.map((message) =>
						message.id === assistantMessageId && message.role === "assistant"
							? { ...message, usage }
							: message
					)
				);
			};
			const stampReceipt = () => {
				const configured = configuredModelRef.current;
				const modelLabel =
					options.acpModel ??
					(configured &&
					!options.teamId &&
					configured.agentId === options.agentId
						? configured.model
						: undefined);
				const agentLabel = receiptRouteLabel(options);
				updateTurnAssistant((message) => ({
					...message,
					receipt: {
						elapsedMs: Date.now() - startedAt,
						...(agentLabel ? { agentLabel } : {}),
						...(modelLabel ? { modelLabel } : {}),
					},
				}));
			};
			controller.signal.addEventListener("abort", stampUsage, { once: true });
			// Set when Core starts a continuation turn in this response; its first
			// text opens a new paragraph instead of running into the last turn.
			let continuationPending = false;
			const appendToTurn = (delta: string) => {
				if (continuationPending) {
					continuationPending = false;
					updateTurnAssistant((message) => ({
						...message,
						...appendContinuationText(message, delta),
					}));
					return;
				}
				updateTurnAssistant((message) => ({
					...message,
					content: message.content + delta,
					parts: appendTextPart(message.parts, delta),
				}));
			};

			const turnId = Symbol("turn");
			let turnState: HerdrState | "closed" | null = null;
			let turnMessage: string | undefined;
			const reportTurn = (state: HerdrState, message?: string) => {
				if (
					turnState === "closed" ||
					(turnState === state && turnMessage === message)
				) {
					return;
				}
				turnState = state;
				turnMessage = message;
				herdrReporter?.update(
					turnId,
					{ focused: false, state, message, options },
					target.url
				);
			};
			herdrTurn.current = { id: turnId, report: reportTurn };
			reportTurn("working");
			const finishTurn = () => {
				turnState = "closed";
				herdrReporter?.remove(turnId);
				if (herdrTurn.current?.id === turnId) {
					herdrTurn.current = null;
				}
			};

			streamChat(
				target,
				turns,
				options,
				coalesceStreamDeltas({
					onAcpCommands: (data) => {
						if (!acceptsEvent()) {
							return;
						}
						const commands = acpSlashCommandsFromData(data);
						if (commands) {
							setAdvertisedAcpCommands((current) => ({
								...current,
								[routeKey]: commands,
							}));
						}
					},
					onTextDelta: appendToTurn,
					onTurnBoundary: () => {
						continuationPending = true;
					},
					onToolInput: (name, input, toolCallId) => {
						if (!acceptsEvent()) {
							return;
						}
						const activeTools = activeToolsRef.current;
						// Untracked calls share a key; their output clears every entry.
						const toolKey = toolCallId ?? "untracked";
						activeTools.delete(toolKey);
						activeTools.set(toolKey, name);
						setActiveTool(name);
						updateTurnAssistant((message) => ({
							...message,
							parts: appendToolInputPart(
								message.parts,
								name,
								asRecord(input),
								toolCallId
							),
						}));
						const question =
							name === "Question" ? parseChatQuestion(input) : null;
						if (question) {
							reportTurn("blocked", "Waiting for an answer");
							setOverlay({
								kind: "question",
								question,
								questionIndex: 0,
								selected: 0,
								answers: [],
								text: "",
							});
						}
					},
					onToolOutput: (status, output, toolCallId) => {
						if (!acceptsEvent()) {
							return;
						}
						const activeTools = activeToolsRef.current;
						if (toolCallId === undefined) {
							activeTools.clear();
						} else {
							activeTools.delete(toolCallId);
						}
						setActiveTool([...activeTools.values()].at(-1) ?? null);
						updateTurnAssistant((message) => ({
							...message,
							parts: appendToolOutputPart(
								message.parts,
								status,
								output,
								toolCallId
							),
						}));
					},
					onReasoningDelta: (delta) =>
						updateTurnAssistant((message) => ({
							...message,
							parts: appendReasoningPart(message.parts, delta),
						})),
					onTodo: (input) =>
						updateTurnAssistant((message) => ({
							...message,
							parts: replaceTodoPart(message.parts, readTodos(input)),
						})),
					onPluginNote: (text) => {
						if (acceptsEvent()) {
							pushPluginNote(text);
						}
					},
					onUsage: (usage) => {
						if (acceptsEvent()) {
							latestUsage = mergeUsage(latestUsage, usage);
						}
					},
					onPermission: (value) => {
						if (!acceptsEvent()) {
							return;
						}
						const permission = parseChatPermission(value);
						if (permission) {
							reportTurn("blocked", "Waiting for tool permission");
							setOverlay({
								kind: "permission",
								index: 0,
								permission,
								detail: permissionToolDetail(permission.toolCall),
							});
						}
					},
					onError: (message) => {
						if (!acceptsEvent()) {
							return;
						}
						turnFailed = true;
						const readable = humanizeError(message, { url: target.url });
						setTurnError(herdrErrorMessage(readable));
						// The error renders inline in the transcript; a toast would
						// only repeat it.
						updateTurnAssistant((current) => ({
							...current,
							parts: appendErrorPart(current.parts, readable),
						}));
						settleTurn("error", readable);
					},
					onDone: () => {
						/* finalize handled after the promise resolves */
					},
				}),
				controller.signal
			)
				.then(() => {
					finishTurn();
					if (!controller.signal.aborted) {
						stampUsage();
						if (!turnFailed) {
							stampReceipt();
						}
					}
					// A finish without tool output settles as done (grok's
					// finalizeActiveTurn); an abort already settled as interrupted.
					settleTurn(controller.signal.aborted ? "interrupted" : "success");
					if (ownsTurn()) {
						setStreaming(false);
						clearTurnActivity();
						abortRef.current = null;
					}
				})
				.catch((err) => {
					finishTurn();
					const readable = humanizeError(err, { url: target.url });
					if (!controller.signal.aborted && ownsTurn()) {
						setTurnError(herdrErrorMessage(readable));
					}
					if (!controller.signal.aborted) {
						stampUsage();
						updateTurnAssistant((current) => ({
							...current,
							parts: appendErrorPart(current.parts, readable),
						}));
					}
					settleTurn(
						controller.signal.aborted ? "interrupted" : "error",
						controller.signal.aborted ? undefined : readable
					);
					if (ownsTurn()) {
						setStreaming(false);
						clearTurnActivity();
						abortRef.current = null;
					}
					if (!controller.signal.aborted) {
						// A failed turn may mean Core went away; refresh shared health.
						recheckHealth?.();
					}
				});
		},
		[target, buildOptions, pushPluginNote, clearTurnActivity, recheckHealth]
	);

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

	const openAgentPicker = useCallback(() => {
		if (simpleInterface) {
			notify(BOT_ROUTING_NOTICE, "info");
			return;
		}
		fetchAgents(target)
			.then((agents) =>
				setOverlay({
					kind: "agents",
					agents: agents.map((a) => ({ id: a.id, name: a.name })),
					index: 0,
				})
			)
			.catch((err) => notify(`agents failed: ${errText(err)}`, "error"));
	}, [notify, simpleInterface, target]);

	const loadTeams = useCallback(
		(requestId: number) => {
			fetchTeams(target)
				.then((teams) => {
					if (teamPickerRequestRef.current !== requestId) {
						return;
					}
					setOverlay((current) =>
						current.kind === "teams"
							? { ...current, teams, index: 0, loading: false, error: null }
							: current
					);
				})
				.catch((err) => {
					if (teamPickerRequestRef.current !== requestId) {
						return;
					}
					setOverlay((current) =>
						current.kind === "teams"
							? { ...current, loading: false, error: errText(err) }
							: current
					);
				});
		},
		[target]
	);

	const openTeamPicker = useCallback(() => {
		if (simpleInterface) {
			notify(BOT_ROUTING_NOTICE, "info");
			return;
		}
		const requestId = ++teamPickerRequestRef.current;
		setOverlay({
			kind: "teams",
			teams: [],
			index: 0,
			loading: true,
			error: null,
		});
		loadTeams(requestId);
	}, [loadTeams, notify, simpleInterface]);

	const openAcpPicker = useCallback(() => {
		if (!selectedAgent || selectedTeam) {
			notify("Choose an agent before opening ACP settings", "warning");
			return;
		}
		fetchAcpConfig(target, selectedAgent)
			.then((config) => {
				const choices = acpPickerChoices(config);
				if (choices.length === 0) {
					notify(
						"This agent exposes no permission or reasoning settings",
						"info"
					);
					return;
				}
				setOverlay({ kind: "acp", choices, index: 0 });
			})
			.catch((err) => notify(`ACP settings failed: ${errText(err)}`, "error"));
	}, [selectedAgent, selectedTeam, target, notify]);

	const openModelPicker = useCallback(() => {
		fetchAgents(target)
			.then(async (agents) => {
				let choices: ModelPickerChoice[] = [];
				if (selectedAgent && !selectedTeam) {
					try {
						choices = acpModelPickerChoices(
							await fetchAcpConfig(target, selectedAgent)
						);
					} catch {
						// Fall back to the model already configured on the agent.
						choices = [];
					}
				}
				if (choices.length === 0) {
					choices = agentModelPickerChoices(agents, selectedAgent);
				}
				if (choices.length === 0) {
					notify("No models are available for the current agent", "info");
					return;
				}
				setOverlay({
					kind: "models",
					choices: withDefaultModelChoice(choices),
					index: 0,
				});
			})
			.catch((err) => notify(`models failed: ${errText(err)}`, "error"));
	}, [selectedAgent, selectedTeam, target, notify]);

	const runBtw = useCallback(
		(arg: string) => {
			if (arg.length === 0) {
				notify("usage: /btw <question>", "warning");
				return;
			}
			setOverlay({ kind: "btw", question: arg, answer: null });
			askBtw(target, conversationIdRef.current, arg)
				.then((res) =>
					setOverlay({ kind: "btw", question: arg, answer: res.answer })
				)
				.catch((err) => {
					setOverlay({ kind: "none" });
					notify(`btw failed: ${errText(err)}`, "error");
				});
		},
		[target, notify]
	);

	const runTeam = useCallback(
		(arg: string) => {
			if (simpleInterface) {
				notify(BOT_ROUTING_NOTICE, "info");
				return;
			}
			if (arg.length === 0 || arg === "clear") {
				setSelectedTeam(null);
				notify("Group routing cleared", "info");
				return;
			}
			setSelectedTeam(arg);
			setSelectedAgent(null);
			notify(`Group: ${arg}`, "info");
		},
		[notify, simpleInterface]
	);

	const runSessions = useCallback(() => {
		listSessionsForConversation(target, conversationIdRef.current)
			.then((sessions) => setOverlay({ kind: "sessions", sessions }))
			.catch((err) => notify(`sessions failed: ${errText(err)}`, "error"));
	}, [target, notify]);

	const runFork = useCallback(
		(messageId: string) => {
			if (streaming) {
				notify("Wait for the current turn to finish before forking", "warning");
				return;
			}
			forkConversation(
				target,
				conversationIdRef.current,
				messageId.length > 0 ? messageId : undefined
			)
				.then((newConversationId) => {
					conversationIdRef.current = newConversationId;
					setConversationTitle(null);
					setTurnError(null);
					setMessages([]);
					setQueuedMessages([]);
					notify(`Forked chat: ${newConversationId}`, "info");
				})
				.catch((err) => notify(`fork failed: ${errText(err)}`, "error"));
		},
		[target, notify, streaming]
	);

	const runPin = useCallback(
		(pinned: boolean) => {
			setConversationPinned(target, conversationIdRef.current, pinned)
				.then(() => notify(pinned ? "Chat pinned" : "Chat unpinned", "info"))
				.catch((err) =>
					notify(`${pinned ? "pin" : "unpin"} failed: ${errText(err)}`, "error")
				);
		},
		[target, notify]
	);

	const runResume = useCallback(
		(conversationId: string) => {
			if (conversationId.length === 0) {
				notify("usage: /resume <conversation-id>", "warning");
				return;
			}
			if (streaming) {
				notify(
					"Wait for the current turn to finish before resuming",
					"warning"
				);
				return;
			}
			const requestSequence = ++resumeRequestSequence.current;
			const sourceConversationId = conversationIdRef.current;
			const isCurrentResume = () =>
				requestSequence === resumeRequestSequence.current &&
				resumeIdentity === latestResumeIdentity.current &&
				sourceConversationId === conversationIdRef.current;
			resumeConversation(target, conversationId)
				.then((conversation) => {
					if (!isCurrentResume()) {
						return;
					}
					conversationIdRef.current = conversation.id;
					setConversationTitle(conversation.title || null);
					setTurnError(null);
					setMessages(
						conversation.messages.map((message) => ({
							id: nextMessageId++,
							role: message.role === "user" ? "user" : "assistant",
							content: message.content,
							parts: resumedChatParts(message),
						}))
					);
					setQueuedMessages([]);
					setOverlay({ kind: "none" });
					notify(
						conversation.title
							? `Resumed: ${conversation.title}`
							: `Resumed chat: ${conversation.id}`,
						"info"
					);
				})
				.catch((err) => {
					if (isCurrentResume()) {
						notify(`resume failed: ${errText(err)}`, "error");
					}
				});
		},
		[target, notify, streaming, resumeIdentity]
	);

	const startupApplied = useRef(false);
	useEffect(() => {
		if (startupResume && !startupApplied.current) {
			startupApplied.current = true;
			runResume(startupResume.id);
		}
	}, [runResume, startupResume]);

	const runRename = useCallback(
		(title: string) => {
			if (title.length === 0) {
				notify("usage: /rename <title>", "warning");
				return;
			}
			const conversationId = conversationIdRef.current;
			renameConversation(target, conversationId, title)
				.then((nextTitle) => {
					if (conversationIdRef.current === conversationId) {
						setConversationTitle(nextTitle);
					}
					notify(`Renamed: ${nextTitle}`, "info");
				})
				.catch((err) => notify(`rename failed: ${errText(err)}`, "error"));
		},
		[target, notify]
	);

	const runDelete = useCallback((conversationId: string) => {
		const id = conversationId || conversationIdRef.current;
		setOverlay({ kind: "delete", conversationId: id });
	}, []);

	const toggleDoubleCheck = useCallback(() => {
		setDoubleCheckOn(!doubleCheckOn);
		notify(doubleCheckOn ? "Double-check off" : "Double-check armed", "info");
	}, [doubleCheckOn, notify]);

	const clearQueuedMessages = useCallback(() => {
		if (queuedMessages.length === 0) {
			return;
		}
		setQueuedMessages(clearChatQueue(queuedMessages));
		setQueuePaused(false);
		setOverlay({ kind: "none" });
		setQueueFocused(false);
		notify("Queue cleared", "info");
	}, [notify, queuedMessages]);

	const removeQueuedMessageAt = useCallback(
		(index: number) => {
			const turn = queuedMessages[index];
			if (!turn) {
				return;
			}
			setQueuedMessages(removeQueuedChatTurn(queuedMessages, turn.id));
			notify("Removed queued prompt", "info");
		},
		[notify, queuedMessages]
	);

	const moveQueuedMessage = useCallback(
		(id: string, direction: "up" | "down") => {
			setQueuedMessages((current) =>
				moveQueuedChatTurn(current, id, direction)
			);
		},
		[]
	);

	const moveQueuedMessageAt = useCallback(
		(index: number, direction: "up" | "down") => {
			const turn = queuedMessages[index];
			if (!turn) {
				return;
			}
			const nextIndex =
				direction === "up"
					? Math.max(0, index - 1)
					: Math.min(queuedMessages.length - 1, index + 1);
			if (nextIndex === index) {
				return;
			}
			setQueuedMessages((current) =>
				moveQueuedChatTurn(current, turn.id, direction)
			);
			setQueueSelectedIndex(nextIndex);
		},
		[queuedMessages]
	);

	const openQueue = useCallback(
		(index = queueSelectedIndex) => {
			if (queuedMessages.length === 0) {
				notify("The prompt queue is empty", "info");
				return;
			}
			const nextIndex = Math.min(
				Math.max(0, index),
				Math.max(0, queuedMessages.length - 1)
			);
			setQueueSelectedIndex(nextIndex);
			setQueueFocused(false);
			setOverlay({ kind: "queue", index: nextIndex });
		},
		[notify, queueSelectedIndex, queuedMessages.length]
	);

	const openTheme = useCallback(
		(argument = "") => setOverlay({ kind: "theme", argument }),
		[]
	);

	const applyThemeArgument = useCallback(
		(argument: string): boolean => {
			const normalized = argument.trim().toLowerCase();
			if (normalized.length === 0) {
				return false;
			}
			const mode = availableModes.find((candidate) => candidate === normalized);
			if (mode) {
				setThemeMode(mode);
				notify(`Theme mode: ${normalized}`, "info");
				return true;
			}
			const preset = availablePresets.find(
				(candidate) => candidate === normalized
			);
			if (preset) {
				setThemePreset(preset);
				notify(`Theme preset: ${RYU_THEME_PRESETS[preset].label}`, "info");
				return true;
			}
			return false;
		},
		[availableModes, availablePresets, notify, setThemeMode, setThemePreset]
	);

	const applyCommandAction = useCallback(
		(action: CommandAction): boolean => {
			if (action.kind === "passthrough") {
				return false;
			}
			if (
				simpleInterface &&
				((action.kind === "overlay" &&
					(action.overlay === "acp-settings" ||
						action.overlay === "model-picker")) ||
					(action.kind === "local" &&
						(action.action === "set-model" || action.action === "set-team")))
			) {
				if (action.kind === "local" && action.action === "set-team") {
					notify(BOT_ROUTING_NOTICE, "info");
				} else {
					notify(
						"Model and approval controls are available in Agent or OS.",
						"info"
					);
				}
				return true;
			}
			if (action.kind === "overlay") {
				switch (action.overlay) {
					case "agent-picker":
						openAgentPicker();
						return true;
					case "acp-settings":
						openAcpPicker();
						return true;
					case "btw":
						runBtw(action.argument);
						return true;
					case "conversation-delete":
						runDelete(action.argument);
						return true;
					case "help":
						// Bare /help opens the shell's keyboard-shortcuts overlay (keys
						// and every command); /help <command> shows that command's usage.
						if (action.argument) {
							setOverlay({ kind: "help", command: action.argument });
						} else {
							openOverlay("keymap");
						}
						return true;
					case "model-picker":
						openModelPicker();
						return true;
					case "queue":
						openQueue();
						return true;
					case "session-list":
						runSessions();
						return true;
					case "theme":
						if (!applyThemeArgument(action.argument)) {
							openTheme(action.argument);
						}
						return true;
				}
			}
			if (action.kind !== "local") {
				return true;
			}
			switch (action.action) {
				case "new-chat":
					resetChat();
					return true;
				case "toggle-double-check":
					toggleDoubleCheck();
					return true;
				case "set-model":
					setAcpModel(action.model);
					notify(
						action.model ? `Model: ${action.model}` : "Model override cleared",
						"info"
					);
					return true;
				case "set-team":
					runTeam(action.team ?? "");
					return true;
				case "fork-conversation":
					runFork(action.messageId ?? "");
					return true;
				case "resume-conversation":
					runResume(action.conversationId);
					return true;
				case "rename-conversation":
					runRename(action.title);
					return true;
				case "pin-conversation":
					runPin(action.pinned);
					return true;
				case "clear-queue":
					clearQueuedMessages();
					return true;
				case "remove-queue-item": {
					const index = queuedMessages.findIndex(
						(turn) => turn.id === action.itemId
					);
					if (index >= 0) {
						removeQueuedMessageAt(index);
					}
					return true;
				}
				case "move-queue-item":
					moveQueuedMessage(action.itemId, action.direction);
					return true;
			}
		},
		[
			applyThemeArgument,
			clearQueuedMessages,
			simpleInterface,
			moveQueuedMessage,
			notify,
			openAcpPicker,
			openAgentPicker,
			openModelPicker,
			openOverlay,
			openQueue,
			openTheme,
			queuedMessages,
			removeQueuedMessageAt,
			resetChat,
			runBtw,
			runDelete,
			runFork,
			runPin,
			runRename,
			runResume,
			runSessions,
			runTeam,
			setThemeMode,
			toggleDoubleCheck,
		]
	);

	const handleCommand = useCallback(
		(raw: string): boolean => {
			if (/^\/(?:group|team)\s*$/i.test(raw.trim())) {
				openTeamPicker();
				return true;
			}
			const dispatch = dispatchCommand(raw);
			if (!dispatch) {
				return false;
			}
			if (
				dispatch.kind === "unknown" &&
				(isContributedPluginCommand(raw, contributedSlashCommands) ||
					isAdvertisedAgentCommand(raw, activeAcpCommands))
			) {
				return false;
			}
			if (dispatch.kind === "unknown" || dispatch.kind === "usage") {
				notify(dispatch.message, "warning");
				return true;
			}
			return applyCommandAction(dispatch.action);
		},
		[
			activeAcpCommands,
			applyCommandAction,
			contributedSlashCommands,
			notify,
			openTeamPicker,
		]
	);

	const submitComposer = useCallback(() => {
		// Read the editor buffer directly: typing and Enter can land in one
		// batch before the content-change event has updated the ref.
		const draft = composerInputRef.current?.plainText ?? composerRef.current;
		const text = expandPastePlaceholders(draft, pastedTextRef.current);
		// Enter on an empty composer resumes a paused queue: the drain effect
		// then sends the oldest queued prompt.
		if (
			text.trim() === "" &&
			!streaming &&
			queuePaused &&
			queuedMessages.length > 0
		) {
			setQueuePaused(false);
			return;
		}
		// Nothing to send (e.g. a stray second Enter after a command ran).
		if (text.trim() === "") {
			return;
		}
		setTurnError(null);
		setComposerText("");
		pastedTextRef.current.clear();
		setAutocomplete(null);
		updatePromptHistory((state) => {
			// The composer text, not the expanded prompt: collapsed pastes and
			// slash-command arguments are never recorded.
			const next = recordPrompt(state, historyEntryFor(draft));
			if (historySealer && historyLoadedUrlRef.current === historyTargetUrl) {
				saveSealedPromptHistory(next.entries, historySealer).catch(() => {
					// Best-effort; the history stays in memory.
				});
			}
			return next;
		});
		if (handleCommand(text)) {
			selectedHumanMentionsRef.current = [];
			return;
		}
		if (streaming) {
			const result = enqueueChatTurn(
				queuedMessages,
				text,
				buildOptionsForPrompt(text)
			);
			if (result.accepted) {
				setQueuedMessages(result.queue);
				notify(`Queued prompt (${result.queue.length})`, "info");
				notifySelectedHumanMentions(text);
			} else {
				selectedHumanMentionsRef.current = [];
				notify(
					"Prompt queue is full (50); wait for the current turn",
					"warning"
				);
			}
			return;
		}
		// A typed prompt goes first ("send now"); the paused queue drains after.
		setQueuePaused(false);
		// Sending is a request to follow the new turn: leave any scrolled-back
		// position so the prompt and its reply are not hidden behind the strip.
		scrollTranscript("bottom");
		send(text, buildOptionsForPrompt(text));
		notifySelectedHumanMentions(text);
	}, [
		handleCommand,
		queuePaused,
		queuedMessages,
		streaming,
		send,
		notify,
		buildOptionsForPrompt,
		notifySelectedHumanMentions,
		historySealer,
		historyTargetUrl,
		scrollTranscript,
		setComposerText,
		updatePromptHistory,
	]);

	const applySelectedAutocomplete = useCallback(() => {
		if (!autocomplete) {
			return false;
		}
		const suggestion = autocomplete.suggestions[autocomplete.index];
		if (!suggestion) {
			return false;
		}
		if (suggestion.kind === "retry-slash-commands") {
			setAutocomplete(null);
			reloadContributions();
			return true;
		}
		if (
			suggestion.kind === "human" &&
			!selectedHumanMentionsRef.current.some(
				(mention) => mention.id === suggestion.id
			)
		) {
			selectedHumanMentionsRef.current.push({
				id: suggestion.id,
				label: suggestion.name,
			});
		}
		const nextComposer = applyAutocomplete(
			composer,
			autocomplete.context,
			suggestion
		);
		setDismissedSlashArgumentValue(
			autocomplete.context.kind === "slash-argument" &&
				suggestion.kind === "slash-argument-option" &&
				!autocomplete.context.hasNextArgument
				? nextComposer
				: null
		);
		setComposerText(nextComposer);
		setAutocomplete(null);
		return true;
	}, [autocomplete, composer, reloadContributions, setComposerText]);

	// Apply a palette-issued chat intent once this surface is the active tab.
	useEffect(() => {
		if (!(active && chatIntent)) {
			return;
		}
		if (chatIntent === "new") {
			resetChat();
		} else if (chatIntent === "sessions") {
			runSessions();
		} else if (chatIntent === "toggle-check") {
			toggleDoubleCheck();
		}
		clearChatIntent();
	}, [
		active,
		chatIntent,
		clearChatIntent,
		resetChat,
		runSessions,
		toggleDoubleCheck,
	]);

	const handleAgentKey = (key: KeyEvent) => {
		if (overlay.kind !== "agents") {
			return;
		}
		if (key.name === "escape") {
			setOverlay({ kind: "none" });
		} else if (key.name === "up" || key.name === "k") {
			setOverlay((o) =>
				o.kind === "agents" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((o) =>
				o.kind === "agents"
					? { ...o, index: Math.min(o.agents.length - 1, o.index + 1) }
					: o
			);
		} else if (key.name === "return") {
			const chosen = overlay.agents[overlay.index];
			if (chosen) {
				setSelectedAgent(chosen.id);
				setSelectedTeam(null);
				notify(`Agent: ${chosen.name}`, "info");
			}
			setOverlay({ kind: "none" });
		}
	};

	const handleTeamKey = (key: KeyEvent) => {
		if (overlay.kind !== "teams") {
			return;
		}
		if (key.name === "escape") {
			teamPickerRequestRef.current += 1;
			setOverlay({ kind: "none" });
			return;
		}
		if (overlay.loading) {
			return;
		}
		if (overlay.error) {
			if (key.name === "r") {
				const requestId = ++teamPickerRequestRef.current;
				setOverlay((current) =>
					current.kind === "teams"
						? { ...current, loading: true, error: null }
						: current
				);
				loadTeams(requestId);
			}
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setOverlay((current) =>
				current.kind === "teams"
					? { ...current, index: Math.max(0, current.index - 1) }
					: current
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((current) =>
				current.kind === "teams"
					? {
							...current,
							index: Math.min(current.teams.length - 1, current.index + 1),
						}
					: current
			);
		} else if (key.name === "return") {
			const selected = overlay.teams[overlay.index];
			if (selected) {
				setSelectedTeam(selected.id);
				setSelectedAgent(null);
				notify(`Group: ${selected.name}`, "info");
			}
			setOverlay({ kind: "none" });
		}
	};

	const handleModelKey = (key: KeyEvent) => {
		if (overlay.kind !== "models") {
			return;
		}
		if (key.name === "escape") {
			setOverlay({ kind: "none" });
		} else if (key.name === "up" || key.name === "k") {
			setOverlay((o) =>
				o.kind === "models" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((o) =>
				o.kind === "models"
					? { ...o, index: Math.min(o.choices.length - 1, o.index + 1) }
					: o
			);
		} else if (key.name === "return") {
			const choice = overlay.choices[overlay.index];
			if (choice) {
				setAcpModel(choice.id);
				notify(
					choice.id ? `Model: ${choice.label}` : "Model override cleared",
					"info"
				);
			}
			setOverlay({ kind: "none" });
		}
	};

	const handleAcpKey = (key: KeyEvent) => {
		if (overlay.kind !== "acp") {
			return;
		}
		if (key.name === "escape") {
			setOverlay({ kind: "none" });
		} else if (key.name === "up" || key.name === "k") {
			setOverlay((o) =>
				o.kind === "acp" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
		} else if (key.name === "down" || key.name === "j") {
			setOverlay((o) =>
				o.kind === "acp"
					? { ...o, index: Math.min(o.choices.length - 1, o.index + 1) }
					: o
			);
		} else if (key.name === "return") {
			const choice = overlay.choices[overlay.index];
			if (choice) {
				const next = applyAcpPickerChoice(choice, {
					mode: acpMode,
					config: acpConfig,
				});
				setAcpMode(next.mode);
				setAcpConfig(next.config);
				notify(`ACP: ${choice.label}`, "info");
			}
			setOverlay({ kind: "none" });
		}
	};

	// A rejected permission strikes the tool row through instead of leaving it
	// spinning until the turn ends. Without an ACP toolCallId nothing changes.
	const markPermissionDenied = (toolCall: ChatPermission["toolCall"]) => {
		const toolCallId = permissionToolCallId(toolCall);
		if (!toolCallId) {
			return;
		}
		setMessages((previous) => {
			const index = previous.findLastIndex(
				(message) => message.role === "assistant"
			);
			const message = previous[index];
			if (!message) {
				return previous;
			}
			const parts = appendToolOutputPart(
				message.parts,
				"denied",
				undefined,
				toolCallId
			);
			return parts === message.parts
				? previous
				: previous.with(index, { ...message, parts });
		});
	};

	const submitPermission = (
		permission: ChatPermission,
		option: ChatPermissionOption
	) => {
		const report = herdrTurn.current?.report;
		if (isRejectPermissionOption(option)) {
			markPermissionDenied(permission.toolCall);
		}
		setOverlay({ kind: "none" });
		respondToChatPermission(target, permission.requestId, option.optionId)
			.then((resolved) => {
				if (resolved) {
					report?.("working");
				}
			})
			.catch((err) => notify(`permission failed: ${errText(err)}`, "error"));
	};

	const permissionBodyRef = useRef<ScrollBoxRenderable | null>(null);
	const handlePermissionKey = (key: KeyEvent) => {
		if (overlay.kind !== "permission") {
			return;
		}
		if (key.name === "escape") {
			const report = herdrTurn.current?.report;
			const requestId = overlay.permission.requestId;
			markPermissionDenied(overlay.permission.toolCall);
			setOverlay({ kind: "none" });
			respondToChatPermission(target, requestId, null)
				.then((resolved) => {
					if (resolved) {
						report?.("working");
					}
				})
				.catch((err) =>
					notify(`permission rejected: ${errText(err)}`, "error")
				);
			return;
		}
		if (PERMISSION_PREVIOUS_KEYS.has(key.name)) {
			setOverlay((o) =>
				o.kind === "permission" ? { ...o, index: Math.max(0, o.index - 1) } : o
			);
			return;
		}
		if (PERMISSION_NEXT_KEYS.has(key.name)) {
			setOverlay((o) =>
				o.kind === "permission"
					? {
							...o,
							index: Math.min(o.permission.options.length - 1, o.index + 1),
						}
					: o
			);
			return;
		}
		if (key.name === "pageup" || key.name === "pagedown") {
			permissionBodyRef.current?.scrollBy(
				key.name === "pageup"
					? -PERMISSION_BODY_PAGE_ROWS
					: PERMISSION_BODY_PAGE_ROWS
			);
			return;
		}
		// 1-9 choose and submit at once; a digit past the last option is ignored.
		const plainDigit =
			!(key.ctrl || key.meta || key.option) && PERMISSION_DIGIT.test(key.name);
		const digit = plainDigit ? Number(key.name) : 0;
		const digitOption = overlay.permission.options[digit - 1];
		if (digit > 0 && digitOption) {
			submitPermission(overlay.permission, digitOption);
			return;
		}
		if (key.name === "return") {
			const option = overlay.permission.options[overlay.index];
			if (option) {
				submitPermission(overlay.permission, option);
			}
		}
	};

	const handleQuestionKey = (key: KeyEvent) => {
		if (overlay.kind !== "question") {
			return;
		}
		const current = overlay.question.questions[overlay.questionIndex];
		if (!current) {
			return;
		}
		if (key.name === "escape") {
			const report = herdrTurn.current?.report;
			setOverlay({ kind: "none" });
			void respondToChatQuestion(
				target,
				conversationIdRef.current,
				overlay.question,
				[{ kind: "skip", question_id: current.id }]
			)
				.then((resolved) => {
					if (resolved) {
						report?.("working");
					}
				})
				.catch((err) => notify(`question rejected: ${errText(err)}`, "error"));
			return;
		}
		if (current.kind === "text") {
			if (key.name === "backspace") {
				setOverlay((state) =>
					state.kind === "question"
						? { ...state, text: state.text.slice(0, -1) }
						: state
				);
				return;
			}
			if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
				setOverlay((state) =>
					state.kind === "question"
						? { ...state, text: state.text + key.sequence }
						: state
				);
				return;
			}
		}
		if (key.name === "up" || key.name === "k") {
			setOverlay((state) =>
				state.kind === "question"
					? { ...state, selected: Math.max(0, state.selected - 1) }
					: state
			);
			return;
		}
		if (key.name === "down" || key.name === "j") {
			setOverlay((state) =>
				state.kind === "question"
					? {
							...state,
							selected: Math.min(
								Math.max(0, current.options.length - 1),
								state.selected + 1
							),
						}
					: state
			);
			return;
		}
		if (key.name !== "return") {
			return;
		}
		const selected = current.options[overlay.selected];
		const answer: ChatQuestionAnswer =
			current.kind === "text"
				? { kind: "text", question_id: current.id, text: overlay.text }
				: {
						kind: current.kind,
						question_id: current.id,
						selected_ids: selected ? [selected.id] : [],
					};
		const answers = [...overlay.answers, answer];
		const nextIndex = overlay.questionIndex + 1;
		if (nextIndex < overlay.question.questions.length) {
			setOverlay({
				...overlay,
				answers,
				questionIndex: nextIndex,
				selected: 0,
				text: "",
			});
			return;
		}
		setOverlay({ kind: "none" });
		const report = herdrTurn.current?.report;
		void respondToChatQuestion(
			target,
			conversationIdRef.current,
			overlay.question,
			answers
		)
			.then((resolved) => {
				if (resolved) {
					report?.("working");
				}
				if (!resolved) {
					notify("Question expired before it was answered", "warning");
				}
			})
			.catch((err) => notify(`question failed: ${errText(err)}`, "error"));
	};

	const confirmDelete = useCallback(() => {
		if (overlay.kind !== "delete") {
			return;
		}
		const id = overlay.conversationId;
		setOverlay({ kind: "none" });
		void deleteConversation(target, id)
			.then((removed) => {
				if (id === conversationIdRef.current) {
					resetChat();
				}
				notify(
					removed ? "Conversation deleted" : "Conversation was already absent",
					"info"
				);
			})
			.catch((err) => notify(`delete failed: ${errText(err)}`, "error"));
	}, [overlay, notify, resetChat, target]);

	// Alt+1..3 on an empty chat with an empty composer resumes the listed
	// recent conversation; anywhere else the keys fall through untouched. When
	// the pane holds several tabs the shell's Alt+1..9 tab jump owns them.
	const recentResumeIndex = (key: KeyEvent): number | null => {
		if (!(key.meta || key.option) || key.ctrl || paneHasManyTabs) {
			return null;
		}
		const index = Number.parseInt(key.name, 10) - 1;
		if (
			Number.isNaN(index) ||
			index < 0 ||
			index >= Math.min(recentRows.length, visibleRecentCount) ||
			messages.length > 0 ||
			composer.length > 0
		) {
			return null;
		}
		return index;
	};
	const resumeRecent = (index: number | null): boolean => {
		const row = index === null ? undefined : recentRows[index];
		if (!row) {
			return false;
		}
		runResume(row.id);
		return true;
	};

	// Up/Down walk prompt history only from the top or bottom visual row of the
	// draft, so the arrows still move the cursor through wrapped and multi-line
	// text in the middle of it.
	const historyKeyAllowed = (key: KeyEvent): boolean => {
		if (key.name !== "up" && key.name !== "down") {
			return false;
		}
		if (key.ctrl || key.meta || key.shift || key.super) {
			return false;
		}
		const editor = composerInputRef.current;
		if (!editor || editor.plainText === "") {
			return true;
		}
		const row = editor.scrollY + editor.visualCursor.visualRow;
		const lastRow = Math.max(
			0,
			editor.editorView.getTotalVirtualLineCount() - 1
		);
		return key.name === "up" ? row === 0 : row === lastRow;
	};

	const handleComposerPaste = (event: PasteEvent) => {
		const editor = composerInputRef.current;
		if (!editor) {
			return;
		}
		event.preventDefault();
		const text = normalizePastedText(
			stripAnsiSequences(decodePasteBytes(event.bytes))
		);
		if (!shouldCollapsePaste(text)) {
			editor.insertText(text);
			return;
		}
		pasteSequenceRef.current += 1;
		const token = pastePlaceholderToken(text, pasteSequenceRef.current);
		pastedTextRef.current.set(token, text);
		editor.insertText(token);
	};

	const handleComposeKey = (key: KeyEvent) => {
		if (queueFocused) {
			return;
		}
		if (autocomplete) {
			if (key.name === "escape") {
				setAutocomplete(null);
				return;
			}
			if (
				key.name === "up" ||
				key.name === "down" ||
				(key.ctrl && key.name === "j")
			) {
				// The arrows (and Ctrl+J) belong to the suggestion list, not the
				// editor cursor or its newline binding.
				key.preventDefault();
			}
			if (key.name === "up" || key.name === "k") {
				setAutocomplete((state) =>
					state
						? {
								...state,
								index: moveAutocompleteIndex(
									state.index,
									-1,
									state.suggestions.length
								),
							}
						: null
				);
				return;
			}
			if (key.name === "down" || key.name === "j") {
				setAutocomplete((state) =>
					state
						? {
								...state,
								index: moveAutocompleteIndex(
									state.index,
									1,
									state.suggestions.length
								),
							}
						: null
				);
				return;
			}
			if (
				key.name === "return" &&
				runsOnEnter(
					composerInputRef.current?.plainText ?? composer,
					autocomplete.suggestions[autocomplete.index]
				)
			) {
				// A bare no-argument built-in (`/new`) runs on the first Enter;
				// Tab still completes it.
				key.preventDefault();
				submitComposer();
				return;
			}
			if (
				(key.name === "tab" || key.name === "return") &&
				applySelectedAutocomplete()
			) {
				// Stop the textarea from also submitting (or inserting a newline).
				key.preventDefault();
				return;
			}
		}
		if (key.ctrl && key.name === "q" && queuedMessages.length > 0) {
			setQueueFocused(true);
			setQueueSelectedIndex(0);
		} else if (key.ctrl && key.name === "a") {
			openAgentPicker();
		} else if (key.ctrl && key.name === "r") {
			if (simpleInterface) {
				notify(
					"Model and approval controls are available in Agent or OS.",
					"info"
				);
			} else {
				openAcpPicker();
			}
		} else if (key.ctrl && key.name === "l") {
			resetChat();
		} else if (key.ctrl && key.name === "o") {
			setExpandPrompts((value) => !value);
		} else if (resumeRecent(recentResumeIndex(key))) {
			// Resumed a recent conversation from the empty state.
		} else if (historyKeyAllowed(key)) {
			// Enter is the textarea's own submit binding; only history lives here.
			key.preventDefault();
			const draft = composerRef.current;
			updatePromptHistory((state) => {
				const next =
					key.name === "up"
						? previousPrompt(state, draft)
						: nextPrompt(state, draft);
				setComposerText(next.value);
				return next.state;
			});
		} else if (key.name === "escape" && streaming) {
			interruptTurn();
		} else if (
			key.name === "escape" &&
			queuePaused &&
			queuedMessages.length > 0
		) {
			clearQueuedMessages();
		}
	};

	// Esc mid-turn: stop the turn on Core, keep the partial reply, mark it
	// interrupted, and pause any queued prompts instead of auto-dispatching the
	// next one. The flag is set directly because updateTurnAssistant drops
	// writes once the turn aborts.
	function interruptTurn() {
		setMessages((previous) =>
			previous.map((message, index) =>
				index === previous.length - 1 && message.role === "assistant"
					? { ...message, interrupted: true }
					: message
			)
		);
		if (queuedMessages.length > 0) {
			setQueuePaused(true);
		}
		const stopped = cancelActiveTurn();
		if (!stopped) {
			// A second Esc while a Stop still waits for Core must not end the
			// wait early; that Stop clears `streaming` itself.
			if (!pendingStopRef.current) {
				setStreaming(false);
				clearTurnActivity();
			}
			return;
		}
		clearTurnActivity();
		// Stay busy until Core has answered the cancel: a prompt sent or
		// dequeued before then would start a turn on this conversation that the
		// late cancel could stop instead. Prompts entered meanwhile are queued.
		pendingStopRef.current = stopped;
		stopped.then(() => {
			if (pendingStopRef.current === stopped) {
				pendingStopRef.current = null;
			}
			if (abortRef.current === null) {
				setStreaming(false);
			}
		});
	}

	// Keyboard gated on being the focused pane's active tab.
	useKeyboard((key) => {
		if (!focused || shellKeyboardCaptured || externalOverlayId) {
			return;
		}
		if (overlay.kind === "queue" || queueFocused) {
			return;
		}
		if (overlay.kind === "agents") {
			handleAgentKey(key);
			return;
		}
		if (overlay.kind === "teams") {
			handleTeamKey(key);
			return;
		}
		if (overlay.kind === "models") {
			handleModelKey(key);
			return;
		}
		if (overlay.kind === "acp") {
			handleAcpKey(key);
			return;
		}
		if (overlay.kind === "permission") {
			handlePermissionKey(key);
			return;
		}
		if (overlay.kind === "question") {
			handleQuestionKey(key);
			return;
		}
		if (overlay.kind === "delete") {
			if (key.name === "escape" || key.name === "n") {
				setOverlay({ kind: "none" });
			} else if (key.name === "return" || key.name === "y") {
				void confirmDelete();
			}
			return;
		}
		if (overlay.kind === "help") {
			if (key.name === "escape" || key.name === "return") {
				setOverlay({ kind: "none" });
			}
			return;
		}
		if (overlay.kind === "theme") {
			return;
		}
		if (overlay.kind !== "none") {
			if (
				key.name === "escape" ||
				key.name === "return" ||
				key.name === "space"
			) {
				setOverlay({ kind: "none" });
			}
			return;
		}
		// Transcript scrolling never conflicts with text entry, so it works while
		// the composer is focused. Plain Home/End stay with the input.
		const scrollKind = transcriptScrollForKey(key);
		if (scrollKind && messages.length > 0) {
			// The composer must not also act: an option-reported Ctrl+Alt+U
			// matches its Ctrl+U (delete to line start) binding.
			key.preventDefault();
			transcriptScroll.scroll(scrollKind);
			return;
		}
		handleComposeKey(key);
	});

	const terminal = useTerminalDimensions();
	// The completion list floats upward from the composer dock, so its height
	// budget is the dock's distance from the top of the screen.
	const composerDockRef = useRef<BoxRenderable | null>(null);
	const [composerDockTop, setComposerDockTop] = useState<number | null>(null);
	const measureComposerDock = useCallback(() => {
		const top = composerDockRef.current?.y;
		if (top !== undefined) {
			setComposerDockTop(top);
		}
	}, []);
	const autocompleteOpen = autocomplete !== null;
	useEffect(() => {
		if (autocompleteOpen && terminal.height > 0) {
			measureComposerDock();
		}
	}, [autocompleteOpen, measureComposerDock, terminal.height]);
	const permissionPrompt = overlay.kind === "permission" ? overlay : null;
	// This pane owns the keyboard: no shell layer (palette, node picker,
	// sidebar focus mode, shell overlay) has taken it.
	const keysOwned = focused && !shellKeyboardCaptured && !externalOverlayId;
	const composerFocused = keysOwned && !overlayOpen && !queueFocused;

	// Ctrl+C (offered by the shell): stop a running stream, else clear a draft.
	// Returning false lets the shell arm its two-press quit. The shell decides;
	// this surface never handles Ctrl+C in its own useKeyboard.
	useInterruptHandler(() => {
		if (streaming) {
			// The same stop as Esc: keep the partial reply, mark it interrupted
			// and pause the queue.
			interruptTurn();
			return true;
		}
		const draft = composerInputRef.current?.plainText ?? composerRef.current;
		if (draft === "") {
			return false;
		}
		setComposerText("");
		pastedTextRef.current.clear();
		setAutocomplete(null);
		return true;
	}, composerFocused);

	// The busy clock lives in the pane's own StatusLine (activity, elapsed and
	// the esc hint), so Chat publishes only its key hints to the shell bar; a
	// second spinner there would repeat the row right above it.
	// The shortcuts overlay hint (F1 keys) is a shell global.
	useStatusContribution(paneId, {
		hints: simpleInterface ? [] : [CHAT_AGENT_HINT],
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<Transcript
				agent={routeAgent}
				coreDown={coreDown}
				expandPrompts={expandPrompts}
				messages={messages}
				onScrollActivity={transcriptScroll.sync}
				onVisibleRecentsChange={setVisibleRecentCount}
				pendingPermissionToolCallId={permissionPrompt?.detail.toolCallId}
				recents={recentRows}
				scrollRef={transcriptScroll.ref}
				simpleInterface={simpleInterface}
				streaming={streaming}
				team={routeTeam}
			/>
			{messages.length > 0 ? (
				<JumpToLatestStrip
					awayFromBottom={transcriptScroll.awayFromBottom}
					newCount={transcriptScroll.newCount}
					onJump={() => transcriptScroll.scroll("bottom")}
				/>
			) : null}
			<StatusLine
				activity={busyActivityLabel(overlay.kind, activeTool)}
				doubleCheckOn={doubleCheckOn}
				interruptible={composerFocused}
				startedAt={streaming ? streamStartedAt : null}
			/>
			{queuedMessages.length > 0 ? (
				<ChatQueueBar
					clearHint={queueBarClearHint(queuePaused, streaming)}
					focused={keysOwned && queueFocused && !overlayOpen}
					focusHint={
						queuePaused ? "Paused · Enter send next" : "Ctrl+Q inspect"
					}
					items={queuedMessages}
					onCancel={() => setQueueFocused(false)}
					onClear={clearQueuedMessages}
					onFocus={() => openQueue(queueSelectedIndex)}
					onMove={moveQueuedMessageAt}
					onRemove={removeQueuedMessageAt}
					onSelect={(index) => setQueueSelectedIndex(index)}
					selectedIndex={queueSelectedIndex}
				/>
			) : null}
			<WorkspaceBar
				agent={routeAgent}
				meter={simpleInterface ? "" : sessionMeter}
				model={
					simpleInterface
						? null
						: (acpModel ??
							(configuredModel?.agentId === routeAgent
								? configuredModel.model
								: null))
				}
				showModel={!simpleInterface}
				team={routeTeam}
			/>
			{/* A pending tool permission takes the composer's place. The composer
			    stays mounted but hidden so its draft and cursor survive. */}
			{permissionPrompt ? (
				<PermissionPrompt
					bodyScrollRef={permissionBodyRef}
					detail={permissionPrompt.detail}
					index={permissionPrompt.index}
					onChoose={(index) => {
						const option = permissionPrompt.permission.options[index];
						if (option) {
							submitPermission(permissionPrompt.permission, option);
						}
					}}
					permission={permissionPrompt.permission}
					terminal={terminal}
				/>
			) : null}
			{/* The completion list floats above the composer, so the transcript
			    keeps its height while suggestions change. */}
			<box
				flexDirection="column"
				flexShrink={1}
				minHeight={3}
				onSizeChange={measureComposerDock}
				ref={composerDockRef}
				visible={permissionPrompt === null}
			>
				{autocomplete ? (
					<AutocompleteView
						maxHeight={composerDockTop ?? Math.max(0, terminal.height - 4)}
						state={autocomplete}
					/>
				) : null}
				<box
					borderColor={
						composerFocused ? theme.colors.focusRing : theme.colors.border
					}
					borderStyle="rounded"
					flexDirection="row"
					// Only the composer shrinks when a tall draft, the busy row and the
					// queue overflow a short terminal; it keeps one text row and its border.
					flexShrink={1}
					gap={1}
					minHeight={3}
					paddingLeft={1}
					paddingRight={1}
				>
					<text alignSelf="flex-start" fg={theme.colors.primary} flexShrink={0}>
						{"›"}
					</text>
					<textarea
						cursorColor={theme.colors.primary}
						flexGrow={1}
						focused={composerFocused}
						// The textarea copies textColor into its focused colour only at
						// construction; pass both so a theme loaded or picked after mount
						// (light theme) recolours the draft instead of leaving it white.
						focusedTextColor={theme.colors.foreground}
						keyBindings={COMPOSER_KEY_BINDINGS}
						maxHeight={composerMaxHeight(terminal.height)}
						minHeight={1}
						onContentChange={() => {
							const value = composerInputRef.current?.plainText ?? "";
							const previousValue = composerRef.current;
							if (value === previousValue) {
								// App-driven updates (history, reset, completion) set the ref
								// first; they keep the history cursor and dismissal state.
								return;
							}
							setDismissedSlashArgumentValue(null);
							setTurnError(null);
							composerRef.current = value;
							setComposer(value);
							updatePromptHistory(resetPromptNavigation);
						}}
						onPaste={handleComposerPaste}
						onSubmit={submitComposer}
						placeholder={
							streaming
								? composerFocused
									? "Queue a follow-up… (Enter queue · Esc interrupt)"
									: "Queue a follow-up…"
								: simpleInterface
									? "Message · pinned to Ryu · /help"
									: messages.length === 0
										? starterPlaceholder
										: "Message · Ctrl+A agent · Ctrl+R ACP · /help"
						}
						placeholderColor={theme.colors.mutedForeground}
						ref={composerInputRef}
						textColor={theme.colors.foreground}
						wrapMode="word"
					/>
				</box>
			</box>
			{overlay.kind === "none" ||
			overlay.kind === "permission" ? null : overlay.kind === "queue" ? (
				<ChatQueueOverlay
					focused={keysOwned}
					items={queuedMessages}
					onCancel={() => setOverlay({ kind: "none" })}
					onClear={clearQueuedMessages}
					onMove={moveQueuedMessageAt}
					onRemove={removeQueuedMessageAt}
					onSelect={(index) => {
						setQueueSelectedIndex(index);
						setOverlay((state) =>
							state.kind === "queue" ? { ...state, index } : state
						);
					}}
					selectedIndex={queueSelectedIndex}
				/>
			) : (
				// Pickers, help and the keymap render as a pane-local Modal (absolute
				// over this surface); permission and question stay docked in flow.
				<OverlayView
					focused={keysOwned}
					onClose={() => setOverlay({ kind: "none" })}
					overlay={overlay}
				/>
			)}
		</box>
	);
}

/** The unfocused queue bar's second hint: Esc pauses mid-turn, clears when
 * paused. While unfocused, `c` types into the composer, so it is not shown. */
function queueBarClearHint(paused: boolean, streaming: boolean): string {
	if (paused) {
		return "Esc clear queue";
	}
	return streaming ? "Esc interrupt (queue pauses)" : "";
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

function resumedChatParts(message: ResumedConversationMessage): ChatPart[] {
	const parsed = chatPartsSchema.safeParse(message.parts);
	// A resumed turn is never streaming live, so a tool persisted mid-call
	// can only have been cut off; show it as interrupted instead of spinning.
	return parsed.success && parsed.data.length > 0
		? settleRunningToolParts(parsed.data, "interrupted")
		: [{ type: "text", text: message.content }];
}
