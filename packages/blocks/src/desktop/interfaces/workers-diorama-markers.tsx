/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import {
	bubbleOverlayId,
	type OffStage,
	slotOf,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { LifeBubbleTag } from "./game3d-life.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import { isWorkBubble } from "./game3d-villager.tsx";
import {
	doorSpots,
	plateBubble,
	screenActivity,
	type WorkersActHandlers,
} from "./workers-acts.tsx";
import {
	deskPoint,
	SCREEN,
	SCREEN_Y,
	SEAT,
	SEAT_X,
	SLAB,
} from "./workers-diorama-geometry.ts";
import {
	CHAIR_OUT,
	DESK_DEPTH,
	type OfficeDesk,
	type OfficePlan,
	WORKER_STATE_LABELS,
	type WorkerView,
} from "./workers-model.ts";
import { deskLabel, StatusLight, screenTitle } from "./workers-status.tsx";

const NO_SHOWN: ReadonlySet<string> = new Set();

/**
 * The act layer, when the host sends asks (workers-acts.tsx): workers act
 * out their acts, desks and the door carry the act props, and the
 * chair-back name plate is each agent's one target (it goes where its
 * worker stands: the door's queue while it asks, the coffee corner while
 * it rests). Without it the office is today's.
 */
export interface WorkersActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: WorkersActHandlers;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	/** What each screen plate says (the workers' `screenWords` setting). */
	screenWords?: "step" | "title";
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
}

/** What a screen plate says to a screen reader, with acts. */
export function actScreenLabel(
	worker: WorkerView,
	act: InterfaceAgentAct,
	tl: LiteralMessage,
	words: "step" | "title" = "step"
): string {
	return tl("{name}'s screen: {screenWords}", {
		name: worker.name,
		screenWords: actScreenWords(worker, act, words) ?? tl("dark"),
	});
}

/**
 * What a worker's screen shows with acts: its activity, but an idle worker's
 * screen shows its task's title, or nothing (never "Idle" over a desk whose
 * worker has an answer or a suggestion waiting). With `words` "title" every
 * screen with a task shows the task's title instead of the step.
 */
export function actScreenWords(
	worker: WorkerView,
	act: InterfaceAgentAct,
	words: "step" | "title" = "step"
): string | null {
	if (words === "title" && worker.current) {
		return screenTitle(worker);
	}
	if (act.act === "idle" && !act.stalled) {
		return worker.current ? screenTitle(worker) : null;
	}
	return screenActivity(act);
}

/**
 * The workers' DOM targets: a screen plate over each monitor (its activity
 * with acts, out of the Tab order then) and the name plate, each agent's
 * one target, hanging wherever its worker stands: on its chair back, in
 * the door's queue while it asks, in the coffee corner while it rests.
 */
export function WorkerMarkers({
	actScene,
	onOpenScreen,
	onOpenWorker,
	plan,
	rests,
	selectedId,
}: {
	actScene: WorkersActScene | null;
	onOpenScreen: (workerId: string) => void;
	onOpenWorker: (workerId: string) => void;
	plan: OfficePlan;
	/** Where resting workers stand (their coffee-corner spots). */
	rests: ReadonlyMap<string, Vec3 | null>;
	selectedId: string | null;
}) {
	const tl = useLiteralMessages();
	const door = doorSpots(plan, SLAB);
	const shown = actScene?.handlers.shown ?? NO_SHOWN;
	const { workBubbles } = useGameKitSettings();
	/** Where a worker's name plate hangs: wherever the worker stands. */
	const plateAt = (desk: OfficeDesk, act: InterfaceAgentAct): Vec3 => {
		const slot = slotOf(actScene?.slots.slots ?? [], act.agentId);
		const queued = slot ? door.slots[Number(slot.slice(-1)) - 1] : undefined;
		if (act.act === "asking" && queued) {
			return [queued[0], queued[1] + 1.75, queued[2]];
		}
		const rest = rests.get(desk.worker.id);
		if (rest) {
			return [rest[0], rest[1] + 1.6, rest[2]];
		}
		return deskPoint(desk.x, desk.z, [SEAT_X, SLAB + 0.62, CHAIR_OUT + 0.42]);
	};
	/**
	 * Where a worker's figure is (head and feet): in its queue slot, at its
	 * resting spot, else seated on its chair. The kit's own figure probes
	 * ride villager plates, which the office draws as markers instead.
	 */
	const figureAt = (
		desk: OfficeDesk,
		act: InterfaceAgentAct
	): { feet: Vec3; head: Vec3 } => {
		const slot = slotOf(actScene?.slots.slots ?? [], act.agentId);
		const queued = slot ? door.slots[Number(slot.slice(-1)) - 1] : undefined;
		const standing =
			act.act === "asking" && queued ? queued : rests.get(desk.worker.id);
		if (standing) {
			return {
				feet: standing,
				head: [standing[0], standing[1] + FIGURE_TALL, standing[2]],
			};
		}
		return {
			feet: deskPoint(desk.x, desk.z, [SEAT_X, SLAB, CHAIR_OUT]),
			head: deskPoint(desk.x, desk.z, [SEAT_X, SLAB + SEAT + 0.95, CHAIR_OUT]),
		};
	};
	return (
		<>
			{plan.desks.map(({ worker, x, z }) => {
				const act = actScene?.acts.get(worker.id);
				if (!(worker.current || act)) {
					return null;
				}
				const words = act
					? actScreenWords(worker, act, actScene?.screenWords)
					: screenTitle(worker);
				if (words === null) {
					return null;
				}
				return (
					<IsoMarker
						at={deskPoint(x, z, [
							0,
							SLAB + SCREEN_Y + SCREEN[1] / 2 + 0.2,
							-DESK_DEPTH / 2 + 0.16,
						])}
						className="h-6 gap-1 px-2 text-[12px]"
						// With acts the name plate is each agent's one Tab stop; the
						// screen still opens its task on a click or tap.
						focusable={!act}
						icon={<StatusLight className="size-2.5" state={worker.state} />}
						iconOnly={actScene?.handlers.iconOnly ?? false}
						key={worker.id}
						label={
							act
								? `${actScreenLabel(worker, act, tl, actScene?.screenWords)}. ${worker.current ? "Open the task" : "Open their desk"}`
								: screenLabel(worker)
						}
						onSelect={() => onOpenScreen(worker.id)}
					>
						<StatusLight className="size-2" state={worker.state} />
						<span className="max-w-32 truncate">{words}</span>
					</IsoMarker>
				);
			})}
			{/* Name plates hang on the chair backs, clear of the screens. */}
			{plan.desks.map((desk) => {
				const { worker, x, z } = desk;
				const act = actScene?.acts.get(worker.id);
				if (!(actScene && act)) {
					return (
						<IsoMarker
							at={deskPoint(x, z, [SEAT_X, SLAB + 0.62, CHAIR_OUT + 0.42])}
							className="gap-1.5"
							key={`name:${worker.id}`}
							label={tl("{label}. Open their desk", {
								label: deskLabel(worker),
							})}
							onSelect={() => onOpenWorker(worker.id)}
							pressed={selectedId === worker.id}
						>
							<StatusLight className="size-2" state={worker.state} />
							{worker.name}
						</IsoMarker>
					);
				}
				const asking = act.act === "asking" && act.ask ? act.ask : null;
				const queued =
					asking !== null && slotOf(actScene.slots.slots, act.agentId) !== null;
				const figure = figureAt(desk, act);
				const bubbleId = bubbleOverlayId(act);
				const plate = bubbleId && shown.has(bubbleId) ? plateBubble(act) : null;
				// The kit's work-bubbles setting, as the kit's villagers read it.
				const bubble =
					plate && (workBubbles || !isWorkBubble(plate)) ? plate : null;
				return (
					<group key={`name:${worker.id}`}>
						<FigureProbe agentId={act.agentId} at={figure.head} edge="head" />
						<FigureProbe agentId={act.agentId} at={figure.feet} edge="feet" />
						<IsoMarker
							actAgent={act.agentId}
							activate={asking ? () => actScene.onAsk(asking.id) : undefined}
							at={plateAt(desk, act)}
							className="relative gap-1.5"
							iconOnly={queued ? false : actScene.handlers.iconOnly}
							key={`name:${worker.id}`}
							label={
								asking
									? tl("{ariaLabel} Answer their ask.", {
											ariaLabel: act.ariaLabel,
										})
									: tl("{ariaLabel} Open their desk.", {
											ariaLabel: act.ariaLabel,
										})
							}
							onSelect={() => onOpenWorker(worker.id)}
							pressed={selectedId === worker.id}
							youSpot={queued ? "slot" : undefined}
						>
							{bubble ? <LifeBubbleTag bubble={bubble} /> : null}
							<StatusLight className="size-2" state={worker.state} />
							{asking && queued
								? queuePlateText(
										act.agentName,
										{
											approx: asking.sinceApprox,
											since: asking.since,
											until: asking.expiresAt ?? null,
											untilApprox: asking.expiresApprox,
										},
										actScene.handlers.nowMs
									)
								: worker.name}
						</IsoMarker>
					</group>
				);
			})}
		</>
	);
}

/** A standing worker's head above its feet (world units). */
const FIGURE_TALL = 1.35;

/**
 * A hidden, zero-size marker at a worker's head or feet (the kit's
 * `data-act-figure` / `data-figure-edge` contract), for checks that no
 * prop covers the figure.
 */
function FigureProbe({
	agentId,
	at,
	edge,
}: {
	agentId: string;
	at: Vec3;
	edge: "feet" | "head";
}) {
	return (
		<Html position={at}>
			<span
				aria-hidden="true"
				className="pointer-events-none block size-0"
				data-act-figure={agentId}
				data-figure-edge={edge}
			/>
		</Html>
	);
}

/** What a screen plate says to a screen reader. */
export function screenLabel(worker: WorkerView): string {
	return `${worker.name}'s screen: ${screenTitle(worker)}, ${WORKER_STATE_LABELS[worker.state]}. Open the task`;
}
