import { translate as tr } from "@ryu/i18n/lite";
import { cn } from "@ryu/ui/lib/utils";
import type { WorkerState, WorkerView } from "./workers-model.ts";
import { wk, wkFaded } from "./workers-palette.ts";

/** The light on each state: the legend, the sheet and the screen plates. */
export const STATE_LIGHT: Record<WorkerState, string> = {
	attention: wk("led-attention"),
	idle: wk("led-idle"),
	paused: wk("led-paused"),
	working: wk("led-working"),
	"your-turn": wk("led-your-turn"),
};

/** A status light: a lit bead with a soft halo (pulsing while working). */
export function StatusLight({
	className,
	state,
}: {
	className?: string;
	state: WorkerState;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2.5 shrink-0 rounded-full",
				state === "working" && "wk-pulse",
				className
			)}
			style={{
				backgroundColor: STATE_LIGHT[state],
				boxShadow: `0 0 0 1.5px ${wkFaded("bezel-edge", 55)}, 0 0 8px ${STATE_LIGHT[state]}`,
			}}
		/>
	);
}

/** What a worker's controls say to a screen reader. */
export function deskLabel(worker: WorkerView): string {
	const name = worker.name;
	// The state's own words (WORKER_STATE_LABELS), selected inside each
	// message so a translator can inflect them in the sentence.
	const state = worker.state === "your-turn" ? "yourTurn" : worker.state;
	if (worker.current) {
		return tr(
			"{name}, {state, select, attention {Needs attention} idle {Idle} paused {Paused} working {Working} other {Waiting on you}}, working on {title}",
			{
				name,
				state,
				title: worker.current.title.trim() || tr("Untitled"),
			}
		);
	}
	return tr(
		"{name}, {state, select, attention {Needs attention} idle {Idle} paused {Paused} working {Working} other {Waiting on you}}, no tasks yet",
		{ name, state }
	);
}

/** A conversation's title for a screen, with a fallback for blank ones. */
export function screenTitle(worker: WorkerView): string {
	return worker.current?.title.trim() || tr("Untitled");
}
