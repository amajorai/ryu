import type { ChatStatus, UIMessage } from "ai";
import type React from "react";
import type { SuggestionItem } from "./input/suggestions.tsx";
import type {
	QuestionAnswer,
	QuestionConfig,
} from "./question/question-prompt.tsx";

export type InputSuggestions =
	| SuggestionItem[]
	| {
			items: SuggestionItem[];
			className?: string;
			itemClassName?: string;
	  };

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
		message: UIMessage;
		className?: string;
	}>;
	/** Renders a live app widget for `data-tool-widget-available` parts. Supplied
	 *  by apps/desktop (the concrete `AppWidget`), reached inside the default tool
	 *  renderer via WidgetHostContext. When absent, widgets degrade to a plain
	 *  tool row. */
	WidgetRenderer?: WidgetRendererComponent;
}

export interface ModelOption {
	id: string;
	name: string;
	version?: string;
}

export interface AgentChatProps {
	/** Avatar node shown beside each assistant turn — the active agent's logo, or
	 * a fanned stack of member logos for a team. When omitted, no avatar shows. */
	assistantAvatar?: React.ReactNode;
	/** Display name shown above each assistant turn (agent or team name). */
	assistantName?: string;
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
	/**
	 * The active model's context window in tokens. Drives the per-message
	 * context-usage ring in each completed assistant turn's stats footer.
	 */
	contextSize?: number;
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
	/** Persisted thumbs state keyed by assistant message id (lit thumbs). */
	feedback?: Record<string, "up" | "down">;
	/** ChatGPT-style next-prompt chips shown between the transcript and the
	 * composer once the assistant finishes a turn. Unlike the empty-state
	 * `suggestions` (which only seed the draft), selecting a follow-up runs it
	 * immediately via `onSelect`. Hidden while a turn is streaming and in the
	 * empty state. */
	followUps?: {
		items: SuggestionItem[];
		onSelect: (item: SuggestionItem) => void;
	};
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
	initialScrollBehavior?: "bottom" | "top";
	messages: UIMessage[];
	/** Branch ("fork into new chat") from a message; receives the message id to
	 * branch from. When omitted, no branch button is shown. */
	onBranch?: (messageId: string) => void;
	/** Clear the pending composer quote (dismiss button). */
	onClearQuote?: () => void;
	/** Edit a previously-sent user message into a new version (ChatGPT/Claude-style
	 * branching); receives the message id and the new text. When omitted, no edit
	 * affordance is shown. */
	onEditMessage?: (messageId: string, newText: string) => void;
	/** Thumbs 👍/👎 an assistant turn; receives the turn's last message id, the new
	 * rating (`null` clears), and whether this is the latest turn (so a live reply
	 * still under a client id can be resolved server-side). When omitted, no thumbs
	 * buttons are shown. */
	onFeedback?: (
		messageId: string,
		rating: "up" | "down" | null,
		isLatest: boolean
	) => void;
	/** Open a project file referenced by assistant output or tool summaries. */
	onOpenFile?: (path: string) => void;
	/** Quote a text selection in a message. When provided, selecting message text
	 * surfaces a floating "Quote" button; clicking it calls this with the selected
	 * plain text (the surface stashes it as the pending `quote`). */
	onQuote?: (text: string) => void;
	/** Regenerate an assistant reply as a new version; receives the assistant
	 * message id. When omitted, no regenerate button is shown. */
	onRegenerateMessage?: (messageId: string) => void;
	/** Switch the active version at a branch point; receives the target version's
	 * message id. When omitted (or a turn has a single version), no pager shows. */
	onSelectVersion?: (versionId: string) => void;
	onSend: (message: { role: "user"; content: string }) => void;
	/** Speak an assistant message aloud (text-to-speech). When provided, a speaker
	 * button is shown in each assistant turn's hover toolbar; clicking it calls this
	 * with the turn's combined text. When omitted, no speak button is shown. */
	onSpeak?: (text: string) => void;
	onStop: () => void;

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
	/** Pre-fills the composer once when it transitions to a non-empty value (e.g.
	 * a `ryu://chat/new?prompt=…` deep link). Never sends — the user reviews and
	 * submits. Subsequent user edits are not clobbered. */
	seedDraft?: string;

	showCopyToolbar?: boolean;
	slots?: Partial<ChatSlots>;
	status: ChatStatus;
	style?: React.CSSProperties;
	suggestions?: InputSuggestions;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
	/** Version-pager data keyed by message id: how many versions exist at this
	 * branch point, which is active, and the ordered sibling ids to step through. */
	versions?: Record<string, { index: number; count: number; ids: string[] }>;
}

export type AnAgentChatProps = AgentChatProps;
export type AnClassNames = ChatClassNames;
export type AnSlots = ChatSlots;
export type AnModelOption = ModelOption;
