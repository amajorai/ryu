// Shared shape of the Chat surface's state. ChatSurface (index.tsx) owns the
// state; the index-* hooks each take the slice they read through `Pick`.

import type {
	KeyEvent,
	PasteEvent,
	ScrollBoxRenderable,
	TextareaRenderable,
} from "@opentui/core";
import type { ApiTarget } from "@ryuhq/core-client/client";
import type { Workflow } from "@ryuhq/core-client/workflows";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { useTheme } from "@/components/ui/theme-provider.tsx";
import type { AutocompleteState } from "../../core/autocomplete.ts";
import type { useChatIntent } from "../../core/ChatIntentContext.tsx";
import type { useContributions } from "../../core/ContributionsContext.tsx";
import type { useCoreHealth } from "../../core/CoreHealthContext.tsx";
import type {
	ChatPermission,
	ChatPermissionOption,
} from "../../core/chatPermission.ts";
import type { QueuedChatTurn } from "../../core/chatQueue.ts";
import type { ChatStreamOptions } from "../../core/chatStream.ts";
import type { CommandAction } from "../../core/commands.ts";
import type { AgentSlashCommand } from "../../core/contributions.ts";
import type { ConversationRow } from "../../core/conversations.ts";
import type { HerdrState, takeStartupResume } from "../../core/herdr.ts";
import type { SelectedHumanMention } from "../../core/humanMentions.ts";
import type { useSetInputFocused } from "../../core/InputFocusContext.tsx";
import type {
	coreHistorySealer,
	PromptHistoryState,
} from "../../core/promptHistory.ts";
import type { useOverlay } from "../../overlays/OverlayHost.tsx";
import type { useTerminalTheme } from "../../ui/TerminalThemeProvider.tsx";
import type { useToast } from "../../ui/toast.tsx";
import type { ConfiguredModel } from "./index-constants.ts";
import type { TranscriptScrollState } from "./transcriptScroll.tsx";
import type { Message, Overlay } from "./types.ts";

type SetState<T> = Dispatch<SetStateAction<T>>;
type Contributions = ReturnType<typeof useContributions>;
type TerminalTheme = ReturnType<typeof useTerminalTheme>;
type QueueDirection = "up" | "down";

export interface WorkflowDirectory {
	target: { token: string | null; url: string; userJwt: string | null };
	workflows: Workflow[];
}

export interface HerdrTurn {
	id: symbol;
	report: (state: HerdrState, message?: string) => void;
}

/** State and refs ChatSurface declares before handing off to its hooks. */
export interface ChatSurfaceState {
	abortRef: RefObject<AbortController | null>;
	acpConfig: Record<string, string>;
	acpMode: string | null;
	acpModel: string | null;
	active: boolean;
	activeAcpCommands: AgentSlashCommand[];
	activeTool: string | null;
	activeToolsRef: RefObject<Map<string, string>>;
	autocomplete: AutocompleteState | null;
	availableModes: TerminalTheme["availableModes"];
	availablePresets: TerminalTheme["availablePresets"];
	chatIntent: ReturnType<typeof useChatIntent>["pending"];
	clearChatIntent: ReturnType<typeof useChatIntent>["clear"];
	composer: string;
	composerInputRef: RefObject<TextareaRenderable | null>;
	composerRef: RefObject<string>;
	configuredModel: ConfiguredModel | null;
	configuredModelRef: RefObject<ConfiguredModel | null>;
	contributedSlashCommands: Contributions["slashCommands"];
	conversationIdRef: RefObject<string>;
	conversationTitle: string | null;
	coreDown: boolean;
	dismissedSlashArgumentValue: string | null;
	doubleCheckOn: boolean;
	expandPrompts: boolean;
	externalOverlayId: ReturnType<typeof useOverlay>["openId"];
	focused: boolean;
	herdrId: RefObject<symbol>;
	herdrTurn: RefObject<HerdrTurn | null>;
	historyLoadedUrlRef: RefObject<string | null>;
	historySealer: ReturnType<typeof coreHistorySealer> | null;
	historyTargetUrl: string;
	latestResumeIdentity: RefObject<string>;
	messages: Message[];
	messagesRef: RefObject<Message[]>;
	notify: ReturnType<typeof useToast>["notify"];
	openOverlay: ReturnType<typeof useOverlay>["openOverlay"];
	overlay: Overlay;
	overlayOpen: boolean;
	paneHasManyTabs: boolean;
	paneId: string;
	pastedTextRef: RefObject<Map<string, string>>;
	pasteSequenceRef: RefObject<number>;
	pendingStopRef: RefObject<Promise<void> | null>;
	queuedMessages: QueuedChatTurn[];
	queueFocused: boolean;
	queuePaused: boolean;
	queueSelectedIndex: number;
	recentRows: ConversationRow[];
	recheckHealth:
		| NonNullable<ReturnType<typeof useCoreHealth>>["recheck"]
		| undefined;
	reloadContributions: Contributions["reload"];
	resumeIdentity: string;
	resumeRequestSequence: RefObject<number>;
	routeAgent: string | null;
	routeTeam: string | null;
	scrollTranscript: TranscriptScrollState["scroll"];
	selectedAgent: string | null;
	selectedTeam: string | null;
	sessionMeter: string;
	setAcpConfig: SetState<Record<string, string>>;
	setAcpMode: SetState<string | null>;
	setAcpModel: SetState<string | null>;
	setActiveTool: SetState<string | null>;
	setAdvertisedAcpCommands: SetState<Record<string, AgentSlashCommand[]>>;
	setAutocomplete: SetState<AutocompleteState | null>;
	setComposer: SetState<string>;
	setComposerText: (value: string) => void;
	setConversationTitle: SetState<string | null>;
	setDismissedSlashArgumentValue: SetState<string | null>;
	setDoubleCheckOn: SetState<boolean>;
	setExpandPrompts: SetState<boolean>;
	setInputFocused: ReturnType<typeof useSetInputFocused>;
	setMessages: SetState<Message[]>;
	setOverlay: SetState<Overlay>;
	setQueuedMessages: SetState<QueuedChatTurn[]>;
	setQueueFocused: SetState<boolean>;
	setQueuePaused: SetState<boolean>;
	setQueueSelectedIndex: SetState<number>;
	setSelectedAgent: SetState<string | null>;
	setSelectedTeam: SetState<string | null>;
	setStarterPlaceholder: SetState<string>;
	setStreaming: SetState<boolean>;
	setStreamStartedAt: SetState<number | null>;
	setThemeMode: TerminalTheme["setMode"];
	setThemePreset: TerminalTheme["setPreset"];
	setTurnError: SetState<string | null>;
	setVisibleRecentCount: SetState<number>;
	setWorkflowDirectory: SetState<WorkflowDirectory | null>;
	shellKeyboardCaptured: boolean;
	simpleInterface: boolean;
	slashCommandState: Contributions["slashCommandState"];
	starterPlaceholder: string;
	startupResume: ReturnType<typeof takeStartupResume>;
	streaming: boolean;
	streamStartedAt: number | null;
	target: ApiTarget;
	teamPickerRequestRef: RefObject<number>;
	theme: ReturnType<typeof useTheme>;
	transcriptScroll: TranscriptScrollState;
	turnConversationRef: RefObject<string | undefined>;
	turnError: string | null;
	updatePromptHistory: (
		update: (state: PromptHistoryState) => PromptHistoryState
	) => void;
	visibleRecentCount: number;
	workflowDirectory: WorkflowDirectory | null;
}

/** What the index-* hooks add on top of the surface state. */
export interface ChatSurfaceActions {
	applyCommandAction: (action: CommandAction) => boolean;
	applySelectedAutocomplete: () => boolean;
	applyThemeArgument: (argument: string) => boolean;
	buildOptions: () => ChatStreamOptions;
	buildOptionsForPrompt: (text: string) => ChatStreamOptions;
	cancelActiveTurn: () => Promise<void> | null;
	clearQueuedMessages: () => void;
	clearTurnActivity: () => void;
	handleAcpKey: (key: KeyEvent) => void;
	handleAgentKey: (key: KeyEvent) => void;
	handleCommand: (raw: string) => boolean;
	handleComposerPaste: (event: PasteEvent) => void;
	handleModelKey: (key: KeyEvent) => void;
	handlePermissionKey: (key: KeyEvent) => void;
	handleQuestionKey: (key: KeyEvent) => void;
	handleTeamKey: (key: KeyEvent) => void;
	interruptTurn: () => void;
	loadTeams: (requestId: number) => void;
	moveQueuedMessage: (id: string, direction: QueueDirection) => void;
	moveQueuedMessageAt: (index: number, direction: QueueDirection) => void;
	notifySelectedHumanMentions: (content: string) => void;
	openAcpPicker: () => void;
	openAgentPicker: () => void;
	openModelPicker: () => void;
	openQueue: (index?: number) => void;
	openTeamPicker: () => void;
	openTheme: (argument?: string) => void;
	permissionBodyRef: RefObject<ScrollBoxRenderable | null>;
	pushPluginNote: (text: string) => void;
	removeQueuedMessageAt: (index: number) => void;
	resetChat: () => void;
	runBtw: (arg: string) => void;
	runDelete: (conversationId: string) => void;
	runFork: (messageId: string) => void;
	runPin: (pinned: boolean) => void;
	runRename: (title: string) => void;
	runResume: (conversationId: string) => void;
	runSessions: () => void;
	runTeam: (arg: string) => void;
	selectedHumanMentionsRef: RefObject<SelectedHumanMention[]>;
	send: (text: string, optionsOverride?: ChatStreamOptions) => void;
	submitComposer: () => void;
	submitPermission: (
		permission: ChatPermission,
		option: ChatPermissionOption
	) => void;
	toggleDoubleCheck: () => void;
	workflowsRef: RefObject<Workflow[]>;
}

export type ChatSurfaceContext = ChatSurfaceState & ChatSurfaceActions;
