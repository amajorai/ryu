import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { useState } from "react";
import { CARD_HOP, CARD_INSTANT } from "./card-motion.ts";
import { HeldCardsList } from "./card-table-hand.tsx";
import type { CardPose } from "./card-table-model.ts";
import { CardBack } from "./card-table-pieces.tsx";
import type { SpreadActions } from "./card-table-spread-deck-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * The last slot of a fan that cannot deal every card: a face-down card with
 * the count of the rest, which lists them, so a big deck still reaches every
 * one of its threads.
 */
export function FanMoreCard({
	actions,
	card,
	deckName,
	pose,
	threads,
}: {
	actions: SpreadActions;
	card: { height: number; width: number };
	deckName: string;
	pose: CardPose;
	threads: InterfaceThread[];
}) {
	const reduceMotion = useReducedMotion();
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const count = threads.length;
	return (
		<motion.li
			animate={{
				opacity: 1,
				rotate: pose.rotate,
				scale: pose.scale,
				x: pose.x,
				y: pose.y,
			}}
			className="pointer-events-auto absolute top-0 left-0"
			exit={{ opacity: 0 }}
			initial={reduceMotion ? false : { opacity: 0 }}
			style={{ height: card.height, width: card.width, zIndex: pose.z }}
			transition={reduceMotion ? CARD_INSTANT : CARD_HOP}
		>
			<Popover onOpenChange={setOpen} open={open}>
				<PopoverTrigger
					render={
						<button
							aria-label={tl(
								"{count, plural, one {{countText} more card} other {{countText} more cards}} in {deckName}'s deck. Show them",
								{ count, countText: String(count), deckName }
							)}
							className="group/more relative block size-full cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
							data-testid="card-table-fan-more"
							type="button"
						/>
					}
				>
					<CardBack className="absolute inset-0 size-full rounded-xl border-[5px] shadow-none" />
					<span className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
						<span className="rounded-md bg-card px-2 py-1 font-medium text-card-foreground text-sm tabular-nums shadow-sm transition-colors group-hover/more:bg-muted">
							{tl("{count} more", { count: String(count) })}
						</span>
					</span>
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
							{tl("More in {deckName}'s deck", { deckName })}
						</PopoverTitle>
						<PopoverDescription className="text-xs">
							Past what the fan can show.
						</PopoverDescription>
					</PopoverHeader>
					<div className="max-h-80 overflow-y-auto">
						<HeldCardsList
							actions={actions}
							onDone={() => setOpen(false)}
							threads={threads}
						/>
					</div>
				</PopoverContent>
			</Popover>
		</motion.li>
	);
}
