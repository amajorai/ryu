import { cn } from "@ryu/ui/lib/utils";
import {
	WORKER_STATE_LABELS,
	type WorkerState,
	type WorkerView,
} from "./workers-model.ts";
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
	const parts = [worker.name, WORKER_STATE_LABELS[worker.state]];
	if (worker.current) {
		parts.push(`working on ${worker.current.title.trim() || "Untitled"}`);
	} else {
		parts.push("no tasks yet");
	}
	return parts.join(", ");
}

/** A conversation's title for a screen, with a fallback for blank ones. */
export function screenTitle(worker: WorkerView): string {
	return worker.current?.title.trim() || "Untitled";
}
