import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { EmojiPicker } from "@ryu/ui/components/emoji-picker";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { IconCopy, IconPlus } from "@tabler/icons-react";
import { Reply as ReplyIcon } from "lucide-react";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { isMemoryCitationsAction } from "./message-action-types.ts";
import {
	type MessageReactionBucket,
	QUICK_REACTIONS,
} from "./message-reactions.tsx";
import type {
	ContributedMessageAction,
	MessageActionRuntimeState,
} from "./types.ts";

/**
 * Right-click (and long-press) menu for one transcript message, in the shape
 * messaging clients use: a quick reaction strip on top, then the message's
 * actions. It mirrors the hover toolbar and overflow menu rather than adding
 * new behavior, so every entry here has an equivalent visible control.
 */

export interface MessageContextMenuReactions {
	buckets: readonly MessageReactionBucket[];
	/** False for optimistic ids — see `isServerAssignedMessageId`. */
	canReact: boolean;
	onToggle: (emoji: string) => void;
}

export interface MessageContextMenuProps {
	actionState?: MessageActionRuntimeState;
	children: ReactNode;
	contributedActions?: readonly ContributedMessageAction[];
	/** Suppresses the menu, e.g. while the message is in inline edit mode. */
	disabled?: boolean;
	onBranch?: () => void;
	onContributedAction?: (
		action: ContributedMessageAction,
		value?: string
	) => void;
	onCopied?: () => void;
	onEdit?: () => void;
	onRegenerate?: () => void;
	onReply?: () => void;
	onSpeak?: () => void;
	reactions?: MessageContextMenuReactions;
	/** Plain text copied by "Copy text". Empty hides the entry. */
	text?: string;
}

const ITEM_ICON_CLASS = "size-3.5";

/** Text the user had selected inside `container` when the menu opened. */
function readSelectionWithin(container: Element): string {
	const selection = globalThis.getSelection?.();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return "";
	}
	const range = selection.getRangeAt(0);
	if (!container.contains(range.commonAncestorContainer)) {
		return "";
	}
	return selection.toString().trim();
}

function writeClipboardText(text: string, onCopied?: () => void): void {
	if (!navigator.clipboard?.writeText) {
		return;
	}
	navigator.clipboard.writeText(text).then(
		() => onCopied?.(),
		() => {
			// Clipboard denial leaves the menu closed with nothing copied; the
			// hover toolbar's copy button stays available as the fallback.
		}
	);
}

function ReactionStrip({
	reactions,
}: {
	reactions: MessageContextMenuReactions;
}) {
	const tl = useLiteralMessages();
	const mine = new Set(
		reactions.buckets.filter((b) => b.reactedByMe).map((b) => b.emoji)
	);
	// Existing reactions not in the quick set still get a one-tap toggle, so a
	// reaction added from the full picker can be removed from here too.
	const extra = reactions.buckets
		.map((b) => b.emoji)
		.filter((emoji) => !(QUICK_REACTIONS as readonly string[]).includes(emoji));
	const emojis = [...QUICK_REACTIONS, ...extra];

	return (
		<>
			<div
				aria-label="Reactions"
				className="flex items-center gap-0.5 px-1 pt-0.5 pb-1"
				data-slot="message-context-menu-reactions"
				role="group"
			>
				{emojis.map((emoji) => (
					<ContextMenuItem
						aria-label={
							mine.has(emoji)
								? tl("Remove {emoji} reaction", { emoji })
								: tl("Add {emoji} reaction", { emoji })
						}
						className={cn(
							"size-8 justify-center rounded-full p-0 text-lg leading-none",
							mine.has(emoji) && "bg-primary/15"
						)}
						key={emoji}
						onClick={() => reactions.onToggle(emoji)}
					>
						{emoji}
					</ContextMenuItem>
				))}
				<ContextMenuSub>
					<ContextMenuSubTrigger
						aria-label="More emoji"
						className="size-8 justify-center rounded-full p-0 text-muted-foreground [&>svg:last-child]:hidden"
					>
						<IconPlus aria-hidden="true" className={ITEM_ICON_CLASS} />
					</ContextMenuSubTrigger>
					<ContextMenuSubContent className="p-1">
						{/* The picker's search box must keep its keystrokes; the menu's
						    typeahead would otherwise steal them. */}
						<div
							className="overflow-hidden rounded-2xl [&_em-emoji-picker]:w-full!"
							onKeyDown={(event) => event.stopPropagation()}
						>
							<EmojiPicker
								onEmojiSelect={(emoji) => reactions.onToggle(emoji.native)}
							/>
						</div>
					</ContextMenuSubContent>
				</ContextMenuSub>
			</div>
			<ContextMenuSeparator />
		</>
	);
}

function ContributedItems({
	actionState,
	actions,
	onAction,
}: {
	actionState?: MessageActionRuntimeState;
	actions: readonly ContributedMessageAction[];
	onAction: (action: ContributedMessageAction, value?: string) => void;
}) {
	return actions.map((action) => {
		if (action.kind === "toggle-group" && action.states?.length) {
			return (
				<Fragment key={action.id}>
					{action.states.map((state) => {
						const active =
							actionState?.toggleValues?.[action.id] === state.value;
						const icon = active
							? (state.active_icon ?? state.icon)
							: state.icon;
						return (
							<ContextMenuItem
								key={`${action.id}:${state.value}`}
								onClick={() =>
									onAction(action, active ? undefined : state.value)
								}
							>
								{icon ? (
									<Icon
										aria-hidden="true"
										className={ITEM_ICON_CLASS}
										icon={icon}
									/>
								) : null}
								{state.label}
								{active ? (
									<HugeiconsIcon
										aria-hidden="true"
										className="ms-auto size-3.5"
										icon={Tick02Icon}
									/>
								) : null}
							</ContextMenuItem>
						);
					})}
				</Fragment>
			);
		}
		return (
			<ContextMenuItem key={action.id} onClick={() => onAction(action)}>
				{action.icon ? (
					<Icon
						aria-hidden="true"
						className={ITEM_ICON_CLASS}
						icon={action.icon}
					/>
				) : null}
				{action.label}
			</ContextMenuItem>
		);
	});
}

export function MessageContextMenu({
	actionState,
	children,
	contributedActions,
	disabled = false,
	onBranch,
	onContributedAction,
	onCopied,
	onEdit,
	onRegenerate,
	onReply,
	onSpeak,
	reactions,
	text,
}: MessageContextMenuProps) {
	const [selectedText, setSelectedText] = useState("");
	const selectionRef = useRef("");

	const showReactions = Boolean(reactions?.canReact);
	// Citations render as a popover anchored to the overflow menu; a context
	// menu closes on click, so they stay toolbar-only.
	const visibleContributed =
		onContributedAction && contributedActions
			? contributedActions.filter((a) => !isMemoryCitationsAction(a))
			: [];
	const hasItems =
		showReactions ||
		Boolean(text) ||
		Boolean(onReply || onEdit || onRegenerate || onBranch || onSpeak) ||
		visibleContributed.length > 0;

	if (!hasItems) {
		return children;
	}

	return (
		<ContextMenu
			disabled={disabled}
			onOpenChange={(open) => {
				// Snapshot on open: clicking a menu item can collapse the selection
				// before the item's handler runs.
				setSelectedText(open ? selectionRef.current : "");
			}}
		>
			<ContextMenuTrigger
				// `contents` keeps the transcript layout untouched, and `select-auto`
				// undoes the primitive's `select-none` so message text stays selectable.
				className="contents select-auto"
				data-slot="message-context-menu-trigger"
				onContextMenu={(event) => {
					selectionRef.current = readSelectionWithin(event.currentTarget);
				}}
			>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent className="min-w-52" withBackdrop={false}>
				{showReactions && reactions ? (
					<ReactionStrip reactions={reactions} />
				) : null}
				{onReply ? (
					<ContextMenuItem onClick={onReply}>
						<ReplyIcon aria-hidden="true" className={ITEM_ICON_CLASS} />
						Reply
					</ContextMenuItem>
				) : null}
				{selectedText ? (
					<ContextMenuItem
						onClick={() => writeClipboardText(selectedText, onCopied)}
					>
						<IconCopy aria-hidden="true" className={ITEM_ICON_CLASS} />
						Copy selection
					</ContextMenuItem>
				) : null}
				{text ? (
					<ContextMenuItem onClick={() => writeClipboardText(text, onCopied)}>
						<IconCopy aria-hidden="true" className={ITEM_ICON_CLASS} />
						Copy text
					</ContextMenuItem>
				) : null}
				{onEdit ? (
					<ContextMenuItem onClick={onEdit}>
						<Icon
							aria-hidden="true"
							className={ITEM_ICON_CLASS}
							icon="lucide:pencil"
						/>
						Edit message
					</ContextMenuItem>
				) : null}
				{onRegenerate ? (
					<ContextMenuItem onClick={onRegenerate}>
						<Icon
							aria-hidden="true"
							className={ITEM_ICON_CLASS}
							icon="lucide:refresh-cw"
						/>
						Regenerate reply
					</ContextMenuItem>
				) : null}
				{onBranch ? (
					<ContextMenuItem onClick={onBranch}>
						<Icon
							aria-hidden="true"
							className={ITEM_ICON_CLASS}
							icon="lucide:git-branch"
						/>
						Fork chat from here
					</ContextMenuItem>
				) : null}
				{onSpeak ? (
					<ContextMenuItem onClick={onSpeak}>
						<Icon
							aria-hidden="true"
							className={ITEM_ICON_CLASS}
							icon="lucide:volume-2"
						/>
						Speak
					</ContextMenuItem>
				) : null}
				{visibleContributed.length > 0 && onContributedAction ? (
					<>
						<ContextMenuSeparator />
						<ContributedItems
							actionState={actionState}
							actions={visibleContributed}
							onAction={onContributedAction}
						/>
					</>
				) : null}
			</ContextMenuContent>
		</ContextMenu>
	);
}
