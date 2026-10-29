import { cn } from "@ryu/ui/lib/utils";
import { Check, House, PackageCheck, Truck, Warehouse } from "lucide-react";
import { motion } from "motion/react";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	clockTime,
	isMoving,
	type StepState,
	stageStep,
	stepStates,
	TRACKING_STEPS,
	type TrackingParcel,
	type TrackingStage,
} from "./tracking-model.ts";

/** Seconds for the van to drive the leg ahead of the current step. */
const DRIVE_SECONDS = 3.6;
/** Where a live run's van parks under reduced motion: mid-leg. */
const PARKED_SHARE = 0.5;

/**
 * Horizontal centre of a step, in percent of the track. The route and the
 * stepper share five equal columns, so a step's node sits under its point.
 */
function stepPercent(index: number): number {
	return (index * 2 + 1) * (100 / (TRACKING_STEPS.length * 2));
}

const ROAD_START = stepPercent(0);
const ROAD_END = stepPercent(TRACKING_STEPS.length - 1);
/** Width of one leg between neighbouring steps, in percent. */
const LEG_PERCENT = stepPercent(1) - stepPercent(0);

type RouteTone = "delivered" | "exception" | "moving" | "waiting";

function routeTone(stage: TrackingStage): RouteTone {
	if (stage === "delivered") {
		return "delivered";
	}
	if (stage === "exception") {
		return "exception";
	}
	return isMoving(stage) ? "moving" : "waiting";
}

const VAN_TEXT: Record<RouteTone, string> = {
	delivered: "text-status-success",
	exception: "text-status-destructive",
	moving: "text-primary",
	waiting: "text-muted-foreground",
};

/** Where the van stands on the road, in percent of the track. */
function vanPercent(stage: TrackingStage, reduceMotion: boolean): number {
	// Before pickup the van waits just outside the depot.
	if (stage === "awaiting") {
		return ROAD_START + LEG_PERCENT * 0.35;
	}
	const at = stepPercent(stageStep(stage));
	return isMoving(stage) && reduceMotion ? at + LEG_PERCENT * PARKED_SHARE : at;
}

const ICON_CLASS = "absolute bottom-0 size-5 -translate-x-1/2";

/**
 * The illustrated route: the depot, the van and your door riding above the
 * stepper's own track, each over its step. While a run is live the van drives the
 * leg ahead of the current step and loops; under reduced motion it parks
 * mid-leg. Delivered, the van has gone and your door is ticked; a label has
 * no courier, so there is no van. Progress itself lives in the stepper.
 */
export function TrackingRoute({ parcel }: { parcel: TrackingParcel }) {
	const { stage } = parcel;
	const reduceMotion = useReducedMotion();
	const tone = routeTone(stage);
	const drive = isMoving(stage) && !reduceMotion;
	const vanAt = vanPercent(stage, reduceMotion);
	const timing = {
		duration: DRIVE_SECONDS,
		ease: "easeInOut" as const,
		repeat: Number.POSITIVE_INFINITY,
		repeatDelay: 0.2,
	};
	// The van starts each loop visible (so a still frame always shows it) and
	// fades as it nears the next stop.
	const fade = { ...timing, ease: "linear" as const, times: [0, 0.85, 1] };
	const showVan = stage !== "label" && stage !== "delivered";
	const truck = (
		<Truck className={cn("size-5", VAN_TEXT[tone])} strokeWidth={1.75} />
	);
	return (
		<div
			className="flex flex-col gap-3 rounded-xl border border-border bg-card px-6 pt-5 pb-6 text-card-foreground"
			data-route-tone={tone}
			data-testid="tracking-route"
		>
			<div aria-hidden="true" className="relative h-6">
				<Warehouse
					className={cn(ICON_CLASS, "text-muted-foreground")}
					strokeWidth={1.75}
					style={{ left: `${ROAD_START}%` }}
				/>
				{stage === "delivered" ? (
					<PackageCheck
						className={cn(ICON_CLASS, VAN_TEXT.delivered)}
						data-testid="tracking-van"
						strokeWidth={1.75}
						style={{ left: `${ROAD_END}%` }}
					/>
				) : (
					<House
						className={cn(ICON_CLASS, "text-muted-foreground")}
						strokeWidth={1.75}
						style={{ left: `${ROAD_END}%` }}
					/>
				)}
				{showVan && drive ? (
					<motion.span
						animate={{
							left: [`${vanAt}%`, `${vanAt + LEG_PERCENT * 0.8}%`],
							opacity: [1, 1, 0],
						}}
						className="absolute bottom-0 flex -translate-x-1/2"
						data-testid="tracking-van"
						transition={{ left: timing, opacity: fade }}
					>
						{truck}
					</motion.span>
				) : null}
				{showVan && !drive ? (
					<span
						className="absolute bottom-0 flex -translate-x-1/2"
						data-testid="tracking-van"
						style={{ left: `${vanAt}%` }}
					>
						{truck}
					</span>
				) : null}
			</div>
			<TrackingStepper parcel={parcel} />
		</div>
	);
}

function StepMarker({
	stage,
	state,
}: {
	stage: TrackingStage;
	state: StepState;
}) {
	if (state === "exception") {
		return (
			<span className="relative flex size-5 items-center justify-center rounded-full border-2 border-destructive bg-background">
				<span className="size-2 rounded-full bg-destructive" />
			</span>
		);
	}
	if (state === "done") {
		return (
			<span
				className={cn(
					"relative flex size-5 items-center justify-center rounded-full",
					stage === "delivered"
						? "bg-status-success text-background"
						: "bg-primary text-primary-foreground"
				)}
			>
				<Check aria-hidden="true" className="size-3" strokeWidth={3} />
			</span>
		);
	}
	if (state === "current") {
		// Awaiting pickup is a hold, not progress: a ring with no fill.
		return (
			<span
				className={cn(
					"relative flex size-5 items-center justify-center rounded-full border-2 bg-background",
					stage === "awaiting" ? "border-muted-foreground" : "border-primary"
				)}
			>
				{stage === "awaiting" ? null : (
					<span className="size-2 rounded-full bg-primary" />
				)}
			</span>
		);
	}
	return (
		<span className="relative block size-5 rounded-full border-2 border-border bg-background" />
	);
}

const STATE_TEXT: Record<StepState, string> = {
	current: "Current step",
	done: "Done",
	exception: "Exception",
	upcoming: "Not yet",
};

/** The step that carries the latest known time. */
function latestStep(parcel: TrackingParcel): number {
	return parcel.stage === "awaiting" ? 0 : stageStep(parcel.stage);
}

/** A step's label, swapped where the parcel is held there. */
function stepLabel(
	step: (typeof TRACKING_STEPS)[number],
	state: StepState,
	stage: TrackingStage
): string {
	if (state === "exception") {
		return "Exception";
	}
	if (state === "current" && stage === "awaiting") {
		return "Awaiting pickup";
	}
	return step;
}

type LegTone = "delivered" | "exception" | "travelled" | "upcoming";

/** How the leg leading into a step is drawn. */
function legTone(state: StepState | undefined, stage: TrackingStage): LegTone {
	if (state === "exception") {
		return "exception";
	}
	if (state === "done") {
		return stage === "delivered" ? "delivered" : "travelled";
	}
	// The van only travels a leg once it has the parcel.
	if (state === "current" && stage !== "awaiting") {
		return "travelled";
	}
	return "upcoming";
}

const LEG_CLASS: Record<LegTone, string> = {
	delivered: "h-1 bg-status-success",
	exception: "h-1 bg-destructive/70",
	travelled: "h-1 bg-primary",
	upcoming: "h-1 bg-border",
};

/**
 * The five classic scans in equal columns, joined by legs. Reached legs are
 * solid in the stage's tone; a delivered parcel turns the track
 * success-tinted. The step with the latest known time prints it. In narrow
 * columns labels drop to 11px and wrap to two lines rather than disappear.
 */
export function TrackingStepper({ parcel }: { parcel: TrackingParcel }) {
	const { stage } = parcel;
	const states = stepStates(stage);
	const updated = new Date(parcel.thread.updatedAt);
	const time = Number.isNaN(updated.getTime()) ? null : clockTime(updated);
	// A label only has a time once you have written something, and an
	// exception's time already leads the history below.
	const timedStep =
		(stage === "label" && !parcel.thread.lastMessageRole) ||
		stage === "exception"
			? -1
			: latestStep(parcel);
	const lastIndex = TRACKING_STEPS.length - 1;
	return (
		<ol
			aria-label="Delivery progress"
			className="@container grid grid-cols-5"
			data-testid="tracking-stepper"
		>
			{TRACKING_STEPS.map((step, index) => {
				const state = states[index] ?? "upcoming";
				const prominent = state === "current" || state === "exception";
				const intoTone = legTone(state, stage);
				const outTone = legTone(states[index + 1], stage);
				return (
					<li
						aria-current={prominent ? "step" : undefined}
						className="flex min-w-0 flex-col items-center gap-2 text-center"
						key={step}
					>
						<span className="relative flex h-5 w-full items-center justify-center">
							{index > 0 ? (
								<span
									aria-hidden="true"
									className={cn(
										"absolute top-1/2 right-1/2 left-0 -translate-y-1/2",
										LEG_CLASS[intoTone]
									)}
								/>
							) : null}
							{index < lastIndex ? (
								<span
									aria-hidden="true"
									className={cn(
										"absolute top-1/2 right-0 left-1/2 -translate-y-1/2",
										LEG_CLASS[outTone]
									)}
								/>
							) : null}
							<span aria-hidden="true" className="relative z-[2] flex">
								<StepMarker stage={stage} state={state} />
							</span>
						</span>
						<span className="flex min-w-0 flex-col gap-0.5 px-1">
							<span
								className={cn(
									"text-balance @md:text-sm text-xs @md:leading-5 leading-4",
									prominent
										? "font-medium text-foreground"
										: "text-muted-foreground",
									state === "done" && "text-foreground",
									state === "exception" && "text-status-destructive"
								)}
							>
								{stepLabel(step, state, stage)}
								<span className="sr-only">: {STATE_TEXT[state]}</span>
							</span>
							<span className="h-4 whitespace-nowrap @md:text-[13px] text-[11px] text-muted-foreground tabular-nums leading-4">
								{index === timedStep && time ? (
									<time dateTime={parcel.thread.updatedAt}>{time}</time>
								) : null}
							</span>
						</span>
					</li>
				);
			})}
		</ol>
	);
}
