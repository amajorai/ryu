import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { BoardAvatar } from "./board-avatar.tsx";
import { type PathUnit, pathSwing, pathUnitKindLabel } from "./path-model.ts";
import {
	PathAddItem,
	PathMilestoneItem,
	PathStopItem,
	pathAddKey,
} from "./path-stop.tsx";
import { PATH_TONES } from "./path-tone.ts";

const MEMBER_LIMIT = 3;

function BannerMembers({
	members,
	ring,
}: {
	members: InterfaceAgent[];
	ring: string;
}) {
	if (members.length === 0) {
		return null;
	}
	const shown = members.slice(0, MEMBER_LIMIT);
	const extra = members.length - shown.length;
	return (
		<span className="flex shrink-0 -space-x-2 max-sm:hidden">
			{shown.map((agent) => (
				<BoardAvatar
					agent={agent}
					className={cn("size-9 ring-[3px]", ring)}
					key={agent.id}
					name={agent.name}
					size={28}
				/>
			))}
			{extra > 0 ? (
				<span
					aria-hidden="true"
					className={cn(
						"z-10 flex size-9 items-center justify-center rounded-full bg-(--gk-plate) font-bold text-(--gk-ink) text-xs ring-[3px]",
						ring
					)}
				>
					+{extra}
				</span>
			) : null}
		</span>
	);
}

/** Where a unit's `+` starts a thread, for its spoken and visible label. */
function addLabel(unit: PathUnit, tl: LiteralMessage) {
	if (unit.kind === "project") {
		return {
			label: tl("New thread in {title}", { title: unit.title }),
			meta: `In ${unit.title}`,
		};
	}
	if (unit.kind === "unfiled") {
		return { label: "New thread", meta: "Pick an agent later" };
	}
	return {
		label: tl("New thread with {title}", { title: unit.title }),
		meta: `With ${unit.title}`,
	};
}

/**
 * One unit: a colored banner that sticks to the top while its stops scroll
 * under it (the next unit's banner pushes it away), then its stops, its
 * milestone, and a `+` to add a thread to it.
 */
export function PathUnitSection({
	activeThreadId,
	now,
	onOpen,
	onStart,
	pathStart,
	reduceMotion,
	tabStopKey,
	unit,
}: {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: (unit: PathUnit) => void;
	/** The path index of this unit's first item, so the winding runs on. */
	pathStart: number;
	reduceMotion: boolean;
	/** The key of the path's single Tab stop. */
	tabStopKey: string | null;
	unit: PathUnit;
}) {
	const tl = useLiteralMessages();
	const tone = PATH_TONES[unit.tone];
	const headingId = `path-unit-${unit.index}`;
	const add = addLabel(unit, tl);
	const stopCount = unit.stops.length;
	const addPosition = stopCount + (unit.milestone ? 1 : 0);
	const addKey = pathAddKey(unit.id);
	return (
		<section aria-labelledby={headingId} data-unit-id={unit.id}>
			<div className="sticky @max-[719px]/game:top-11 top-15 z-20 pt-4 pb-4">
				<div
					className={cn(
						"relative flex min-h-[92px] items-center gap-4 overflow-hidden rounded-[20px] border-(--gk-edge) border-2 px-5 py-4 shadow-(--gk-lip)",
						tone.fill,
						tone.onFill
					)}
				>
					{/* A lit top edge, so the banner reads as a raised sign. */}
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-white/10"
					/>
					<div className="relative min-w-0 flex-1">
						<p className="font-extrabold text-[13px] uppercase leading-4 tracking-wider opacity-90">
							{tl("Unit {index} · {kindLabel}", {
								index: String(unit.index),
								kindLabel: pathUnitKindLabel(unit.kind),
							})}
						</p>
						<h2
							className="gk-display mt-1 truncate text-[26px] leading-8"
							id={headingId}
						>
							{unit.title}
						</h2>
						<p className="truncate font-semibold text-[15px] leading-5 opacity-95">
							{unit.description}
						</p>
					</div>
					<BannerMembers members={unit.members} ring={tone.ring} />
				</div>
			</div>
			<ul
				aria-label={tl("{title} threads", { title: unit.title })}
				className="flex flex-col pt-16"
			>
				{unit.stops.map((stop, position) => (
					<PathStopItem
						key={stop.thread.id}
						now={now}
						onOpen={onOpen}
						reduceMotion={reduceMotion}
						selected={stop.thread.id === activeThreadId}
						stop={stop}
						swing={pathSwing(pathStart + position)}
						tabStop={stop.thread.id === tabStopKey}
						tone={unit.tone}
					/>
				))}
				{unit.milestone ? (
					<PathMilestoneItem
						swing={pathSwing(pathStart + stopCount)}
						unit={unit}
					/>
				) : null}
				<PathAddItem
					label={add.label}
					meta={add.meta}
					onStart={() => onStart(unit)}
					stopKey={addKey}
					swing={pathSwing(pathStart + addPosition)}
					tabStop={addKey === tabStopKey}
				/>
			</ul>
		</section>
	);
}
