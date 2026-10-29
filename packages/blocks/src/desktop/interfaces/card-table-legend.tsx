import type { ReactNode } from "react";
import { ChipStack, HoleCards, SuitGlyph } from "./card-table-pieces.tsx";

/** One line of the legend: a small piece of the table and what it means. */
function LegendItem({
	children,
	piece,
}: {
	children: ReactNode;
	piece: ReactNode;
}) {
	return (
		<li className="flex items-center gap-2.5">
			<span
				aria-hidden="true"
				className="flex h-5 w-7 shrink-0 items-end justify-center"
			>
				{piece}
			</span>
			<span>{children}</span>
		</li>
	);
}

/**
 * How to read the table, mirrored on the other side of the fan from the
 * hand's label: face-down cards mean the agent holds the action, a seat's
 * chips count its threads, and a card's suit says why it is in your hand.
 * Shown only when the fan leaves room on both sides.
 */
export function TableLegend({
	acts = false,
	left,
	maxWidth,
	top,
}: {
	/** With the act layer: chips show progress and no cards lie face down. */
	acts?: boolean;
	left: number;
	maxWidth: number;
	top: number;
}) {
	return (
		<section
			aria-label="How to read the table"
			className="pointer-events-none absolute z-10 flex flex-col gap-2 rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) px-3 py-2.5 font-semibold text-(--gk-ink-muted) text-[12px] shadow-(--gk-lip)"
			data-testid="card-table-legend"
			style={{ left, maxWidth, top }}
		>
			<h2>
				<span className="gk-display text-(--gk-ink) text-[16px] leading-5">
					At the table
				</span>
			</h2>
			<ul className="flex flex-col gap-1.5 leading-4">
				{acts ? null : (
					<LegendItem piece={<HoleCards width={12} />}>
						Cards down: the agent's move
					</LegendItem>
				)}
				<LegendItem piece={<ChipStack chips={2} colorIndex={0} size={16} />}>
					{acts ? "Chips: steps done at a seat" : "Chips: threads at a seat"}
				</LegendItem>
				<LegendItem
					piece={
						<span className="flex gap-1 text-[13px]">
							<SuitGlyph status="attention" />
							<SuitGlyph status="your-turn" />
						</span>
					}
				>
					Failed run, your turn
				</LegendItem>
			</ul>
		</section>
	);
}
