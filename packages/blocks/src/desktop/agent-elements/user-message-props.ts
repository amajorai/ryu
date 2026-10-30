import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import type { LinkPreviewResolvers } from "./link-preview.tsx";
import type { MessageGroupPosition } from "./message-bubble.ts";
import type { MessageReadReceiptState } from "./message-read-receipt.tsx";
import type {
	ContributedMessageAction,
	MentionItem,
	MessageActionContext,
	MessageActionRuntimeState,
} from "./types.ts";

export interface UserMessageProps {
	/**
	 * Hover actions (copy / edit / branch) for this turn. The message row places
	 * them beside the bubble: on the outside edge for the local user and the
	 * opposite edge for a remote sender.
	 */
	actions?: ReactNode;
	className?: string;
	/** Current signed-in user info for displaying avatar/name on own messages. */
	currentUser?: {
		avatar?: string;
		name?: string;
		id?: string;
	};
	/** When true, the bubble is replaced by an inline editor (ChatGPT/Claude-style
	 * message editing). Saving calls `onEditSubmit`; Escape/Cancel calls
	 * `onEditCancel`. */
	editing?: boolean;
	/**
	 * When true (default) clicking an attached image opens a fullscreen
	 * lightbox preview. Set to false to render images as plain thumbnails.
	 */
	enableImagePreview?: boolean;
	/**
	 * Where this row sits in its sender RUN — consecutive messages from the same
	 * speaker with no reply and no day boundary between them. Computed by the
	 * transcript across sibling scroll items (`userRunPositions` in
	 * message-list.tsx), because a run spans turns and therefore cannot be a
	 * wrapper element.
	 *
	 * It drives the whole messaging convention: the avatar and the timestamp are
	 * drawn once, on the row that CLOSES the run, and a remote sender is named
	 * once, on the row that OPENS it. Everything else about the row is unchanged,
	 * including its hover toolbar and its edit affordance.
	 *
	 * Defaults to `"single"`, which is the ungrouped behaviour every other
	 * surface (island, storyboard, subagent panel) gets for free.
	 */
	groupPosition?: MessageGroupPosition;
	mentionItems?: MentionItem[];
	message: UIMessage;
	/** Runtime state keyed for the message-action renderers. */
	messageActionState?: MessageActionRuntimeState;
	/** Message actions contributed by enabled plugins. */
	messageActions?: readonly ContributedMessageAction[];
	onAnnotateImage?: (image: {
		filename?: string;
		id: string;
		url: string;
	}) => void;
	/** Dispatch a contributed action back to the shell. */
	onContributedMessageAction?: (
		action: ContributedMessageAction,
		context: MessageActionContext
	) => void;
	onEditCancel?: () => void;
	onEditSubmit?: (text: string) => void;
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	previewResolvers?: LinkPreviewResolvers;
	/** Durable per-person read state for this message. */
	readReceipt?: MessageReadReceiptState;
}
