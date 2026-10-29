// apps/desktop/src/components/drafts/DraftCard.tsx
//
// One draft card on the table: a frame that moves with the shared card motion,
// and its two sides. Both sides stay mounted inside one 3D body, so a card dealt
// from the deck turns face up in flight instead of remounting.

import {
	Alert02Icon,
	Clock01Icon,
	FileEditIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	CARD_FLIGHT,
	useCardMove,
} from "@ryu/blocks/desktop/interfaces/card-motion.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, type Transition } from "motion/react";
import type { DraftWire } from "@/src/lib/api/drafts.ts";
import {
	CARD_HEIGHT,
	CARD_ORIGIN,
	CARD_WIDTH,
	type Pose,
} from "./drafts-card-layout.ts";

function stateIcon(draft: DraftWire) {
	if (draft.state === "failed") {
		return Alert02Icon;
	}
	if (draft.state === "armed") {
		return Clock01Icon;
	}
	return FileEditIcon;
}

function CardIndex({
	draft,
	flipped,
	rank,
}: {
	draft: DraftWire;
	flipped?: boolean;
	rank: number;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute flex flex-col items-center gap-0.5",
				draft.state === "failed"
					? "text-status-destructive"
					: "text-card-foreground",
				flipped ? "end-2 bottom-2 rotate-180" : "start-2 top-2"
			)}
		>
			<span className="font-mono font-semibold text-sm leading-none">
				{rank}
			</span>
			<HugeiconsIcon className="size-3.5" icon={stateIcon(draft)} />
		</span>
	);
}

/** One draft's face. The text is the draft's own words, never a summary. */
function DraftCardFace({ draft, rank }: { draft: DraftWire; rank: number }) {
	return (
		<span className="relative flex size-full flex-col overflow-hidden rounded-xl border bg-card text-start text-card-foreground shadow-[0_14px_28px_-14px] shadow-black/40">
			<CardIndex draft={draft} rank={rank} />
			<span className="line-clamp-7 whitespace-pre-line break-words px-7 pt-8 text-xs leading-snug">
				{draft.text.trim() || "Empty draft"}
			</span>
			<span className="mt-auto mb-3 truncate px-7 text-center text-[0.65rem] text-muted-foreground">
				{draft.state_label}
			</span>
			<CardIndex draft={draft} flipped rank={rank} />
		</span>
	);
}

/** The back every card shows while it waits in the deck. */
function DraftCardBack() {
	return (
		<span className="block size-full rounded-xl border bg-card p-1.5 shadow-[0_1px_0_var(--border),0_3px_6px_-2px] shadow-black/40">
			<span className="block size-full rounded-lg border border-border bg-[repeating-linear-gradient(45deg,var(--muted)_0_6px,var(--background)_6px_12px)]" />
		</span>
	);
}

/**
 * A draft card's two faces in a 3D frame. `faceDown` turns it over with the
 * flight spring; `initialFaceDown` is the side it mounts on (a card dealt from
 * the deck mounts face down and turns over on its way to the hand).
 */
function DraftCardSides({
	delay,
	draft,
	faceDown,
	initialFaceDown,
	rank,
	reduceMotion,
}: {
	delay: number;
	draft: DraftWire;
	faceDown: boolean;
	initialFaceDown: boolean;
	rank: number;
	reduceMotion: boolean;
}) {
	const transition: Transition = reduceMotion
		? { duration: 0 }
		: { ...CARD_FLIGHT, delay };
	return (
		<span className="perspective-[800px] block size-full">
			<motion.span
				animate={{ rotateY: faceDown ? 180 : 0 }}
				className="transform-3d relative block size-full"
				initial={reduceMotion ? false : { rotateY: initialFaceDown ? 180 : 0 }}
				transition={transition}
			>
				<span className="backface-hidden absolute inset-0 block">
					<DraftCardFace draft={draft} rank={rank} />
				</span>
				<span className="backface-hidden absolute inset-0 block rotate-y-180">
					<DraftCardBack />
				</span>
			</motion.span>
		</span>
	);
}

export type Zone = "deck" | "hand" | "pile" | "flight";

export interface Placed {
	draft: DraftWire;
	pose: Pose;
	slot: number;
	zone: Zone;
}

/** One card frame. It keeps its element across zones, so a zone change flies. */
export function DraftCard({
	flipDelay,
	from,
	onHover,
	onPick,
	placed,
	rank,
	reduceMotion,
	transition,
}: {
	flipDelay: number;
	/** Where a card new to the table mounts (the deck); null mounts it in place. */
	from: Pose | null;
	onHover: (id: string | null) => void;
	onPick: (placed: Placed) => void;
	placed: Placed;
	rank: number;
	reduceMotion: boolean;
	transition: Transition;
}) {
	const { draft, pose, zone } = placed;
	const frame = useCardMove<HTMLButtonElement>(pose, transition);
	const preview = draft.preview || "Empty draft";
	const hidden = zone === "deck";
	const leave = () => onHover(null);
	const initial = from ?? pose;
	return (
		<motion.button
			aria-hidden={hidden || undefined}
			aria-label={
				zone === "pile"
					? `Return to hand: ${preview}`
					: `Add to send pile: ${preview}`
			}
			aria-pressed={zone === "deck" ? undefined : zone !== "hand"}
			className="absolute top-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default"
			data-draft-card={draft.id}
			data-draft-card-where={zone}
			disabled={zone === "flight" || zone === "deck"}
			inert={hidden || undefined}
			initial={{
				opacity: initial.opacity,
				rotate: initial.rotate,
				scale: initial.scale,
				x: initial.x,
				y: initial.y,
			}}
			onBlur={leave}
			onClick={() => onPick(placed)}
			onFocus={() => zone === "hand" && onHover(draft.id)}
			onPointerEnter={(event) =>
				zone === "hand" && event.pointerType === "mouse" && onHover(draft.id)
			}
			onPointerLeave={leave}
			ref={frame}
			style={{
				height: CARD_HEIGHT,
				insetInlineStart: `calc(50% - ${CARD_WIDTH / 2}px)`,
				transformOrigin: `${CARD_ORIGIN.x * 100}% ${CARD_ORIGIN.y * 100}%`,
				width: CARD_WIDTH,
				zIndex: pose.z,
			}}
			type="button"
		>
			<DraftCardSides
				delay={flipDelay}
				draft={draft}
				faceDown={zone === "deck"}
				initialFaceDown={from !== null || zone === "deck"}
				rank={rank}
				reduceMotion={reduceMotion}
			/>
		</motion.button>
	);
}
