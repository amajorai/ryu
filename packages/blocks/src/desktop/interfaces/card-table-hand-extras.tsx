import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import {
	emptyHandRect,
	plural,
	type StageSize,
	type TableGeometry,
} from "./card-table-model.ts";
import { ThreadRow } from "./card-table-rows.tsx";
import type { SeatActions } from "./card-table-seat.tsx";

// The hand's surroundings: its label and keyboard hint, the cards held back
// past the fan, and the empty hand.

export const HAND_HINT_ID = "card-table-hand-hint";

function HandKeys({ visible }: { visible: boolean }) {
	return (
		<p
			className={cn(
				"flex items-center gap-1.5 font-semibold text-(--gk-ink-muted) text-[12px]",
				!visible && "sr-only"
			)}
			id={HAND_HINT_ID}
		>
			<Kbd>←</Kbd>
			<Kbd>→</Kbd>
			<span>choose</span>
			<Kbd className="ms-1">↵</Kbd>
			<span>play</span>
			<span className="sr-only">
				. Arrow keys move along the hand, Home and End jump to the ends, and
				Enter or Space opens the thread.
			</span>
		</p>
	);
}

/**
 * "6 waiting on you": every card, dealt or held back. With the act layer
 * the HUD counts what needs you, so the hand only counts its cards.
 */
function handCountLabel(
	count: number,
	held: number,
	acts: boolean,
	tl: LiteralMessage
): string {
	return acts
		? plural(count + held, "card")
		: tl("{waitingCount} waiting on you", { waitingCount: count + held });
}

/** The held cards' list: each row opens its thread; `onDone` closes the menu. */
export function HeldCardsList({
	actions,
	onDone,
	threads,
}: {
	actions: SeatActions;
	onDone: () => void;
	threads: InterfaceThread[];
}) {
	return (
		<ul aria-label="Held cards" className="flex flex-col">
			{threads.map((thread) => (
				<ThreadRow
					active={thread.id === actions.activeThreadId}
					key={thread.id}
					now={actions.now}
					onOpen={(threadId) => {
						onDone();
						actions.onOpen(threadId);
					}}
					showAgent
					snapshot={actions.snapshot}
					thread={thread}
				/>
			))}
		</ul>
	);
}

/**
 * The cards held back off the fan, as a small button that lists them, so a
 * narrow table still reaches every thread waiting on you.
 */
function HeldCards({
	actions,
	threads,
}: {
	actions: SeatActions;
	threads: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	if (threads.length === 0) {
		return null;
	}
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<button
						aria-label={tl(
							"{heldCount, plural, one {{heldCount} card} other {{heldCount} cards}} held back. Show them",
							{ heldCount: threads.length }
						)}
						className="pointer-events-auto inline-flex h-5 items-center gap-0.5 rounded-full border border-border bg-card px-1.5 font-medium text-[11px] text-foreground tabular-nums leading-none shadow-xs outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 aria-expanded:border-ring"
						data-testid="card-table-held"
						type="button"
					/>
				}
			>
				{tl("{heldCount} held", { heldCount: threads.length })}
				<ChevronDown
					aria-hidden="true"
					className="size-3 text-muted-foreground"
				/>
			</PopoverTrigger>
			<PopoverContent
				appearance="composer-menu"
				className="w-80 gap-2 bg-popover"
				corners="rounded"
				side="top"
				sideOffset={8}
				spacing="inset"
			>
				<PopoverHeader className="px-2 pt-1">
					<PopoverTitle className="font-semibold text-sm">
						Held back
					</PopoverTitle>
					<PopoverDescription className="text-xs">
						Waiting on you, past what the hand can show.
					</PopoverDescription>
				</PopoverHeader>
				<HeldCardsList
					actions={actions}
					onDone={() => setOpen(false)}
					threads={threads}
				/>
			</PopoverContent>
		</Popover>
	);
}

/** Where the hand's label goes: beside the fan, or as a caption over it. */
export type HandLabelPlacement =
	| { kind: "beside"; right: number; top: number }
	| { bottom: number; centerX: number; kind: "above" };

/**
 * The hand's name, its count and the keys, anchored to the fan: right-aligned
 * just left of the first card, level with its top corner, when there is room;
 * otherwise a small caption over the middle of the fan (the key hints stay for
 * screen readers). Cards held back off the fan open from a button beside the
 * count.
 */
export function HandLabel({
	actions,
	acts = false,
	count,
	heldThreads,
	placement,
	tucked = 0,
}: {
	actions: SeatActions;
	/** With the act layer: the label counts cards, not what waits on you. */
	acts?: boolean;
	count: number;
	heldThreads: InterfaceThread[];
	placement: HandLabelPlacement;
	/** Follows a phone's tucked fan down (px). */
	tucked?: number;
}) {
	const tl = useLiteralMessages();
	const held = heldThreads.length;
	if (placement.kind === "above") {
		return (
			<div
				className="pointer-events-none absolute z-10 flex h-7 -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) ps-3 pe-1 text-(--gk-ink) text-[13px] shadow-[0_2px_0_var(--gk-edge)]"
				data-testid="card-table-hand-label"
				style={{ bottom: placement.bottom - tucked, left: placement.centerX }}
			>
				<h2 className="flex items-baseline gap-1.5">
					<span className="gk-display">Your hand</span>
					<span aria-hidden="true" className="text-(--gk-ink-muted)">
						·
					</span>
					<span className="font-semibold text-(--gk-ink-muted) tabular-nums">
						{handCountLabel(count, held, acts, tl)}
					</span>
				</h2>
				{held > 0 ? (
					<HeldCards actions={actions} threads={heldThreads} />
				) : (
					<span aria-hidden="true" className="w-2" />
				)}
				<HandKeys visible={false} />
			</div>
		);
	}
	return (
		<div
			className="pointer-events-none absolute z-10 flex flex-col items-end gap-2 rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) px-3.5 py-2.5 text-right text-(--gk-ink) shadow-(--gk-lip)"
			data-testid="card-table-hand-label"
			style={{ right: placement.right, top: placement.top }}
		>
			<div className="flex flex-col items-end gap-1">
				<h2 className="flex flex-col items-end gap-0.5">
					<span className="gk-display text-[18px] leading-6">Your hand</span>
					<span className="font-semibold text-(--gk-ink-muted) text-[13px] tabular-nums leading-5">
						{handCountLabel(count, held, acts, tl)}
					</span>
				</h2>
				<HeldCards actions={actions} threads={heldThreads} />
			</div>
			<HandKeys visible={count > 0} />
		</div>
	);
}

/** Where the hand would be when nothing waits on you. */
export function EmptyHand({
	geometry,
	stage,
}: {
	geometry: TableGeometry;
	stage: StageSize;
}) {
	const rect = emptyHandRect(geometry, stage);
	return (
		<div
			className="pointer-events-none absolute z-10 flex flex-col items-center justify-center gap-1 rounded-xl border border-foreground/20 border-dashed bg-background/50 px-3 text-center backdrop-blur-sm"
			data-testid="card-table-empty-hand"
			style={{
				height: rect.height,
				left: rect.x,
				top: rect.y,
				width: rect.width,
			}}
		>
			<span className="font-medium text-foreground text-sm">
				Nothing to play
			</span>
			<span className="text-muted-foreground text-xs">
				No thread is waiting on you.
			</span>
		</div>
	);
}
