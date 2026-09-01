import type { ChatStatus, UIMessage } from "ai";
import type React from "react";
import type { AnswerNowControl } from "./answer-now.ts";
import type { GoalCompletion } from "./goal-message.ts";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "./input/composer-menu.tsx";
import type { SuggestionItem } from "./input/suggestions.tsx";
import type { LinkPreviewResolvers } from "./link-preview.tsx";
import type { MemoryCitation } from "./memory-citations.ts";
import type { MessageReactionBucket } from "./message-reactions.tsx";
import type {
	QuestionAnswer,
	QuestionConfig,
} from "./question/question-prompt.tsx";
import type { StatsUsageSnapshot } from "./stats-model.ts";
import type { FileEditUndoPlan } from "./turn-end-cards.ts";

export type InputSuggestions =
	| SuggestionItem[]
	| {
			items: SuggestionItem[];
			className?: string;
			itemClassName?: string;
	  };

export type AgentUiSubmit = (value: unknown) => void | Promise<void>;

export interface MentionItem {
	/** Accent used for the inline token when the mention belongs to an app. */
	accentColor?: string;
	icon?: React.ReactNode;
	id?: string;
	kind: string;
	label: string;
	/** Optional host destination for a contributed/app-owned mention. */
	target?: {
		options?: { conversationId?: string };
		path: string;
	};
	/** App-owned artwork, kept as a node so hosts can reuse their canonical icon. */
	visualIcon?: React.ReactNode;
}

export interface ChatTheme {
	dark: Record<string, string>;
	light: Record<string, string>;
	theme: Record<string, string>;
}

export interface ChatClassNames {
	inputBar: string;
	/** Applied to the scrollable message-list container (e.g. top padding so the
	 *  conversation clears an overlapping titlebar while scrolling under it). */
	messageList: string;
	root: string;
	userMessage: string;
}

export interface CustomToolRendererProps {
	input: Record<string, unknown>;
	name: string;
	output: unknown | undefined;
	status: "pending" | "streaming" | "success" | "error";
}

/** Identity data used by transcript surfaces that render agent-to-agent work. */
export interface AgentMessageIdentity {
	avatar?: React.ReactNode;
	id: string;
	name: string;
}

/** Host-provided agent identities for the agent-comms transcript renderer. */
export interface AgentMessageContext {
	current?: AgentMessageIdentity;
	resolve?: (id: string) => AgentMessageIdentity | undefined;
}

/** CSP hints a widget's MCP server may declare. Ignored as network grants in v1
 *  (D3): `connect-src` is hard-pinned to `'none'` and `resource_domains` is not
 *  honored, so both fields are wire-completeness only. */
export interface WidgetCsp {
	connect_domains?: string[];
	resource_domains?: string[];
}

/** The `data` payload of a `data-tool-widget-available` stream part. Per D6 the
 *  fields live under `.data` (never flat on the part), matching the `ui_data`
 *  wire shape Core emits. Core mints the instance, strips `ryu/widget` from
 *  `_meta`, and maps Apps-SDK names (`structuredContent -> toolOutput`, etc.). */
export interface WidgetAvailableData {
	approvedGrants: string[];
	displayMode?: "inline" | "fullscreen" | "pip";
	initialWidgetState?: unknown;
	instanceId: string;
	invoked?: string;
	invoking?: string;
	maxHeight?: number;
	serverId: string;
	templateUri: string;
	toolCallId: string;
	toolInput: unknown;
	toolName: string;
	toolOutput: unknown;
	toolResponseMetadata: unknown;
	widget: { html: string; mimeType: string; csp?: WidgetCsp };
	widgetAccessible: boolean;
}

/** A widget stream part, nested under `.data` (D6). Follows the shared
 *  `toolCallId`'s `tool-input-available` -> `tool-output-available` parts; a
 *  client that ignores it degrades to today's tool row. */
export interface WidgetAvailablePart {
	data: WidgetAvailableData;
	type: "data-tool-widget-available";
}

/** Server-verified attribution for a widget-injected user turn. */
export interface WidgetMessageAttribution {
	origin_server: string;
	source: "widget";
	widget_instance_id: string;
}

/** Read the server-verified widget provenance carried by a user message. */
export function getWidgetMessageAttribution(
	message: UIMessage
): WidgetMessageAttribution | null {
	const value = message as UIMessage & {
		metadata?: unknown;
		originServer?: unknown;
		source?: unknown;
		widgetInstanceId?: unknown;
	};
	const metadata =
		typeof value.metadata === "object" && value.metadata !== null
			? (value.metadata as Record<string, unknown>)
			: null;
	const source = metadata?.source ?? value.source;
	const instanceId = metadata?.widget_instance_id ?? value.widgetInstanceId;
	const originServer = metadata?.origin_server ?? value.originServer;
	if (
		source !== "widget" ||
		typeof instanceId !== "string" ||
		typeof originServer !== "string" ||
		instanceId.length === 0 ||
		originServer.length === 0
	) {
		return null;
	}
	return {
		origin_server: originServer,
		source: "widget",
		widget_instance_id: instanceId,
	};
}

/** Stable comparison key used to keep widget labels inside their own run. */
export function widgetMessageProvenanceKey(message: UIMessage): string | null {
	const attribution = getWidgetMessageAttribution(message);
	return attribution
		? `${attribution.source}:${attribution.origin_server}:${attribution.widget_instance_id}`
		: null;
}

/** The desktop-authored component that renders a live app widget in a sandboxed
 *  iframe. `packages/blocks` cannot import it (it lives in `apps/desktop`), so it
 *  is injected via `slots.WidgetRenderer` and the WidgetHostContext. */
export type WidgetRendererComponent = React.ComponentType<{
	part: WidgetAvailablePart;
}>;

export interface ChatSlots {
	InputBar: React.ComponentType<{
		onSend: (message: { role: "user"; content: string }) => void;
		status: ChatStatus;
		onStop: () => void;
		[key: string]: unknown;
	}>;
	ToolRenderer: React.ComponentType<{
		agentMessageContext?: AgentMessageContext;
		part: {
			type: string;
			toolCallId?: string;
			state?: string;
			input?: unknown;
			output?: unknown;
			result?: unknown;
		};
		nestedTools?: {
			type: string;
			toolCallId?: string;
			state?: string;
			input?: unknown;
			output?: unknown;
			result?: unknown;
		}[];
		chatStatus?: string;
		toolRenderers?: Record<
			string,
			React.ComponentType<CustomToolRendererProps>
		>;
	}>;
	UserMessage: React.ComponentType<{
		/** Hover actions for the turn (copy / edit / branch). A replacement
		 *  UserMessage must render this beside its bubble row, otherwise the surface
		 *  silently loses its toolbar. */
		actions?: React.ReactNode;
		message: UIMessage;
		className?: string;
		messageActionState?: MessageActionRuntimeState;
		messageActions?: ContributedMessageAction[];
		onContributedMessageAction?: (
			action: ContributedMessageAction,
			context: MessageActionContext
		) => void;
		onOpenFile?: (path: string) => void;
		onOpenLink?: (url: string) => void;
		onOpenMention?: (item: MentionItem) => void;
		previewResolvers?: LinkPreviewResolvers;
	}>;
	/** Renders a live app widget for `data-tool-widget-available` parts. Supplied
	 *  by apps/desktop (the concrete `AppWidget`), reached inside the default tool
	 *  renderer via WidgetHostContext. When absent, widgets degrade to a plain
	 *  tool row. */
	WidgetRenderer?: WidgetRendererComponent;
}

/**
 * Replaces the normal composer with a voice-mode surface while a live call is
 * active. The surface receives the exact composer node AgentChat owns, so draft
 * state and send behavior stay shared with the regular chat path.
 */
export type ChatVoiceMode =
	| { active: false }
	| {
			active: true;
			render: (composer: React.ReactNode) => React.ReactNode;
	  };

export interface ModelOption {
	id: string;
	name: string;
	version?: string;
}

/** A per-message toolbar action contributed by an enabled plugin
 *  (`contributes.message_actions`), resolved by the shell and passed in
 *  presentationally. Blocks never fetches the contributions feed. */
export interface ContributedMessageAction {
	args?: Record<string, unknown>;
	capability?: string;
	icon?: string;
	id: string;
	kind: string;
	label: string;
	order?: number;
	plugin: string;
	states?: {
		active_icon?: string;
		icon?: string;
		label: string;
		value: string;
	}[];
	target: string;
}

/** A button contributed to the floating text-selection toolbar by an enabled
 * plugin (`contributes.selection_actions`). Blocks renders the declaration and
 * forwards the selected text; the host owns dispatch. */
export interface ContributedSelectionAction {
	args?: Record<string, unknown>;
	capability?: string;
	icon?: string;
	id: string;
	kind: string;
	label: string;
	order?: number;
	plugin: string;
}

/** The message identity and optional value a contributed action receives. */
export interface MessageActionContext {
	messageId: string;
	value?: string;
}

/** The plain text a contributed selection action receives. */
export interface SelectionActionContext {
	text: string;
}

/** The message identity and visible turn distance behind a reply action. */
export interface MessageReply {
	chainLength: number;
	messageId: string;
	text: string;
}

/** Runtime state supplied by the host to a contributed message-action renderer. */
export interface MessageActionRuntimeState {
	memoryCitations?: readonly MemoryCitation[];
	reactionBuckets?: readonly MessageReactionBucket[];
	/** Current value for each contributed toggle-group action, keyed by action id. */
	toggleValues?: Readonly<Record<string, string>>;
}

export interface AgentChatProps {
	/** Agent identities used when an agent-comms tool becomes a transcript activity. */
	agentMessageContext?: AgentMessageContext;
	/** Native-provider action shown below the active thinking row. */
	answerNow?: AnswerNowControl;
	/** Avatar node shown beside each assistant turn — the active agent's logo, or
	 * a fanned stack of member logos for a team. When omitted, no avatar shows. */
	assistantAvatar?: React.ReactNode;
	/** Display name shown above each assistant turn (agent or team name). */
	assistantName?: string;
	/** Marks for the agents working on the live turn, drawn side by side in the
	 * status row. Defaults to `assistantAvatar` alone. */
	assistantPlanningAvatars?: React.ReactNode[];
	/** Optional role/title badge shown beside the assistant name. */
	assistantTitle?: string;
	attachments?: {
		onAttach?: () => void;
		images?: {
			id: string;
			filename: string;
			url: string;
			mimeType?: string;
			size?: number;
		}[];
		files?: { id: string; filename: string; size?: number }[];
		onRemoveImage?: (id: string) => void;
		onRemoveFile?: (id: string) => void;
		onPaste?: (e: React.ClipboardEvent) => void;
		isDragOver?: boolean;
	};

	className?: string;
	classNames?: Partial<ChatClassNames>;
	/** Disable the shared composer while its host surface is unavailable. */
	composerDisabled?: boolean;
	/** Small host-owned action strip rendered below the shared composer. */
	composerFooter?: React.ReactNode;
	/** Searchable directory rows shared by the composer `+` menu and `@` tokens. */
	composerMenuGroups?: ComposerMenuGroup[];
	/** An active human-input card that temporarily replaces this chat's composer. */
	composerPrompt?: {
		content: React.ReactNode;
		id: string;
	};
	/**
	 * The active model's context window in tokens. Drives the per-message
	 * context-usage ring in each completed assistant turn's stats footer.
	 */
	contextSize?: number;
	/** Identity of the thread being shown. Fires the open-at-bottom jump once per
	 * conversation; pass the conversation id when the surface has one. */
	conversationKey?: string;
	/** Current signed-in user info for displaying avatar/name on own messages. */
	currentUser?: {
		avatar?: string;
		name?: string;
		id?: string;
	};
	/** Density override for narrow hosts such as the island and side-chat rail. */
	density?: "comfortable" | "compact";
	/** Project-scoped saved drafts exposed by the host composer. */
	draftControls?: import("./input-bar.tsx").ComposerDraftControls;
	/** Rendered below the composer in the centered empty state (e.g. a recent
	 * chats list, Codex-style). Ignored once the thread has messages. */
	emptyStateFooter?: React.ReactNode;
	/** Rendered above the composer in the centered empty state (e.g. a greeting
	 * heading on the home view). Ignored once the thread has messages. */
	emptyStateHeader?: React.ReactNode;
	emptyStatePosition?: "default" | "center";
	emptySuggestionsPlacement?: "input" | "empty" | "both";
	emptySuggestionsPosition?: "top" | "bottom";
	enableImagePreview?: boolean;
	error?: Error;
	/** ChatGPT-style next-prompt chips shown between the transcript and the
	 * composer once the assistant finishes a turn. Unlike the empty-state
	 * `suggestions` (which only seed the draft), selecting a follow-up runs it
	 * immediately via `onSelect`. Hidden while a turn is streaming and in the
	 * empty state. */
	followUps?: {
		items: SuggestionItem[];
		onSelect: (item: SuggestionItem) => void;
	};
	/** Completion data shown on the assistant turn that finished the goal. */
	goalCompletion?: GoalCompletion;
	/** True when a page older than the visible transcript is available. */
	hasOlderMessages?: boolean;
	/** This thread's persisted history could not be fetched — the node was
	 * unreachable or answered an error. A THIRD state, distinct from both "empty"
	 * and "has messages": the transcript area says so (with an optional retry)
	 * instead of showing the new-chat greeting, which reads as "your chat is
	 * gone". Ignored once there are messages to render. */
	historyError?: {
		description?: string;
		onRetry?: () => void;
		title: string;
	};
	/** This thread's persisted history is still being fetched. Suppresses the
	 * empty state — a restored tab must never paint as a brand-new chat while its
	 * messages are still in flight — and shows a skeleton transcript instead.
	 * Must be false for a genuinely new chat (no conversation id), or the
	 * greeting never appears. */
	historyLoading?: boolean;
	/** Non-model notice rendered in the checkpoint-line style after messages. */
	historyNotice?: {
		id: string;
		title: string;
		description?: string;
		actions?: {
			label: string;
			onClick: () => void;
		}[];
	};
	/** Compact host-owned notice rendered inside the composer frame. */
	infoBar?: import("./input-bar.tsx").InputBarInfoBar;
	initialScrollBehavior?: "bottom" | "top";
	/** True while the transcript is fetching the page above the current one. */
	loadingOlderMessages?: boolean;
	/** Resolved @ mentions used by the composer and transcript renderer. */
	mentionItems?: MentionItem[];
	/** Runtime state keyed by message id for contributed message-action renderers. */
	messageActionStates?: ReadonlyMap<string, MessageActionRuntimeState>;
	/** Contributed per-message toolbar actions (resolved by the shell from
	 *  `contributes.message_actions`, filtered to the message's `target`), rendered
	 *  after the built-in toolbar buttons. Dispatches through
	 *  {@link AgentChatProps.onContributedMessageAction}. */
	messageActions?: ContributedMessageAction[];
	messages: UIMessage[];
	/** Submit a value from an agent-rendered UI as a new chat message. */
	onAgentUiSubmit?: AgentUiSubmit;
	/** Branch ("fork into new chat") from a message; receives the message id to
	 * branch from. When omitted, no branch button is shown. */
	onBranch?: (messageId: string) => void;
	/** Clear the pending composer quote (dismiss button). */
	onClearQuote?: () => void;
	/** Apply a selection made from the shared composer directory. */
	onComposerMenuSelect?: (item: ComposerMenuItem) => void;
	/** Report the shared composer's measured height to a compact host surface. */
	onComposerResize?: (height: number) => void;
	/** Fire a contributed message action with the message identity and optional
	 *  selected value. The shell dispatches it through the owning plugin seam. */
	onContributedMessageAction?: (
		action: ContributedMessageAction,
		context: MessageActionContext
	) => void;
	/** Fire a contributed text-selection action with the selected plain text. */
	onContributedSelectionAction?: (
		action: ContributedSelectionAction,
		context: SelectionActionContext
	) => void;
	/** Notified whenever the composer's text changes, including when a send clears
	 * it (called with `""`). Deliberately generic: the surface decides what an
	 * unsent draft is worth — the desktop persists it through `@ryu/drafts` so it
	 * survives the tab, another surface may ignore it entirely. This component
	 * still OWNS the text; the callback only observes it. Debounce on your side —
	 * this fires per keystroke. */
	onDraftChange?: (draft: string) => void;
	/** Edit a previously-sent user message into a new version (ChatGPT/Claude-style
	 * branching); receives the message id and the new text. When omitted, no edit
	 * affordance is shown. */
	onEditMessage?: (messageId: string, newText: string) => void;
	/** Request the next older message page when the viewport reaches the top. */
	onLoadOlderMessages?: () => Promise<void>;

	/**
	 * Open the full context-window breakdown (the workspace Context tab). When
	 * provided, the composer's context ring becomes a button; omit it and the
	 * ring stays a read-only readout, which is what surfaces with no workspace
	 * docks (island, extension) want.
	 */
	onOpenContext?: () => void;
	/** Open a project file referenced by assistant output or tool summaries. */
	onOpenFile?: (path: string) => void;
	/** Open an external website link through the host's preferred browser surface. */
	onOpenLink?: (url: string) => void;
	/** Open a resolved @ mention through the host's navigation surface. */
	onOpenMention?: (item: MentionItem) => void;
	/** Quote a text selection in a message. When provided, selecting message text
	 * surfaces a floating "Quote" button; clicking it calls this with the selected
	 * plain text (the surface stashes it as the pending `quote`). */
	onQuote?: (text: string) => void;
	/** Regenerate an assistant reply as a new version; receives the assistant
	 * message id. When omitted, no regenerate button is shown. */
	onRegenerateMessage?: (messageId: string) => void;
	/** Reply to a complete message and receive its identity plus turn distance. */
	onReply?: (reply: MessageReply) => void;
	/** Retry the current live request after a terminal chat error. The host clears
	 * its transport error and re-sends the already-persisted user turn. */
	onRetryError?: () => void;
	/** Re-run a failed inline media generation; receives the assistant message
	 * holding the failed part, which media surface it is, and the prompt that
	 * produced it. Client-only generations are not persisted, so
	 * `onRegenerateMessage` (which branches a server-side turn) cannot serve
	 * them. When omitted, a failed generation shows no Retry. */
	onRetryGeneration?: (
		messageId: string,
		kind: "image" | "video",
		prompt: string
	) => void;
	/** Review current changes only in files touched by the completed turn. */
	onReviewFileEdits?: (paths: string[]) => void;
	/** Called after a seed has been applied so a host can clear its one-shot value. */
	onSeedDraftConsumed?: () => void;
	/** Switch the active version at a branch point; receives the target version's
	 * message id. When omitted (or a turn has a single version), no pager shows. */
	onSelectVersion?: (versionId: string) => void;
	onSend: (message: { role: "user"; content: string }) => void;
	/** Speak an assistant message aloud (text-to-speech). When provided, a speaker
	 * button is shown in each assistant turn's hover toolbar; clicking it calls this
	 * with the turn's combined text. When omitted, no speak button is shown. */
	onSpeak?: (text: string) => void;
	onStop: () => void;
	/** Reverse a fully representable text-edit turn without restoring whole files. */
	onUndoFileEdits?: (plan: FileEditUndoPlan) => Promise<void>;
	/** Resume a workflow suspended at a human-input gate. The host owns the
	 *  Core-backed API; blocks only renders and forwards the response payload. */
	onWorkflowResume?: (runId: string, payload: string) => Promise<unknown>;
	/** Lazy metadata/file loaders used by link hover previews. */
	previewResolvers?: LinkPreviewResolvers;

	questionTool?: {
		submitLabel?: string;
		skipLabel?: string;
		allowSkip?: boolean;
		onAnswer?: (payload: {
			toolCallId?: string;
			question: QuestionConfig;
			answer: QuestionAnswer;
		}) => void;
	};
	/** Pending quote shown inside the composer, above the textarea. The surface
	 * prepends it to the outgoing message on send. */
	quote?: string | null;
	/** Message id currently selected by the desktop chat-local search. */
	searchActiveMessageId?: string;
	/** Pre-fills the composer once when it transitions to a non-empty value (e.g.
	 * a `ryu://chat/new?prompt=…` deep link). Never sends — the user reviews and
	 * submits. Subsequent user edits are not clobbered. */
	seedDraft?: string;
	/** Contributed text-selection toolbar actions (resolved by the shell from
	 * `contributes.selection_actions`) rendered in the floating selection toolbar. */
	selectionActions?: ContributedSelectionAction[];

	showCopyToolbar?: boolean;
	slots?: Partial<ChatSlots>;
	/** Model id used for context-window hint parsing in the stats plugin. */
	statsModelName?: string;
	/** Enabled-plugin gate for the host-rendered session statistics feature. */
	statsPluginEnabled?: boolean;
	/** Active provider's normalized subscription usage, when Core exposes it. */
	statsUsage?: StatsUsageSnapshot | null;
	status: ChatStatus;
	style?: React.CSSProperties;
	suggestions?: InputSuggestions;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
	/** Version-pager data keyed by message id: how many versions exist at this
	 * branch point, which is active, and the ordered sibling ids to step through. */
	versions?: Record<string, { index: number; count: number; ids: string[] }>;
	/** Active voice-mode surface that temporarily owns the shared composer. */
	voiceMode?: ChatVoiceMode;
}

export type AnAgentChatProps = AgentChatProps;
export type AnClassNames = ChatClassNames;
export type AnSlots = ChatSlots;
export type AnModelOption = ModelOption;
