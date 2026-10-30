/* eslint-disable react/no-unknown-property */

import { useFrame } from "@react-three/fiber";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { type RefObject, useMemo, useRef, useState } from "react";
import type { Group, Vector3 } from "three";
import {
	ActStation,
	type StationLayout,
	stationLines,
	YouSpots,
} from "./game3d-act-stage.tsx";
import { queuePlateText, timerLevel } from "./game3d-meters.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import {
	ARC_HORIZON,
	arcPipCount,
	arcSpans,
	BOARD_LIFT,
	BOARD_STEP,
	boardBeside,
	boardLift,
	boardSize,
	ProgressArc,
	SCENE_EDGE_PX,
	worldPerPx,
} from "./planets-acts-board.tsx";
import {
	type ActSim,
	PLANETS_SKIN,
	PLATE_LIFT,
	type PlanetsActView,
	PROBE_ICONS,
	planetStationLayout,
	planetsLimitText,
	probePlace,
	screenPoint,
	stationLayout,
	type Vec3,
} from "./planets-acts-layout.ts";
import {
	CargoCapsule,
	PlanetFollow,
	PlanetSigns,
	ProbeFlight,
	RingLight,
	StationHull,
	StationRig,
} from "./planets-acts-station.tsx";
import type { Planet, PlanetSystem } from "./planets-model.ts";
import { moonKey } from "./planets-overlay.tsx";
import { PLANETS_ACT } from "./planets-palette.ts";

export {
	type ArcSpan,
	arcSpans,
	boardBeside,
	boardLift,
	boardSize,
} from "./planets-acts-board.tsx";
export {
	type ActSim,
	PLANETS_SKIN,
	type PlanetsActView,
	PROBE_ICONS,
	planetStationLayout,
	planetsLimitText,
	probePlace,
	STATION_NARROW,
	STATION_UNIT_PX,
	screenAxes,
	stationLayout,
	stationStripBox,
} from "./planets-acts-layout.ts";

/**
 * The Planets act layer in the canvas (spec §5 planets row). A space station
 * with four berths hangs in the foreground, held at the same place on
 * screen whatever the camera does: an asking agent's probe launches from
 * its planet and docks in its berth, where a ring light drains with the
 * wait; a ready answer waits as a cargo capsule (blinking while unread,
 * steady under reduced motion). At each planet: a red storm band for a
 * failed run, a dark moon for an interrupted one, an eclipse with "Back
 * 15:10" for a limit, a satellite on an orbit marker while it works, and
 * the kit's station (alarms, unread, suggestions, the status board). An arc
 * of pips round the focus moon (the act's thread) shows the plan's
 * progress. Every in-scene plate is a pointer target only (tabIndex -1):
 * the planet list and the ask queue carry the keyboard (a list game).
 */

/**
 * A planet's kit station, its board placed (in steps) clear of the world
 * and of its progress arc as the camera's zoom changes their size on
 * screen: lifted over the planet in the overview, beside it in a phone's
 * column.
 */
function PlanetStation({
	act,
	azimuth,
	column,
	layout,
	planet,
	reduced,
	sim,
	view,
}: {
	act: InterfaceAgentAct;
	azimuth: number;
	column: boolean;
	layout: Partial<StationLayout>;
	planet: Planet;
	reduced: boolean;
	sim: RefObject<ActSim>;
	view: PlanetsActView;
}) {
	const lines = stationLines(act, view.shown, {
		clock: view.clock,
		limitText: planetsLimitText,
		nowMs: view.nowMs,
	});
	const size = boardSize(lines);
	const arcPips = arcPipCount(act, planet);
	const alarms = act.blockers.length > 0;
	const moon =
		planet.moons.find((item) => item.threadId === act.threadId) ?? null;
	const [place, setPlace] = useState({ right: 0, up: BOARD_LIFT });
	const scratch = useRef<Vector3 | null>(null);
	useFrame(({ camera, size: screen }) => {
		const at = sim.current.positions.get(planet.id);
		if (!at || size.height === 0 || screen.height <= 0) {
			return;
		}
		const scale = sim.current.bodyScale;
		const depth = Math.hypot(
			at[0] - camera.position.x,
			at[1] - camera.position.y,
			at[2] - camera.position.z
		);
		const perPx = worldPerPx(depth, screen.height);
		const planetPx = (planet.radius * scale) / perPx;
		// The screen's right and up axes in the world (the camera's columns).
		const axes = camera.matrixWorld.elements;
		const right: Vec3 = [axes[0] ?? 1, axes[1] ?? 0, axes[2] ?? 0];
		const up: Vec3 = [axes[4] ?? 0, axes[5] ?? 1, axes[6] ?? 0];
		const body = moon
			? sim.current.moonGroups.get(moonKey(planet.id, moon.threadId))
			: undefined;
		const arcs =
			moon && body && arcPips > 0
				? arcSpans({
						horizon: reduced ? 0 : ARC_HORIZON,
						moon,
						offset: [body.position.x, body.position.y, body.position.z],
						perPx,
						pips: arcPips,
						right,
						scale,
						up,
					})
				: [];
		// A phone's column keeps the usual lift where the board clears its
		// world there (the next world up stands just above), else the board
		// goes beside.
		const tall = BOARD_LIFT * planetPx - size.height / 2 < planetPx;
		if (column && !tall) {
			if (place.right !== 0 || place.up !== BOARD_LIFT) {
				setPlace({ right: 0, up: BOARD_LIFT });
			}
			return;
		}
		if (column) {
			scratch.current ??= camera.position.clone();
			const centre = scratch.current.set(...at).project(camera);
			const room = screen.width * (1 - (centre.x * 0.5 + 0.5)) - SCENE_EDGE_PX;
			const beside = boardBeside({ alarms, arcs, planetPx, room, size });
			if (beside !== place.right || place.up !== 0) {
				setPlace({ right: beside, up: 0 });
			}
			return;
		}
		const needed = boardLift({ arcs, planetPx, size });
		// Rise at once; settle back only past a step (no flicker at an edge).
		if (
			place.right !== 0 ||
			needed > place.up ||
			needed < place.up - BOARD_STEP
		) {
			setPlace({ right: 0, up: needed });
		}
	});
	const placed = useMemo(
		() => ({
			...layout,
			board: screenPoint(azimuth, column, place.right, place.up),
		}),
		[azimuth, column, layout, place]
	);
	return (
		<ActStation
			act={act}
			at={[0, 0, 0]}
			clock={view.clock}
			focusable={false}
			iconOnly={view.iconOnly}
			layout={placed}
			limitText={planetsLimitText}
			nowMs={view.nowMs}
			onAsk={view.onAsk}
			onBlocker={view.onBlocker}
			pipSkin={{
				done: PLANETS_ACT.pipDone,
				todo: PLANETS_ACT.pipTodo,
			}}
			privacy={view.privacy}
			reduced={reduced}
			shown={view.shown}
			snapshot={view.snapshot}
		/>
	);
}

/**
 * The whole act layer: the station in the foreground (berths, probes,
 * capsule, tallies) and every planet's signs and station.
 */
export function PlanetsActLayer({
	azimuth,
	reduced,
	sim,
	system,
	view,
}: {
	azimuth: number;
	reduced: boolean;
	sim: RefObject<ActSim>;
	system: PlanetSystem;
	view: PlanetsActView;
}) {
	const tl = useLiteralMessages();
	const rig = useRef<Group>(null);
	const column = system.column === true;
	const station = stationLayout(view.width, column);
	const layout = useMemo(
		() => planetStationLayout(azimuth, column),
		[azimuth, column]
	);
	const slots = view.slots.slots;
	const asking = slots.filter((slot) => slot.carrier === "villager");
	return (
		<group>
			<StationRig anchor={station.anchor} rig={rig} />
			{asking.map((slot) => {
				const act = slot.agentId ? view.acts.get(slot.agentId) : undefined;
				const place = act ? probePlace(act, slots, reduced) : "home";
				if (!act || place === "home" || place === "tray" || place === "you") {
					return null;
				}
				return (
					<ProbeFlight
						agentId={act.agentId}
						berth={station.berths[place]}
						color={PLANETS_ACT.probe[slot.ask.kind]}
						key={slot.ask.id}
						radius={
							system.planets.find((planet) => planet.id === act.agentId)
								?.radius ?? 1
						}
						reduced={reduced}
						rig={rig}
						sim={sim}
					/>
				);
			})}
			<group ref={rig}>
				<StationHull berths={station.berths} />
				{asking.map((slot) => {
					const act = slot.agentId ? view.acts.get(slot.agentId) : undefined;
					if (!act) {
						return null;
					}
					const berth = station.berths[slot.point];
					const Icon = PROBE_ICONS[slot.ask.kind];
					const timer = {
						approx: slot.ask.sinceApprox,
						since: slot.ask.since,
						until: slot.ask.expiresAt ?? null,
						untilApprox: slot.ask.expiresApprox,
					};
					return (
						<group key={slot.ask.id}>
							<RingLight at={berth} level={timerLevel(timer, view.nowMs)} />
							<IsoMarker
								actAgent={act.agentId}
								activate={() => view.onAsk(slot.ask.id)}
								at={[berth[0], berth[1] + PLATE_LIFT, berth[2]]}
								focusable={false}
								label={tl("{ariaLabel} Answer their ask.", {
									ariaLabel: act.ariaLabel,
								})}
								youSpot="slot"
							>
								<Icon aria-hidden="true" className="size-3.5" />
								{queuePlateText(act.agentName, timer, view.nowMs)}
							</IsoMarker>
						</group>
					);
				})}
				{view.onStage
					.filter((act) => act.act === "delivering" && act.ask)
					.slice(0, 1)
					.map((act) => (
						<CargoCapsule
							at={station.layout.tray}
							key={act.agentId}
							reduced={reduced}
						/>
					))}
				<YouSpots
					focusable={false}
					iconOnly={view.iconOnly}
					item={PLANETS_SKIN.deliverable}
					layout={station.layout}
					nowMs={view.nowMs}
					offStage={view.offStage}
					onAsk={view.onAsk}
					onOpenQueue={view.onQueue}
					onStage={view.onStage}
					owners={view.owners}
					privacy={view.privacy}
					reduced={reduced}
					shown={view.shown}
					slots={view.slots}
					snapshot={view.snapshot}
					timerSkin={{ color: PLANETS_ACT.hullDark }}
				/>
			</group>
			{system.planets.map((planet) => {
				const act = view.acts.get(planet.id);
				if (!act) {
					return null;
				}
				return (
					<group key={planet.id}>
						<PlanetFollow planet={planet} sim={sim}>
							<PlanetSigns
								act={act}
								azimuth={azimuth}
								column={column}
								reduced={reduced}
							/>
							<PlanetStation
								act={act}
								azimuth={azimuth}
								column={column}
								layout={layout}
								planet={planet}
								reduced={reduced}
								sim={sim}
								view={view}
							/>
						</PlanetFollow>
						<ProgressArc
							act={act}
							azimuth={azimuth}
							column={column}
							planet={planet}
							sim={sim}
						/>
					</group>
				);
			})}
		</group>
	);
}
