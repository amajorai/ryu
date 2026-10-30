import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { compactAge } from "./interface-renderer.ts";
import type { PathStop, PathTone } from "./path-model.ts";
import {
	Callout,
	Coin,
	faceFor,
	PathFlag,
	StopIcon,
	StopRing,
} from "./path-stop-coin.tsx";
import {
	PATH_STOP_ATTRIBUTE,
	PathRow,
	type PathRowFit,
	PRESS_BUTTON,
	StopLabel,
} from "./path-stop-row.tsx";
import { PATH_TONES } from "./path-tone.ts";

export {
	milestoneCaption,
	PathFinishItem,
	PathMilestoneItem,
} from "./path-stop-milestone.tsx";
export {
	PATH_STOP_ATTRIBUTE,
	PathRow,
	type PathRowFit,
	pathAddKey,
} from "./path-stop-row.tsx";

function leadName(stop: PathStop): string {
	return stop.agents[0]?.name ?? "No agent";
}

/** The meta line under a stop's title, in the user's terms. */
export function stopMeta(stop: PathStop): string {
	switch (stop.state) {
		case "attention":
			return stop.thread.runState === "interrupted"
				? "Run stopped"
				: "Run failed";
		case "current":
			return stop.status === "attention"
				? "Run failed · needs you"
				: `Your turn · ${leadName(stop)} replied`;
		case "done":
			return "Done";
		case "reply":
			return `Your turn · ${leadName(stop)} replied`;
		case "working":
			return `${leadName(stop)} is working`;
		case "waiting":
			return stop.agents[0] ? `Waiting on ${leadName(stop)}` : "No agent yet";
		default:
			return THREAD_STATUS_LABELS[stop.status];
	}
}

/** The meta line's color: failures and live runs carry their status hue. */
export function stopMetaTone(state: PathStop["state"]): string | undefined {
	if (state === "attention") {
		return "text-status-destructive";
	}
	return state === "working" ? "text-status-success" : undefined;
}

/**
 * The callout's verb: a failed run is there to review, a reply to continue,
 * and a thread nobody has opened yet to start.
 */
export function stopAction(stop: PathStop): string {
	if (stop.status === "attention") {
		return "Review";
	}
	return stop.status === "quiet" ? "Start" : "Continue";
}

export function stopTitle(stop: PathStop): string {
	return stop.thread.title.trim() || "Untitled thread";
}

export function PathStopItem({
	now,
	onOpen,
	reduceMotion,
	selected,
	stop,
	swing,
	tabStop,
	tone,
}: {
	now: number;
	onOpen: (threadId: string) => void;
	reduceMotion: boolean;
	selected: boolean;
	stop: PathStop;
	swing: number;
	/** The path's one Tab stop; the rest are reached with the arrow keys. */
	tabStop: boolean;
	tone: PathTone;
}) {
	const title = stopTitle(stop);
	const meta = stopMeta(stop);
	const age = compactAge(stop.thread.updatedAt, now);
	const current = stop.state === "current";
	const ringed = current || stop.state === "working";
	const action = stopAction(stop);
	const { face, onFace } = faceFor(stop, tone);
	const currentInk = PATH_TONES[tone].ink;
	let fit: PathRowFit = "coin";
	if (current) {
		fit = "callout";
	} else if (ringed) {
		fit = "ring";
	}
	return (
		<PathRow done={stop.state === "done"} fit={fit} swing={swing}>
			{current ? <PathFlag swing={swing} /> : null}
			{ringed ? (
				<StopRing
					reduceMotion={reduceMotion}
					selected={selected}
					tone={tone}
					working={stop.state === "working"}
				/>
			) : null}
			{current ? (
				<Callout
					border={PATH_TONES[tone].border}
					ink={currentInk}
					label={action}
					reduceMotion={reduceMotion}
				/>
			) : null}
			<button
				aria-current={selected ? "true" : undefined}
				aria-label={`${current ? `${action}: ` : ""}${title}. ${meta}${age ? `, ${age === "now" ? "just now" : `${age} ago`}` : ""}.`}
				className={PRESS_BUTTON}
				data-thread-id={stop.thread.id}
				onClick={() => onOpen(stop.thread.id)}
				tabIndex={tabStop ? 0 : -1}
				type="button"
				{...{ [PATH_STOP_ATTRIBUTE]: stop.thread.id }}
			>
				<Coin
					face={face}
					halo={!ringed}
					onFace={cn(onFace, stop.state === "waiting" && "opacity-70")}
					selected={selected}
				>
					<StopIcon stop={stop} />
				</Coin>
				<StopLabel
					interactive
					meta={age ? `${meta} · ${age}` : meta}
					metaClassName={
						current && stop.status !== "attention"
							? currentInk
							: stopMetaTone(
									stop.status === "attention" ? "attention" : stop.state
								)
					}
					swing={swing}
					title={title}
				/>
			</button>
		</PathRow>
	);
}

export function PathAddItem({
	label,
	meta,
	onStart,
	stopKey,
	swing,
	tabStop,
}: {
	label: string;
	meta: string;
	onStart: () => void;
	stopKey: string;
	swing: number;
	tabStop: boolean;
}) {
	return (
		<PathRow fit="add" swing={swing}>
			<button
				aria-label={label}
				className={PRESS_BUTTON}
				onClick={onStart}
				tabIndex={tabStop ? 0 : -1}
				type="button"
				{...{ [PATH_STOP_ATTRIBUTE]: stopKey }}
			>
				<span
					aria-hidden="true"
					className="absolute top-2 left-2 flex size-12 items-center justify-center rounded-full border-(--gk-edge)/45 border-[3px] border-dashed bg-(--gk-plate) text-(--gk-ink-muted) transition-colors duration-100 group-hover/stop:border-primary group-hover/stop:text-primary group-focus-visible/stop:ring-[3px] group-focus-visible/stop:ring-ring group-focus-visible/stop:ring-offset-(--gk-plate) group-focus-visible/stop:ring-offset-4 group-active/stop:bg-primary/10"
				>
					<Plus className="size-6" strokeWidth={3} />
				</span>
				<StopLabel
					className={cn("@max-[519px]/col:ml-3", swing > 0 ? "mr-3" : "ml-3")}
					interactive
					meta={meta}
					swing={swing}
					title="New thread"
					titleClassName="text-(--gk-ink-muted) group-hover/stop:text-(--gk-ink)"
				/>
			</button>
		</PathRow>
	);
}
