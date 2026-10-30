import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { PathChest, PathTrophy } from "./path-art.tsx";
import type { PathUnit } from "./path-model.ts";
import { labelPlacement, PathRow } from "./path-stop-row.tsx";

/** The milestone's one-line caption. */
export function milestoneCaption(
	done: number,
	total: number,
	tl: LiteralMessage
): string {
	return done === total
		? "Unit complete"
		: tl("{done} of {total} finished", {
				done: String(done),
				total: String(total),
			});
}

export function PathMilestoneItem({
	swing,
	unit,
}: {
	swing: number;
	unit: PathUnit;
}) {
	const tl = useLiteralMessages();
	const total = unit.stops.length;
	const complete = unit.milestone === "trophy";
	return (
		<PathRow fit="art" swing={swing}>
			<div
				aria-label={
					complete
						? tl("Unit {index} complete: all {total} finished", {
								index: String(unit.index),
								total: String(total),
							})
						: tl("Unit {index} milestone: {doneCount} of {total} finished", {
								doneCount: String(unit.doneCount),
								index: String(unit.index),
								total: String(total),
							})
				}
				className="absolute inset-x-0 top-0 flex h-[72px] items-center justify-center"
				role="img"
			>
				{complete ? (
					<PathTrophy />
				) : (
					<PathChest progress={unit.doneCount / total} />
				)}
				<MilestoneLabel
					swing={swing}
					text={milestoneCaption(unit.doneCount, total, tl)}
				/>
			</div>
		</PathRow>
	);
}

/** A milestone's caption: one line, vertically centered on the art. */
function MilestoneLabel({ swing, text }: { swing: number; text: string }) {
	return (
		<span aria-hidden="true" className={labelPlacement(swing)}>
			<span className="block truncate font-bold text-(--gk-ink-muted) text-[15px] leading-5">
				{text}
			</span>
		</span>
	);
}

/**
 * The end of the path: one trophy for everything on it, lit once every stop
 * is finished.
 */
export function PathFinishItem({
	done,
	swing,
	total,
}: {
	done: number;
	swing: number;
	total: number;
}) {
	const tl = useLiteralMessages();
	const complete = total > 0 && done === total;
	const counts = { done: String(done), total: String(total) };
	return (
		<PathRow fit="art" swing={swing}>
			<div
				aria-label={tl("End of the path: {done} of {total} finished", counts)}
				className="absolute inset-x-0 top-0 flex h-[72px] items-center justify-center"
				role="img"
			>
				<PathTrophy locked={!complete} />
				<MilestoneLabel
					swing={swing}
					text={
						complete
							? "Path complete"
							: tl("{done} of {total} finished", counts)
					}
				/>
			</div>
		</PathRow>
	);
}
