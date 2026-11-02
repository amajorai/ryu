import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import type { FocusEvent, KeyboardEvent, RefObject } from "react";
import { GamePlate } from "./game-hud.tsx";
import { NAV_HINT_ID, PATH_GEOMETRY } from "./path-interface-nav.tsx";
import { type PathModel, type PathUnit, pathSwing } from "./path-model.ts";
import { PathFinishItem } from "./path-stop.tsx";
import { PathUnitSection } from "./path-unit.tsx";

export interface PathListProps {
	activeThreadId: string | null;
	model: PathModel;
	now: number;
	onFocus: (event: FocusEvent<HTMLDivElement>) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	onOpen: (threadId: string) => void;
	onStart: (unit: PathUnit) => void;
	pathEnd: number;
	pathStarts: readonly number[];
	reduceMotion: boolean;
	rovingKey: string | null;
	scrollerRef: RefObject<HTMLDivElement | null>;
}

/** Without WebGL (and in tests) the path is a plain list of the same stops. */
export function PathList({
	activeThreadId,
	model,
	now,
	onFocus,
	onKeyDown,
	onOpen,
	onStart,
	pathEnd,
	pathStarts,
	reduceMotion,
	rovingKey,
	scrollerRef,
}: PathListProps) {
	return (
		<div
			aria-describedby={NAV_HINT_ID}
			className="absolute inset-0 overflow-y-auto overscroll-contain @max-[719px]/game:pt-16 pt-24"
			onFocus={onFocus}
			onKeyDown={onKeyDown}
			ref={scrollerRef}
		>
			<div className="@container/col mx-auto w-full min-w-0 max-w-[600px] px-4 pb-16">
				<div className={cn("relative", PATH_GEOMETRY)}>
					{model.units.map((unit, position) => (
						<PathUnitSection
							activeThreadId={activeThreadId}
							key={unit.id}
							now={now}
							onOpen={onOpen}
							onStart={onStart}
							pathStart={pathStarts[position] ?? 0}
							reduceMotion={reduceMotion}
							tabStopKey={rovingKey}
							unit={unit}
						/>
					))}
					<ul aria-label="End of the path" className="relative pt-4">
						<PathFinishItem
							done={model.doneCount}
							swing={pathSwing(pathEnd)}
							total={model.stopCount}
						/>
					</ul>
				</div>
				<p className="sr-only" id={NAV_HINT_ID}>
					Up and Down arrows move between stops; Home and End jump to the first
					and last. Escape closes the open thread.
				</p>
			</div>
		</div>
	);
}

/** The empty path: an invitation to start the first conversation. */
export function PathEmpty({ onStart }: { onStart: () => void }) {
	return (
		<div className="flex flex-1 items-center justify-center px-6">
			<GamePlate className="flex max-w-sm flex-col items-center gap-4 px-6 py-6 text-center">
				<div
					aria-hidden="true"
					className="flex size-16 items-center justify-center rounded-full border-(--gk-edge)/45 border-[3px] border-dashed text-(--gk-ink-muted)"
				>
					<Plus className="size-8" strokeWidth={3} />
				</div>
				<div className="flex flex-col gap-1.5">
					<h2 className="gk-display text-[24px] leading-7">
						No conversations yet
					</h2>
					<p className="text-pretty font-medium text-(--gk-ink-muted) text-sm leading-5">
						Each conversation becomes a stop on your path, grouped by project,
						team, and agent. Start one to take the first step.
					</p>
				</div>
				<Button onClick={onStart} type="button">
					<Plus aria-hidden="true" data-icon="inline-start" />
					Start a thread
				</Button>
			</GamePlate>
		</div>
	);
}
