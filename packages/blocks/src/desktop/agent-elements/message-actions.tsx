import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowTurnBackwardIcon,
	Copy01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type React from "react";
import { useRef, useState } from "react";
import { MessageActionSurface } from "./message-action-surface.tsx";
import type { MessageContextMenuReactions } from "./message-context-menu.tsx";
import styles from "./message-list.module.css";
import { MessageOverflowMenu } from "./message-overflow-menu.tsx";
import { isServerAssignedMessageId } from "./message-reaction-id.ts";
import type {
	ContributedMessageAction,
	MessageActionRuntimeState,
} from "./types.ts";

function CopyButton({
	text,
	onCopied,
}: {
	text: string;
	onCopied?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const copiedTimerRef = useRef<number | null>(null);

	const handleCopy = () => {
		navigator.clipboard.writeText(text);
		setCopied(true);
		if (copiedTimerRef.current) {
			window.clearTimeout(copiedTimerRef.current);
		}
		copiedTimerRef.current = window.setTimeout(() => {
			setCopied(false);
			copiedTimerRef.current = null;
		}, 2000);
		onCopied?.();
	};
	return (
		<Button
			appearance="transcript-copy"
			aria-label={copied ? "Message copied" : "Copy message"}
			onClick={handleCopy}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			title={copied ? "Message copied" : "Copy message"}
			type="button"
			variant="ghost"
		>
			<div className="relative size-4">
				<HugeiconsIcon
					className={cn(
						"absolute inset-0 size-4 text-muted-foreground duration-150 ease-out",
						styles.copyTransition,
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100"
					)}
					icon={Copy01Icon}
				/>
				<HugeiconsIcon
					className={cn(
						"absolute inset-0 size-4 text-muted-foreground duration-150 ease-out",
						styles.copyTransition,
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
					)}
					icon={Tick02Icon}
				/>
			</div>
		</Button>
	);
}

function ReplyButton({ onReply }: { onReply: () => void }) {
	return (
		<Button
			appearance="transcript-copy"
			aria-label="Reply to message"
			onClick={onReply}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			title="Reply to message"
			type="button"
			variant="ghost"
		>
			<HugeiconsIcon
				className="size-4 text-muted-foreground"
				icon={ArrowTurnBackwardIcon}
			/>
		</Button>
	);
}

// `< n / m >` version pager shown when a turn has alternate versions. Stepping
// left/right calls `onSelect` with the target version's id.
export function VersionPager({
	index,
	count,
	ids,
	alignClass,
	onSelect,
}: {
	index: number;
	count: number;
	ids: string[];
	alignClass: string;
	onSelect: (versionId: string) => void;
}) {
	const go = (delta: number) => {
		const next = index + delta;
		const target = ids[next];
		if (target) {
			onSelect(target);
		}
	};
	return (
		<div
			className={cn(
				"flex items-center gap-0.5 text-muted-foreground/70 text-xs",
				alignClass
			)}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<Button
				appearance="transcript-version"
				aria-label="Previous version"
				disabled={index <= 0}
				onClick={() => go(-1)}
				size="icon"
				tabIndex={-1}
				type="button"
				variant="ghost"
			>
				<HugeiconsIcon className="size-3.5" icon={ArrowLeft01Icon} />
			</Button>
			<span className="tabular-nums">
				{index + 1}/{count}
			</span>
			<Button
				appearance="transcript-version"
				aria-label="Next version"
				disabled={index >= count - 1}
				onClick={() => go(1)}
				size="icon"
				tabIndex={-1}
				type="button"
				variant="ghost"
			>
				<HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
			</Button>
		</div>
	);
}

/** Reaction strip input for a message's right-click menu, when reactions are on. */
export function contextMenuReactionsFor(
	reactionAction: ContributedMessageAction | undefined,
	messageId: string,
	actionState: MessageActionRuntimeState | undefined,
	onContributedAction:
		| ((action: ContributedMessageAction, value?: string) => void)
		| undefined
): MessageContextMenuReactions | undefined {
	if (!(reactionAction && onContributedAction)) {
		return;
	}
	return {
		buckets: actionState?.reactionBuckets ?? [],
		canReact: isServerAssignedMessageId(messageId),
		onToggle: (emoji) => onContributedAction(reactionAction, emoji),
	};
}

export function MessageToolbar({
	actionState,
	alignClass,
	contributedActions,
	text,
	heightClass,
	hoverClass,
	isVisible,
	menuAlign,
	onCopied,
	onBranch,
	onEdit,
	onRegenerate,
	onReply,
	onRewind,
	onSpeak,
	onContributedAction,
	reactionAction,
	reactionMessageId,
	goalCompletion,
	meta,
}: {
	actionState?: MessageActionRuntimeState;
	alignClass: string;
	contributedActions?: ContributedMessageAction[];
	text?: string;
	heightClass: string;
	hoverClass: string;
	isVisible: boolean;
	menuAlign: "start" | "end";
	onCopied?: () => void;
	onBranch?: () => void;
	onEdit?: () => void;
	onRegenerate?: () => void;
	onReply?: () => void;
	onRewind?: () => void;
	onSpeak?: () => void;
	onContributedAction?: (
		action: ContributedMessageAction,
		value?: string
	) => void;
	reactionAction?: ContributedMessageAction;
	reactionMessageId?: string;
	/** Compact completion status appended to the ending-turn toolbar. */
	goalCompletion?: React.ReactNode;
	/** Quiet trailing meta (the send time), revealed with the actions. */
	meta?: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"pointer-events-none flex items-center gap-1 text-muted-foreground/70 text-xs opacity-0 transition-opacity duration-150",
				heightClass,
				alignClass,
				hoverClass,
				isVisible && "pointer-events-auto opacity-100",
				"focus-within:pointer-events-auto focus-within:opacity-100"
			)}
			data-slot="message-toolbar"
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			{reactionAction && reactionMessageId && onContributedAction ? (
				<MessageActionSurface
					actions={[reactionAction]}
					messageId={reactionMessageId}
					onAction={(action, context) =>
						onContributedAction(action, context.value)
					}
					state={actionState}
				/>
			) : null}
			{onReply && <ReplyButton onReply={onReply} />}
			{text && <CopyButton onCopied={onCopied} text={text} />}
			<MessageOverflowMenu
				actionState={actionState}
				align={menuAlign}
				contributedActions={contributedActions}
				onBranch={onBranch}
				onContributedAction={onContributedAction}
				onEdit={onEdit}
				onRegenerate={onRegenerate}
				onRewind={onRewind}
				onSpeak={onSpeak}
			/>
			{goalCompletion ? goalCompletion : null}
			{meta ? <span className="ml-1 tabular-nums">{meta}</span> : null}
		</div>
	);
}
