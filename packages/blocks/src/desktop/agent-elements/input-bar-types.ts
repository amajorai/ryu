import type { ChatStatus } from "ai";
import type { ContextUsage } from "./context-usage.tsx";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "./input/composer-menu.tsx";
import type { GoalBarProps } from "./input/goal-bar.tsx";
import type {
	DoubleCheckControls,
	GhostControls,
	GoalControls,
	PluginComposerControlRow,
} from "./input/goal-plus-button.tsx";
import type { SuggestionItem } from "./input/suggestions.tsx";
import type {
	QuestionAnswer,
	QuestionConfig,
} from "./question/question-prompt.tsx";
import type { QueueBarProps } from "./queue/queue-bar.tsx";
import type { MentionItem } from "./types.ts";

export interface AttachedImage {
	filename: string;
	id: string;
	mimeType?: string;
	size?: number;
	url: string;
}

export interface ComposerDraftItem {
	id: string;
	preview: string;
	text: string;
}
export interface ComposerDraftControls {
	items: ComposerDraftItem[];
	onDelete: (id: string) => void;
	onInsert?: (text: string) => void;
	onSave: (text: string) => Promise<void> | void;
}

/** Explicit promotion action for a temporary chat that is currently in memory. */
export interface TemporaryChatSaveControls {
	disabled?: boolean;
	onSave: () => void;
	saving?: boolean;
}

export interface AttachedFile {
	filename: string;
	id: string;
	size?: number;
}

/**
 * Composer info-bar strip (top or bottom of the outer card). Use
 * `variant: "destructive"` for errors — `bg-destructive/10` so they sit above
 * the input instead of crowding the workspace / sources footer.
 */
export interface InputBarInfoBar {
	/** Optional primary action rendered on the right (e.g. "Upgrade"). */
	action?: {
		label: string;
		onClick: () => void;
	};
	/** Optional compact actions rendered on the right, before `action`. */
	actions?: {
		label: string;
		onClick: () => void;
		variant?: "default" | "secondary" | "ghost";
	}[];
	description?: string;
	onClose?: () => void;
	position?: "top" | "bottom";
	title?: string;
	/** Visual tone. `"destructive"` uses a soft red wash for composer errors. */
	variant?: "default" | "destructive";
}

export interface InputBarProps {
	attachedFiles?: AttachedFile[];
	attachedImages?: AttachedImage[];
	autoFocus?: boolean;
	changeSummary?: {
		files: number;
		insertions: number;
		deletions: number;
	};
	className?: string;

	/**
	 * Responsive compact composer used once a conversation has history. A plain
	 * one-line textarea shares the row with the controls; as soon as it explicitly
	 * or visually wraps, the textarea moves above the normal full controls row.
	 * Rich Markdown and manually expanded composers always use the full layout.
	 */
	compact?: boolean;

	/**
	 * Node rendered inside the composer box, above the textarea (and above any
	 * attachment chips) — e.g. a pending quote preview. Shares the box's rounded
	 * `bg-muted` fill so it reads as part of the composer.
	 */
	composerHeader?: React.ReactNode;
	/** Searchable apps/plugins/context rows shown by the shared + menu. */
	composerMenuGroups?: ComposerMenuGroup[];
	/**
	 * An active approval or other human-input card that temporarily replaces the
	 * textarea. It lives in the same layout surface as the normal composer so the
	 * surface can animate between writing and deciding without a second floating
	 * card.
	 */
	composerPrompt?: {
		content: React.ReactNode;
		id: string;
	};

	/**
	 * Context-window usage for the persistent composer meter (donut ring +
	 * used-percentage, left of the model selector). Derived by the host from the
	 * conversation's latest usage stats; omit to hide.
	 */
	contextMeter?: ContextUsage;
	/** Open the full context breakdown when the meter is clicked. Omit to keep
	 *  the meter a read-only ring. */
	contextMeterOnOpen?: () => void;
	disabled?: boolean;

	/**
	 * Double-check (`/double-check`) affordances for the composer "+" dropdown.
	 * When provided, the dropdown gains a "Double-check" toggle row and a verdict
	 * badge appears beside the "+" once a review has run.
	 */
	doubleCheckControls?: DoubleCheckControls;
	draftControls?: ComposerDraftControls;
	/**
	 * When true (default) clicking a staged image attachment opens a
	 * fullscreen lightbox preview. Set to false to render thumbnails as
	 * plain non-interactive previews.
	 */
	enableImagePreview?: boolean;

	/**
	 * Allow submitting while a run is streaming. When true, pressing Enter (or the
	 * primary send button) calls `onSend` even mid-stream so the host can enqueue the
	 * message instead of dropping it. Defaults to false (legacy block behaviour).
	 */
	enableQueue?: boolean;
	/** Render the plugin-owned control that expands the composer in place. */
	expandComposer?: boolean;

	/**
	 * Temporary (incognito) chat active. When true, the composer box gets a
	 * persistent violet ring so it's visually obvious the current thread isn't
	 * being saved — mirroring the temporary-chat cue in ChatGPT / Grok.
	 */
	ghost?: boolean;

	/**
	 * Temporary-chat toggle for the composer "+" dropdown. When provided, the
	 * dropdown gains a "Temporary chat" row that flips {@link ghost}. Separate from
	 * `ghost` (which only drives the violet ring) so the host can hide the toggle
	 * — e.g. once a thread has messages — while still showing the temporary ring.
	 */
	ghostControls?: GhostControls;

	/**
	 * The goal bar rendered above the composer while a goal is active or being
	 * drafted. Mirrors the info-bar treatment. Omit to hide.
	 */
	goalBar?: GoalBarProps;

	/**
	 * Goal (`/goal`) affordances for the composer "+" dropdown and the active-goal
	 * chip. When provided, the "+" opens a menu (Add photos & files | Pursue goal).
	 */
	goalControls?: GoalControls;

	infoBar?: InputBarInfoBar;
	isDragOver?: boolean;

	/** Content rendered on the left of the toolbar, next to the attachment button. */
	leftActions?: React.ReactNode;
	/**
	 * A live call (realtime voice mode) that morphs into the composer while it is
	 * active. The text field and trailing send/model cluster are replaced by the
	 * call row, the "+" menu stays, and the draft is kept for when the call ends.
	 * While a composer prompt (question or permission) is up, a compact call row
	 * with `content` and `actions` stays under the prompt so the call can still
	 * be muted, interrupted, or ended.
	 */
	liveCall?: ComposerLiveCall;
	/** Resolved @ mentions used to paint the live composer preview. */
	mentionItems?: MentionItem[];
	onAnnotateImage?: (image: {
		filename?: string;
		id: string;
		url: string;
	}) => void;

	// Attachment support
	onAttach?: () => void;
	onChange?: (value: string) => void;
	onComposerMenuSelect?: (item: ComposerMenuItem) => void;

	/**
	 * Image generation. When provided, an image button appears in the toolbar
	 * (beside the mic) that takes the composer text as the prompt, generates an
	 * image via Core's /api/images/generate, and clears the composer. The host
	 * surfaces the resulting image in the conversation. Mirrors `voice`: the
	 * draft text is owned by this component, so the host receives only the prompt.
	 */
	onGenerateImage?: (prompt: string) => void | Promise<void>;

	/**
	 * Video generation. When provided, a video button appears beside image gen.
	 * Mirrors {@link onGenerateImage}: takes the composer text as the prompt,
	 * generates via Core's /api/video/generate, and clears the composer. Needs a
	 * video model loaded in the sdcpp engine to produce anything.
	 */
	onGenerateVideo?: (prompt: string) => void | Promise<void>;
	/** Report the total composer height to a compact host surface. */
	onHeightChange?: (height: number) => void;
	onPaste?: (e: React.ClipboardEvent) => void;
	onRemoveFile?: (id: string) => void;
	onRemoveImage?: (id: string) => void;
	onSend: (message: {
		role: "user";
		content: string;
		followUpMode?: "opposite";
	}) => void;
	/** Open the app-owned sketch dialog. */
	onSketch?: () => void;
	onStop: () => void;
	/** Optional host-level keyboard handling for the composer editor. */
	onTextareaKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
	placeholder?: string;
	/** Ghost prompt and keyboard-navigable prompt list supplied by a host/plugin. */
	placeholderSuggestion?: string;

	/**
	 * Composer toggles contributed by enabled plugins (`composer_controls`). Each
	 * renders as a toggle row in the "+" dropdown's Assist section; flipping one
	 * sets its `flag` in the per-request `plugin_flags` map. Threaded straight to
	 * the toolbar's `GoalPlusButton`.
	 */
	pluginControls?: PluginComposerControlRow[];
	/**
	 * The user's predicted next message (Composer Predictions). Rendered as
	 * Tab-to-accept ghost text in the empty composer even without a prompt list,
	 * and preferred over `placeholderSuggestion`. Never sent automatically.
	 */
	prediction?: string;

	questionBar?: {
		id: string;
		questions: QuestionConfig[];
		questionIndex?: number;
		totalQuestions?: number;
		onPreviousQuestion?: () => void;
		onNextQuestion?: () => void;
		submitLabel?: string;
		skipLabel?: string;
		allowSkip?: boolean;
		onSubmit: (answer: QuestionAnswer) => void;
		onSkip?: () => void;
	};

	/**
	 * Message queue. When provided, queued messages are listed in a bar above the
	 * composer (rendered like the info/question bars). The host owns the queue
	 * state and dispatch (see `useMessageQueue`); this is purely presentational.
	 */
	queueBar?: QueueBarProps;
	/** Content rendered on the right of the toolbar, before the send button. */
	rightActions?: React.ReactNode;
	/** Remove the composer field's card chrome when embedded in voice mode. */
	seamless?: boolean;
	status: ChatStatus;
	suggestions?:
		| SuggestionItem[]
		| {
				items: SuggestionItem[];
				className?: string;
				itemClassName?: string;
		  };
	/** Save the client-held temporary transcript as a normal conversation. */
	temporaryChatSaveControls?: TemporaryChatSaveControls;
	/** Accessible name for the plain textarea in compact host surfaces. */
	textareaAriaLabel?: string;
	/** Live todo list and file edits derived from the current user turn. */
	turnProgress?: InputBarTurnProgress;

	// Typing animation
	typingAnimation?: {
		text: string;
		duration: number;
		image?: string;
		isActive: boolean;
		onComplete: () => void;
	};

	// Controlled mode
	value?: string;

	/**
	 * Voice input. When provided, a microphone button appears in the toolbar that
	 * records from the user's default mic, shows a live waveform, and appends the
	 * transcription to the composer text. `transcribe` uploads the recorded WAV
	 * and resolves with the transcript (wired to Core's /api/voice/transcribe).
	 */
	voice?: {
		transcribe: (audio: Blob) => Promise<string>;
		disabled?: boolean;
	};

	/**
	 * Live voice-mode (realtime conversation) entry. When provided, the trailing
	 * button's empty state becomes the voice-mode waveform (opens the full-screen
	 * overlay) instead of the STT mic; STT dictation (`voice`) relocates to its own
	 * small toolbar button. `onStart` opens voice mode.
	 */
	voiceMode?: {
		onStart: () => void;
		disabled?: boolean;
	};

	/**
	 * Workspace strip rendered as a separate row BELOW the composer box
	 * (Codex/Cowork-style project ▸ branch ▸ worktree controls). Omit to hide.
	 * Distinct from `leftActions`, which sit in the controls row inside the box.
	 */
	workspaceBar?: React.ReactNode;
}

/** The call surface rendered inside the composer card by `InputBarProps.liveCall`. */
export interface ComposerLiveCall {
	/** Call controls that replace the trailing model selector and send button. */
	actions: React.ReactNode;
	/** Call identity, timer, and live caption, in place of the text field. */
	content: React.ReactNode;
	/**
	 * Wraps the composer card while the call is live, e.g. in the voice glow
	 * that lights the card's bottom edge. Receives the card element unchanged.
	 */
	frame?: (card: React.ReactNode) => React.ReactNode;
	/** Optional panel above the call row inside the card (e.g. assistant cards). */
	header?: React.ReactNode;
}

export interface InputBarTurnProgress {
	deletions: number;
	files: {
		deletions: number;
		insertions: number;
		preview?: string;
		path: string;
	}[];
	insertions: number;
	todos?: {
		current: number;
		items: {
			label: string;
			status: "completed" | "in_progress" | "pending";
		}[];
		total: number;
	};
}
