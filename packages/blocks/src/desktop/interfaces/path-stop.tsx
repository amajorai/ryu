import { translate as tr } from "@ryu/i18n/lite";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import { relativeAge, threadStatusLabel } from "./interface-renderer.ts";
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

/** A stop button's accessible name: "Continue: Title. Meta, 5m ago." */
function stopLabel(parts: {
	action: string;
	age: string;
	meta: string;
	title: string;
}): string {
	const sentence = parts.age
		? tr("{title}. {meta}, {age}.", parts)
		: tr("{title}. {meta}.", parts);
	return parts.action
		? tr("{action}: {sentence}", { action: parts.action, sentence })
		: sentence;
}

function leadName(stop: PathStop): string {
	return stop.agents[0]?.name ?? tr("No agent");
}

/** The meta line under a stop's title, in the user's terms. */
export function stopMeta(stop: PathStop): string {
	switch (stop.state) {
		case "attention":
			return stop.thread.runState === "interrupted"
				? tr("Run stopped")
				: tr("Run failed");
		case "current":
			return stop.status === "attention"
				? tr("Run failed · needs you")
				: tr("Your turn · {name} replied", { name: leadName(stop) });
		case "done":
			return tr("Done");
		case "reply":
			return tr("Your turn · {name} replied", { name: leadName(stop) });
		case "working":
			return tr("{name} is working", { name: leadName(stop) });
		case "waiting":
			return stop.agents[0]
				? tr("Waiting on {name}", { name: leadName(stop) })
				: tr("No agent yet");
		default:
			return threadStatusLabel(stop.status);
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
		return tr("Review");
	}
	return stop.status === "quiet" ? tr("Start") : tr("Continue");
}

export function stopTitle(stop: PathStop): string {
	return stop.thread.title.trim() || tr("Untitled thread");
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
	const age = relativeAge(stop.thread.updatedAt, now);
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
				aria-label={stopLabel({
					action: current ? action : "",
					age,
					meta,
					title,
				})}
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
					className="absolute start-2 top-2 flex size-12 items-center justify-center rounded-full border-(--gk-edge)/45 border-[3px] border-dashed bg-(--gk-plate) text-(--gk-ink-muted) transition-colors duration-100 group-hover/stop:border-primary group-hover/stop:text-primary group-focus-visible/stop:ring-[3px] group-focus-visible/stop:ring-ring group-focus-visible/stop:ring-offset-(--gk-plate) group-focus-visible/stop:ring-offset-4 group-active/stop:bg-primary/10"
				>
					<Plus className="size-6" strokeWidth={3} />
				</span>
				<StopLabel
					className={cn("@max-[519px]/col:ms-3", swing > 0 ? "me-3" : "ms-3")}
					interactive
					meta={meta}
					swing={swing}
					title={tr("New thread")}
					titleClassName="text-(--gk-ink-muted) group-hover/stop:text-(--gk-ink)"
				/>
			</button>
		</PathRow>
	);
}
