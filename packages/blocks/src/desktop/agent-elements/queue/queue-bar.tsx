"use client";

import {
	ArrowUp02Icon,
	Attachment01Icon,
	Cancel01Icon,
	DragDropVerticalIcon,
	TaskAdd01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";

import styles from "./queue-bar.module.css";

interface QueueCardStyle extends CSSProperties {
	"--queue-card-z-index": number;
}

// Deck geometry. Collapsed, each card past the front one peeks by PEEK px from
// under the card above it (a fanned stack of cards). Expanded (on hover /
// focus-within), the whole deck spreads to EXPANDED_GAP so every card is fully
// readable and its actions are reachable. Only the first STACK_DEPTH cards get
// depth styling; deeper ones share the back-most look so a long queue doesn't
// shrink into nothing.
const CARD_HEIGHT = 36;
const PEEK = 12;
const EXPANDED_GAP = 6;
const STACK_DEPTH = 4;
const COLLAPSED_OVERLAP = -(CARD_HEIGHT - PEEK);

export interface QueuedMessage {
	attachments?: QueuedAttachment[];
	content: string;
	id: string;
}

/** A staged image travels with its queued turn rather than the live composer. */
export interface QueuedAttachment {
	filename: string;
	id: string;
	mimeType?: string;
	size?: number;
	url: string;
}

export interface QueueBarProps {
	/** Messages waiting to be sent, in dispatch order (index 0 sends next). */
	items: QueuedMessage[];
	/** Discard the whole queue. */
	onClear: () => void;
	/** Replace the content of a queued message. */
	onEdit: (id: string, content: string) => void;
	onQueueModeChange?: (mode: "auto" | "off") => void;
	/** Drop a queued message without sending it. */
	onRemove: (id: string) => void;
	/** Move a queued message to a new dispatch position. */
	onReorder: (id: string, toIndex: number) => void;
	/** Combine every queued message into one turn and send it now. */
	onSendAll: () => void;
	/** Jump a queued message to the front and send it now (interrupts a run). */
	onSendNow: (id: string) => void;
	/** Disable queueing from the composer controls. */
	onTurnOffQueueing?: () => void;
	queueMode?: "auto" | "off";
	/**
	 * Rounds the top corners when the queue bar is the topmost element of the
	 * composer stack (i.e. no info bar sits above it).
	 */
	roundTop?: boolean;
}

function QueueItem({
	item,
	index,
	total,
	expanded,
	reduceMotion,
	onSendNow,
	onRemove,
	onEdit,
	onReorder,
}: {
	item: QueuedMessage;
	index: number;
	total: number;
	expanded: boolean;
	reduceMotion: boolean;
	onSendNow: (id: string) => void;
	onRemove: (id: string) => void;
	onEdit: (id: string, content: string) => void;
	onReorder: (id: string, toIndex: number) => void;
}) {
	const tl = useLiteralMessages();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.content);
	const inputRef = useRef<HTMLInputElement>(null);

	const startEdit = () => {
		setDraft(item.content);
		setEditing(true);
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	const commitEdit = () => {
		const trimmed = draft.trim();
		if (trimmed && trimmed !== item.content) {
			onEdit(item.id, trimmed);
		}
		setEditing(false);
	};

	const cancelEdit = () => {
		setDraft(item.content);
		setEditing(false);
	};

	// Depth of this card in the collapsed deck (0 = front, next to dispatch).
	// Clamped to STACK_DEPTH so a tall queue keeps a consistent back-card look.
	const depth = Math.min(index, STACK_DEPTH);
	// Collapsed: fanned stack (front card full size on top, each behind it a
	// touch smaller, dimmer, and peeking below). Expanded: a flat, even list.
	const collapsedStyle = {
		marginTop: index === 0 ? 0 : COLLAPSED_OVERLAP,
		scale: 1 - depth * 0.03,
		opacity: index === 0 ? 1 : Math.max(0.55, 1 - depth * 0.14),
	};
	const expandedStyle = {
		marginTop: index === 0 ? 0 : EXPANDED_GAP,
		scale: 1,
		opacity: 1,
	};
	const target = expanded ? expandedStyle : collapsedStyle;

	return (
		<motion.div
			animate={reduceMotion ? { opacity: target.opacity } : target}
			className={styles.card}
			exit={
				reduceMotion
					? { opacity: 0 }
					: { opacity: 0, scale: 0.96, marginTop: COLLAPSED_OVERLAP }
			}
			initial={
				reduceMotion
					? { opacity: 0 }
					: { opacity: 0, scale: 0.96, marginTop: COLLAPSED_OVERLAP }
			}
			layout
			// Front card sits on top so its overhang and actions win; deeper cards
			// stack beneath in order. Hovering any card lifts the whole deck open.
			style={
				{
					"--queue-card-z-index": total - index,
				} satisfies QueueCardStyle as QueueCardStyle
			}
			transition={
				reduceMotion
					? { duration: 0 }
					: { type: "spring", stiffness: 520, damping: 40, mass: 0.6 }
			}
		>
			<div
				className={cn(
					"group/qcard flex h-full items-center gap-2 rounded-xl border border-border bg-card px-2.5 text-foreground text-xs shadow-sm",
					index === 0 && "shadow-md"
				)}
				onDoubleClick={editing ? undefined : startEdit}
			>
				<button
					aria-label={tl("Reorder queued message {position}", {
						position: index + 1,
					})}
					className="cursor-grab touch-none text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
					draggable
					onDragStart={(event) => {
						event.dataTransfer.setData("text/plain", item.id);
						event.dataTransfer.effectAllowed = "move";
					}}
					onKeyDown={(event) => {
						if (
							!(event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key))
						) {
							return;
						}
						event.preventDefault();
						onReorder(item.id, index + (event.key === "ArrowUp" ? -1 : 1));
					}}
					type="button"
				>
					<HugeiconsIcon className="h-3.5 w-3.5" icon={DragDropVerticalIcon} />
				</button>
				<span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-muted px-1 text-center font-medium text-muted-foreground text-xs tabular-nums">
					{index + 1}
				</span>
				{editing ? (
					<>
						<input
							aria-label={tl("Edit queued message {position}", {
								position: index + 1,
							})}
							className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-foreground text-xs outline-none focus:border-ring"
							onBlur={commitEdit}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									commitEdit();
								} else if (e.key === "Escape") {
									cancelEdit();
								}
							}}
							ref={inputRef}
							value={draft}
						/>
						<Button
							appearance="queued-message-action"
							aria-label="Save edit"
							onClick={commitEdit}
							size="icon"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="h-3.5 w-3.5" icon={Tick02Icon} />
						</Button>
						<Button
							appearance="queued-message-action"
							aria-label="Cancel edit"
							onClick={cancelEdit}
							size="icon"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="h-3.5 w-3.5" icon={Cancel01Icon} />
						</Button>
					</>
				) : (
					<>
						<Tooltip>
							{/* Base UI composes through `render`, not `asChild`. */}
							<TooltipTrigger
								render={
									<span
										className={cn(
											"min-w-0 flex-1 cursor-default overflow-hidden whitespace-nowrap",
											styles.fade
										)}
									>
										{item.content}
									</span>
								}
							/>
							<TooltipContent
								className="max-w-[360px] whitespace-pre-wrap break-words"
								side="top"
							>
								{item.content}
							</TooltipContent>
						</Tooltip>
						{item.attachments && item.attachments.length > 0 && (
							<div
								className="flex shrink-0 items-center gap-1 text-muted-foreground"
								title={item.attachments
									.map((attachment) => attachment.filename)
									.join(", ")}
							>
								{item.attachments.slice(0, 3).map((attachment) => {
									const safeUrl = safeMediaUrl(attachment.url);
									return safeUrl ? (
										<img
											alt=""
											className="size-5 rounded object-cover"
											key={attachment.id}
											src={safeUrl}
										/>
									) : null;
								})}
								{item.attachments.length > 3 ? (
									<span className="text-xs">
										+{item.attachments.length - 3}
									</span>
								) : (
									<HugeiconsIcon className="h-3 w-3" icon={Attachment01Icon} />
								)}
							</div>
						)}
						<div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/qcard:opacity-100">
							<Button
								appearance="queued-message-action"
								aria-label="Send now"
								onClick={() => onSendNow(item.id)}
								size="icon"
								title="Send now"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="h-3.5 w-3.5" icon={ArrowUp02Icon} />
							</Button>
							<DropdownMenu>
								<DropdownMenuTrigger
									aria-label="Message options"
									type="button"
									variant="queue-message-options"
								>
									⋯
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem onClick={startEdit}>
										Edit message
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => onRemove(item.id)}>
										Delete message
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</>
				)}
			</div>
		</motion.div>
	);
}

/**
 * A composer bar that lists messages queued while the agent is busy. Rendered as
 * a "deck of cards": each queued message is a card fanned into a stack (the
 * next-to-send card on top), and hovering — or focusing into — the deck spreads
 * it open into a fully readable, actionable list. Purely presentational — all
 * queue state lives in the host (see `useMessageQueue`).
 */
export function QueueBar({
	items,
	onSendNow,
	onRemove,
	onEdit,
	onSendAll,
	onClear,
	onReorder,
	onQueueModeChange,
	queueMode = "auto",
	roundTop = true,
}: QueueBarProps) {
	const [expanded, setExpanded] = useState(false);
	const reduceMotion = useReducedMotion() ?? false;
	const tl = useLiteralMessages();

	if (items.length === 0) {
		return null;
	}

	const count = items.length;

	return (
		<div
			className={cn(
				"mx-auto w-full max-w-[calc(100%-24px)] border-border border-x border-t bg-background",
				roundTop ? "rounded-t-2xl" : null
			)}
		>
			<div className="flex h-7 items-center justify-between border-border border-b px-3 text-muted-foreground text-xs">
				<div className="inline-flex items-center gap-1.5">
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3.5 shrink-0"
						icon={TaskAdd01Icon}
					/>
					Queued
					<span className="tabular-nums">· {formatNumber(count)}</span>
				</div>
				<div className="inline-flex items-center gap-1">
					{count > 1 && (
						<Button
							appearance="queue-send-all"
							onClick={onSendAll}
							size="sm"
							title="Combine all queued messages into one and send now"
							type="button"
							variant="ghost-muted"
						>
							Send all
						</Button>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger
							aria-label="Queue options"
							type="button"
							variant="queue-options"
						>
							⋯
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => onQueueModeChange?.("auto")}>
								{queueMode === "auto" ? "✓ " : ""}
								{tl("Auto queue messages")}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => onQueueModeChange?.("off")}>
								{queueMode === "off" ? "✓ " : ""}
								{tl("Turn off queueing")}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onClear}>Clear queue</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{/* The deck. Collapsed it fans into a stack; hover / focus-within opens
			    it. Vertical padding + max-height give the expanded list room to
			    scroll while keeping the collapsed stack compact. */}
			<motion.div
				className="scroll-fade max-h-[220px] overflow-y-auto px-2 py-2"
				layout
				onBlur={(e) => {
					// SAFETY: A browser focus event exposes the next focused DOM element or null as relatedTarget; both are accepted by the native contains call.
					if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
						setExpanded(false);
					}
				}}
				onFocus={() => setExpanded(true)}
				onMouseEnter={() => setExpanded(true)}
				onMouseLeave={() => setExpanded(false)}
				transition={reduceMotion ? { duration: 0 } : undefined}
			>
				<AnimatePresence initial={false}>
					{items.map((item, index) => (
						<div
							data-queue-index={index}
							key={item.id}
							onDragOver={(event) => event.preventDefault()}
							onDrop={(event) => {
								event.preventDefault();
								const id = event.dataTransfer.getData("text/plain");
								if (id) {
									onReorder(id, index);
								}
							}}
						>
							<QueueItem
								expanded={expanded}
								index={index}
								item={item}
								onEdit={onEdit}
								onRemove={onRemove}
								onReorder={onReorder}
								onSendNow={onSendNow}
								reduceMotion={reduceMotion}
								total={count}
							/>
						</div>
					))}
				</AnimatePresence>
			</motion.div>
		</div>
	);
}
