// apps/desktop/src/components/drafts/DraftsCardSpread.tsx
//
// Drafts dealt as a hand of cards: thumb through the fan, click cards onto the send
// pile, press Send and watch them fly off the table.
//
// A display style of the Drafts page, not a second send path. "Send" here re-arms
// each chosen draft with an `at: now` trigger and hands it back to the app's own
// dispatcher (`apps-store/drafts/backend/src/dispatch.rs`), which sends one draft per
// tick through the granted `chat.startTurn` capability — Approvals gate included.
// The page passes that in as `onSend`; this component owns only the table.
//
// Every card lives in ONE stage coordinate space and stays mounted while it moves
// between zones (deck, hand, pile, flight), so changing a card's zone is just a new
// pose: it arcs across the table and flips in flight (`card-motion.ts`), and can be
// pulled back from the pile, or bounce back from a failed send, from wherever it is.

import { SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	CARD_HOP,
	CARD_INSTANT,
	cardFlight,
	cardHop,
	cardStagger,
} from "@ryu/blocks/desktop/interfaces/card-motion.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { arc, type Transition, useReducedMotion } from "motion/react";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { DraftWire } from "@/src/lib/api/drafts.ts";
import { DraftCard, type Placed, type Zone } from "./DraftCard.tsx";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	DECK_SHOWN,
	deckPose,
	handPose,
	isDealable,
	jitter,
	MAX_HAND,
	PILE_FAN_MAX,
	PILE_TOP,
	pilePose,
	type StageSize,
	throwPose,
} from "./drafts-card-layout.ts";

/** How long a sent pile takes to leave the table before the result shows. */
const THROW_SECONDS = 0.7;
/** A thrown card bows out to its own side as it leaves. */
const THROW_STRENGTH = 0.15;

export interface DraftsSendResult {
	failed: { id: string; message: string }[];
	sent: string[];
}

function useStageSize(ref: RefObject<HTMLDivElement | null>): StageSize | null {
	const [size, setSize] = useState<StageSize | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			// Layout size, not the bounding box: the dialog scales in as it opens.
			setSize({ height: element.clientHeight, width: element.clientWidth });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

function statusLine({
	dealable,
	flying,
	pile,
	status,
}: {
	dealable: number;
	flying: number;
	pile: number;
	status: { message: string } | null;
}): string {
	if (flying > 0) {
		return flying === 1 ? "Sending 1 draft…" : `Sending ${flying} drafts…`;
	}
	if (status) {
		return status.message;
	}
	if (dealable > MAX_HAND) {
		return `Dealt the ${MAX_HAND} newest of ${dealable} drafts. ${pile} on the pile`;
	}
	return `${pile} on the pile`;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function CardTable({
	drafts,
	onClose,
	onSend,
}: {
	drafts: DraftWire[];
	onClose: () => void;
	onSend: (ids: string[]) => Promise<DraftsSendResult>;
}) {
	const reduceMotion = useReducedMotion() ?? false;
	const stageRef = useRef<HTMLDivElement>(null);
	const stage = useStageSize(stageRef);
	const [dealtAt] = useState(() => Date.now());
	const [pile, setPile] = useState<string[]>([]);
	const [flying, setFlying] = useState<string[]>([]);
	const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
	const [hovered, setHovered] = useState<string | null>(null);
	const [status, setStatus] = useState<{
		message: string;
		tone: "error" | "done";
	} | null>(null);
	// Where each card was last drawn and the stage it was drawn on, read during
	// render to tell a flight from a hop from a card that stayed put.
	const previous = useRef(new Map<string, { slot: number; zone: Zone }>());
	const previousStage = useRef<StageSize | null>(null);

	// Ranks come from the hand as dealt, before any card left it, so a card keeps
	// its number for as long as the table is open.
	const deal = drafts.filter((draft) => isDealable(draft, dealtAt));
	const rankOf = new Map(deal.map((draft, index) => [draft.id, index + 1]));
	const dealable = deal.filter((draft) => !gone.has(draft.id));
	const dealt = dealable.slice(0, MAX_HAND);
	const deck = dealable.slice(MAX_HAND, MAX_HAND + DECK_SHOWN);
	const byId = new Map(dealt.map((draft) => [draft.id, draft]));
	const pileCards = pile.flatMap((id) => byId.get(id) ?? []);
	const flyingCards = flying.flatMap((id) => byId.get(id) ?? []);
	const hand = dealt.filter(
		(draft) => !(pile.includes(draft.id) || flying.includes(draft.id))
	);
	const hoveredIndex = hand.findIndex((draft) => draft.id === hovered);
	const sending = flying.length > 0;

	const placed: Placed[] = stage
		? [
				...deck.map((draft, slot) => ({
					draft,
					pose: deckPose(slot, stage),
					slot,
					zone: "deck" as const,
				})),
				...hand.map((draft, slot) => ({
					draft,
					pose: handPose(
						slot,
						hand.length,
						stage,
						hoveredIndex === -1 ? null : hoveredIndex
					),
					slot,
					zone: "hand" as const,
				})),
				...pileCards.map((draft, slot) => ({
					draft,
					pose: pilePose(draft.id, slot, pileCards.length),
					slot,
					zone: "pile" as const,
				})),
				...flyingCards.map((draft, slot) => {
					const from = pilePose(draft.id, slot, flyingCards.length);
					return {
						draft,
						pose: reduceMotion
							? { ...from, opacity: 0, z: 500 + slot }
							: throwPose(draft.id, from, slot),
						slot,
						zone: "flight" as const,
					};
				}),
			]
		: [];

	useLayoutEffect(() => {
		previous.current = new Map(
			placed.map((card) => [
				card.draft.id,
				{ slot: card.slot, zone: card.zone },
			])
		);
		previousStage.current = stage;
	});

	const resized =
		previousStage.current !== null &&
		stage !== null &&
		(previousStage.current.width !== stage.width ||
			previousStage.current.height !== stage.height);
	// A card is new to the table when it was never drawn; it comes off the deck.
	const leaves = (card: Placed) => {
		const was = previous.current.get(card.draft.id);
		return was ? was.zone !== card.zone : card.zone !== "deck";
	};
	const stagger = cardStagger(placed.filter(leaves).length);
	let moving = 0;
	const motionFor = (
		card: Placed
	): { delay: number; transition: Transition } => {
		if (reduceMotion || resized) {
			return {
				delay: 0,
				transition:
					reduceMotion && card.zone === "flight"
						? { duration: 0.2 }
						: CARD_INSTANT,
			};
		}
		if (leaves(card)) {
			const delay = moving * stagger;
			moving += 1;
			const transition = cardFlight(delay);
			if (card.zone !== "flight") {
				return { delay, transition };
			}
			const side = jitter(card.draft.id, 4) >= 0 ? "ccw" : "cw";
			return {
				delay,
				transition: {
					...transition,
					opacity: { delay: delay + 0.3, duration: 0.25, ease: "easeIn" },
					path: arc({ direction: side, strength: THROW_STRENGTH }),
				},
			};
		}
		const was = previous.current.get(card.draft.id);
		return {
			delay: 0,
			transition:
				card.zone === "hand" && was?.slot !== card.slot ? cardHop() : CARD_HOP,
		};
	};

	const pick = (card: Placed) => {
		setStatus(null);
		setHovered(null);
		if (card.zone === "pile") {
			setPile((current) => current.filter((item) => item !== card.draft.id));
		} else if (card.zone === "hand") {
			setPile((current) => [...current, card.draft.id]);
		}
	};

	const send = async () => {
		const ids = pileCards.map((draft) => draft.id);
		if (ids.length === 0 || sending) {
			return;
		}
		setStatus(null);
		setFlying(ids);
		setPile([]);
		const flightMs = reduceMotion
			? 200
			: (THROW_SECONDS + cardStagger(ids.length) * (ids.length - 1)) * 1000;
		const [result] = await Promise.all([
			onSend(ids).catch(
				(error: unknown): DraftsSendResult => ({
					failed: ids.map((id) => ({
						id,
						message:
							error instanceof Error ? error.message : "The send failed.",
					})),
					sent: [],
				})
			),
			wait(flightMs),
		]);
		setGone((current) => new Set([...current, ...result.sent]));
		setFlying([]);
		if (result.failed.length > 0) {
			// Failed cards come back to the pile, not the hand: the person already
			// chose them, and Send again is the one-click retry.
			setPile(result.failed.map((failure) => failure.id));
			const first = result.failed[0]?.message ?? "The send failed.";
			setStatus({
				message:
					result.failed.length === ids.length
						? `Nothing was sent. ${first}`
						: `${result.sent.length} sent, ${result.failed.length} came back. ${first}`,
				tone: "error",
			});
			return;
		}
		setStatus({
			message:
				result.sent.length === 1
					? "1 draft handed to the outbox. It goes out on the next dispatch."
					: `${result.sent.length} drafts handed to the outbox. They go out one per dispatch.`,
			tone: "done",
		});
	};

	return (
		<>
			<DialogHeader className="px-5 pt-5">
				<DialogTitle>Deal your drafts</DialogTitle>
				<DialogDescription>
					Click cards onto the pile, then send. Each goes out on the outbox's
					next dispatch, through Approvals when it is on.
				</DialogDescription>
			</DialogHeader>

			<div
				aria-label="Draft cards"
				className="relative isolate min-h-0 flex-1 touch-manipulation select-none"
				ref={stageRef}
				role="group"
			>
				<div
					aria-hidden="true"
					className={cn(
						"absolute flex items-end justify-center rounded-2xl border border-dashed pb-2 text-muted-foreground text-xs transition-colors",
						pileCards.length > 0 && "border-primary/50 bg-primary/5"
					)}
					style={{
						height: CARD_HEIGHT + 32,
						insetInlineStart: `calc(50% - ${(CARD_WIDTH + 32 + PILE_FAN_MAX) / 2}px)`,
						top: PILE_TOP - 16,
						width: CARD_WIDTH + 32 + PILE_FAN_MAX,
					}}
				>
					{pileCards.length === 0 && !sending ? "Send pile" : null}
				</div>

				{stage && dealt.length === 0 && !sending ? (
					<div className="absolute inset-x-0 bottom-10 flex flex-col items-center gap-2 text-center">
						<p className="text-muted-foreground text-sm">
							{gone.size > 0
								? "Every card is on its way."
								: "No drafts to deal."}
						</p>
						<Button onClick={onClose} size="sm" variant="ghost">
							Close
						</Button>
					</div>
				) : null}

				{stage
					? placed.map((card) => {
							const { delay, transition } = motionFor(card);
							const isNew = !previous.current.has(card.draft.id);
							return (
								<DraftCard
									flipDelay={delay}
									from={isNew && !reduceMotion ? deckPose(0, stage) : null}
									key={card.draft.id}
									onHover={(id) =>
										setHovered((current) =>
											id === null && current !== card.draft.id ? current : id
										)
									}
									onPick={pick}
									placed={card}
									rank={rankOf.get(card.draft.id) ?? 0}
									reduceMotion={reduceMotion}
									transition={transition}
								/>
							);
						})
					: null}
			</div>

			<DialogFooter className="items-center px-5 pb-5">
				<p
					aria-live="polite"
					className={cn(
						"me-auto text-xs",
						status?.tone === "error"
							? "text-status-destructive"
							: "text-muted-foreground"
					)}
					role="status"
				>
					{statusLine({
						dealable: dealable.length,
						flying: flyingCards.length,
						pile: pileCards.length,
						status,
					})}
				</p>
				<Button
					disabled={pileCards.length === 0 || sending}
					onClick={() => {
						setStatus(null);
						setPile([]);
					}}
					size="sm"
					variant="ghost"
				>
					Back to hand
				</Button>
				<Button
					disabled={pileCards.length === 0 || sending}
					onClick={() => {
						send().catch(() => undefined);
					}}
					size="sm"
				>
					<HugeiconsIcon className="mr-1 size-4" icon={SentIcon} />
					{pileCards.length > 1 ? `Send ${pileCards.length}` : "Send"}
				</Button>
			</DialogFooter>
		</>
	);
}

/**
 * The card-spread display of the outbox. Opened from a trigger on the Drafts page;
 * every open deals a fresh hand, because the table's state is the person's choice
 * for this hand and has nothing to persist.
 */
export function DraftsCardSpread({
	drafts,
	onOpenChange,
	onSend,
	open,
}: {
	drafts: DraftWire[];
	onOpenChange: (open: boolean) => void;
	onSend: (ids: string[]) => Promise<DraftsSendResult>;
	open: boolean;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent appearance="card-table" mobileFullPage>
				<CardTable
					drafts={drafts}
					onClose={() => onOpenChange(false)}
					onSend={onSend}
				/>
			</DialogContent>
		</Dialog>
	);
}
