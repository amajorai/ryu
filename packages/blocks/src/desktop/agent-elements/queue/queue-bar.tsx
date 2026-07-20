"use client";

import { Button } from "@ryu/ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { IconArrowUp, IconCheck, IconEdit, IconX } from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";

/** Fades the trailing edge of overflowing text into transparency. */
const FADE_GRADIENT =
	"linear-gradient(to right, #000 calc(100% - 2rem), transparent)";
const FADE_STYLE: CSSProperties = {
	maskImage: FADE_GRADIENT,
	WebkitMaskImage: FADE_GRADIENT,
};

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
	content: string;
	id: string;
}

export interface QueueBarProps {
	/** Messages waiting to be sent, in dispatch order (index 0 sends next). */
	items: QueuedMessage[];
	/** Discard the whole queue. */
	onClear: () => void;
	/** Replace the content of a queued message. */
	onEdit: (id: string, content: string) => void;
	/** Drop a queued message without sending it. */
	onRemove: (id: string) => void;
	/** Combine every queued message into one turn and send it now. */
	onSendAll: () => void;
	/** Jump a queued message to the front and send it now (interrupts a run). */
	onSendNow: (id: string) => void;
	/** Disable queueing from the composer controls. */
	onTurnOffQueueing?: () => void;
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
}: {
	item: QueuedMessage;
	index: number;
	total: number;
	expanded: boolean;
	reduceMotion: boolean;
	onSendNow: (id: string) => void;
	onRemove: (id: string) => void;
	onEdit: (id: string, content: string) => void;
}) {
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
			className="relative"
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
			style={{
				height: CARD_HEIGHT,
				zIndex: total - index,
				transformOrigin: "top center",
			}}
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
				<span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-muted px-1 text-center font-medium text-[10px] text-muted-foreground tabular-nums">
					{index + 1}
				</span>
				{editing ? (
					<>
						<input
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
							aria-label="Save edit"
							className="size-5 shrink-0 rounded-sm text-muted-foreground/70 hover:text-foreground"
							onClick={commitEdit}
							size="icon"
							type="button"
							variant="ghost"
						>
							<IconCheck className="h-3.5 w-3.5" />
						</Button>
						<Button
							aria-label="Cancel edit"
							className="size-5 shrink-0 rounded-sm text-muted-foreground/70 hover:text-foreground"
							onClick={cancelEdit}
							size="icon"
							type="button"
							variant="ghost"
						>
							<IconX className="h-3.5 w-3.5" />
						</Button>
					</>
				) : (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<span
									className="min-w-0 flex-1 cursor-default overflow-hidden whitespace-nowrap"
									style={FADE_STYLE}
								>
									{item.content}
								</span>
							</TooltipTrigger>
							<TooltipContent
								className="max-w-[360px] whitespace-pre-wrap break-words text-xs"
								side="top"
							>
								{item.content}
							</TooltipContent>
						</Tooltip>
						<div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/qcard:opacity-100">
							<Button
								aria-label="Edit message"
								className="size-5 shrink-0 rounded-sm text-muted-foreground/70 hover:text-foreground"
								onClick={startEdit}
								size="icon"
								title="Edit"
								type="button"
								variant="ghost"
							>
								<IconEdit className="h-3.5 w-3.5" />
							</Button>
							<Button
								aria-label="Send now"
								className="size-5 shrink-0 rounded-sm text-muted-foreground/70 hover:text-foreground"
								onClick={() => onSendNow(item.id)}
								size="icon"
								title="Send now"
								type="button"
								variant="ghost"
							>
								<IconArrowUp className="h-3.5 w-3.5" />
							</Button>
							<Button
								aria-label="Remove from queue"
								className="size-5 shrink-0 rounded-sm text-muted-foreground/70 hover:text-foreground"
								onClick={() => onRemove(item.id)}
								size="icon"
								title="Remove"
								type="button"
								variant="ghost"
							>
								<IconX className="h-3.5 w-3.5" />
							</Button>
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
	onTurnOffQueueing,
	roundTop = true,
}: QueueBarProps) {
	const [expanded, setExpanded] = useState(false);
	const reduceMotion = useReducedMotion() ?? false;

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
					Queued
					<span className="tabular-nums">· {count}</span>
				</div>
				<div className="inline-flex items-center gap-1">
					{count > 1 && (
						<Button
							className="h-5 rounded-sm px-1.5 text-muted-foreground hover:text-foreground"
							onClick={onSendAll}
							size="sm"
							title="Combine all queued messages into one and send now"
							type="button"
							variant="ghost"
						>
							Send all
						</Button>
					)}
					{onTurnOffQueueing && (
						<Button
							className="h-5 rounded-sm px-1.5 text-muted-foreground hover:text-foreground"
							onClick={onTurnOffQueueing}
							size="sm"
							type="button"
							variant="ghost"
						>
							Turn off
						</Button>
					)}
					<Button
						className="h-5 rounded-sm px-1.5 text-muted-foreground hover:text-foreground"
						onClick={onClear}
						size="sm"
						type="button"
						variant="ghost"
					>
						Clear
					</Button>
				</div>
			</div>
			{/* The deck. Collapsed it fans into a stack; hover / focus-within opens
			    it. Vertical padding + max-height give the expanded list room to
			    scroll while keeping the collapsed stack compact. */}
			<motion.div
				className="max-h-[220px] overflow-y-auto px-2 py-2"
				layout
				onBlur={(e) => {
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
						<QueueItem
							expanded={expanded}
							index={index}
							item={item}
							key={item.id}
							onEdit={onEdit}
							onRemove={onRemove}
							onSendNow={onSendNow}
							reduceMotion={reduceMotion}
							total={count}
						/>
					))}
				</AnimatePresence>
			</motion.div>
		</div>
	);
}
