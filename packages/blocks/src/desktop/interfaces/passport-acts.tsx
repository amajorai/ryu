/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ClockOptions,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useRef, useState } from "react";
import type { Group } from "three";
import { GAME_PLATE } from "./game-hud.tsx";
import { ActStation, LIMIT_TONE, YouSpots } from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actorTarget,
	type OffStage,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import type { LifeItem, LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import {
	CUSTOMS,
	CustomsDesk,
	customs,
	customsLayout,
} from "./passport-acts-customs.tsx";
import { officerAt } from "./passport-acts-officers.ts";
import {
	borderClosed,
	borderOpens,
	DeniedStamp,
	deniedAt,
	deniedOf,
	stationLayout,
} from "./passport-acts-stations.tsx";
import type { DeskLayout } from "./passport-desk.tsx";
import { PASSPORT_ACT_ART } from "./passport-palette.ts";

export {
	customsLayout,
	customsPoints,
	deskPaths,
	EmptyCustomsDesk,
	NO_VISAS_WAITING,
} from "./passport-acts-customs.tsx";
export {
	actOfficers,
	deskKeeps,
	officerAt,
	officerLife,
	ROOMY_DESK,
} from "./passport-acts-officers.ts";
export {
	borderClosed,
	borderOpens,
	deniedOf,
	stationLayout,
} from "./passport-acts-stations.tsx";

/**
 * Passport's act layer (spec §5, passport row). Each agent's villager
 * stays on its visa page's index tab, stamping while it works. What
 * travels is its ask: a visa slip waiting for your signature slides from
 * its tab to the customs desk at the booklet's front edge and waits in the
 * queue there (via `actorTarget`), under the desk lamp, which burns in the
 * oldest wait's band colour. Alarms, limits, the answer-ready and
 * suggestion notes ride in a margin lane outside the printed page by each
 * tab (`stationLayout`), so they never cover a page; a counted
 * failure also gets a red DENIED stamp, and a delivered answer is set down
 * on the customs desk as a stamped page.
 */

/**
 * The limit plate on a phone: the kit's amber, a little tighter, so
 * "Opens 15:10" fits a side tab's lane, pinned to the stage's edge, without
 * reaching over the printed page.
 */
const PHONE_LIMIT_TONE = cn(LIMIT_TONE, "px-1.5");

/** The ink and stamped pages as progress pips. */
const INK_PIPS = {
	done: PASSPORT_ACT_ART.pipDone,
	estimate: PASSPORT_ACT_ART.pipEstimate,
	todo: PASSPORT_ACT_ART.pipTodo,
} as const;

/** A stamped page: what a delivered answer is set down as on the desk. */
const PAGE: LifeItem = { color: PASSPORT_ACT_ART.page, shape: "letter" };

/** How fast a slip slides across the desk (world units a second). */
const SLIDE_SPEED = 6;

/**
 * An asking agent's visa slip: it slides from the agent's tab to its place
 * in the customs queue (straight there under reduced motion), waiting for
 * your signature. Its plate reads "Ada · 14m". It is a label, not a
 * control: the agent's villager plate is its one target (it answers the
 * ask), so the agent has a single Tab stop.
 */
function AskSlip({
	act,
	arrive,
	from,
	nowMs,
	reduced,
	to,
}: {
	act: InterfaceAgentAct;
	/** False for a slip present on the first frame: it starts in place. */
	arrive: boolean;
	from: Vec3;
	nowMs: number;
	reduced: boolean;
	to: Vec3;
}) {
	const group = useRef<Group>(null);
	// Captured once: a later move (a place freeing up) slides from where the
	// slip is to its new `to`.
	const start = useRef<Vec3>(arrive && !reduced ? from : to);
	useFrame((_, delta) => {
		const node = group.current;
		if (!node) {
			return;
		}
		if (reduced) {
			node.position.set(to[0], to[1], to[2]);
			return;
		}
		const dx = to[0] - node.position.x;
		const dz = to[2] - node.position.z;
		const left = Math.hypot(dx, dz);
		if (left > 1e-3) {
			const step = Math.min(left, SLIDE_SPEED * delta);
			node.position.x += (dx / left) * step;
			node.position.z += (dz / left) * step;
		}
	});
	const ask = act.ask;
	if (!ask) {
		return null;
	}
	const destructive = ask.choices?.some((choice) => choice.destructive);
	const timer = {
		approx: ask.sinceApprox,
		since: ask.since,
		until: ask.expiresAt ?? null,
		untilApprox: ask.expiresApprox,
	};
	return (
		<group position={start.current} ref={group}>
			<group rotation={[0, Math.PI / 4, 0]}>
				<ToonMesh
					castShadow
					color={PASSPORT_ACT_ART.slip}
					ink={0.015}
					position={[0, 0.03, 0]}
				>
					<boxGeometry args={[0.78, 0.04, 0.56]} />
				</ToonMesh>
				{[-0.1, 0.04].map((z) => (
					<ToonMesh
						color={PASSPORT_ACT_ART.slipRule}
						key={z}
						position={[-0.08, 0.052, z]}
					>
						<boxGeometry args={[0.46, 0.004, 0.03]} />
					</ToonMesh>
				))}
				<ToonMesh
					color={
						destructive ? PASSPORT_ACT_ART.sealRed : PASSPORT_ACT_ART.sealAmber
					}
					ink={0.012}
					position={[0.24, 0.07, 0.14]}
				>
					<cylinderGeometry args={[0.1, 0.1, 0.05, 14]} />
				</ToonMesh>
			</group>
			<group position={[0, 0.75, 0]}>
				<Html center zIndexRange={[35, 0]}>
					<span
						aria-hidden="true"
						className={cn(
							GAME_PLATE,
							"gk-display pointer-events-none flex h-7 select-none items-center whitespace-nowrap rounded-full px-2 text-[12px] leading-none"
						)}
						data-iso-plate=""
						data-you-spot="slot"
					>
						{queuePlateText(act.agentName, timer, nowMs)}
					</span>
				</Html>
			</group>
		</group>
	);
}

export interface PassportActPropsInput {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	iconOnly: boolean;
	layout: DeskLayout;
	/**
	 * A spread short of `ROOMY_DESK`: the tabs' notes (alarms, answer-ready
	 * and suggestion notes) collapse to icons, as on a phone, so the clip
	 * strip's notes never part onto the pages.
	 */
	noteIcons?: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	paths: LifePaths;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
}

/** The act props: the customs desk (slips, queue, lamp, tray) and each tab's notes. */
export function PassportActProps({
	acts,
	clock,
	iconOnly,
	layout,
	noteIcons = false,
	nowMs,
	offStage,
	onAsk,
	onBlocker,
	onQueue,
	onStage,
	owners,
	paths,
	reduced,
	shown,
	slots,
	snapshot,
}: PassportActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	// Slips on the first frame start in the queue; later asks slide in.
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		setSettled(true);
	}, []);
	const slotFor = (agentId: string): YouSlot | null =>
		slots.slots.find(
			(slot) => slot.agentId === agentId && slot.carrier === "villager"
		)?.point ?? null;
	const first = slots.slots
		.map((slot) => slot.ask)
		.sort(compareAsks)
		.at(0);
	const stations = layout.stations.flatMap((station) => {
		const act = station.country
			? acts.get(station.country.agent.id)
			: undefined;
		return act ? [{ act, station }] : [];
	});
	const plan = CUSTOMS[layout.mode];
	return (
		<group>
			<CustomsDesk
				at={customs(layout, plan.desk)}
				first={first}
				lampAt={customs(layout, plan.lamp)}
				nowMs={nowMs}
				reduced={reduced}
			/>
			<YouSpots
				iconOnly={iconOnly}
				item={PAGE}
				layout={customsLayout(layout)}
				nowMs={nowMs}
				offStage={offStage}
				onAsk={onAsk}
				onOpenQueue={onQueue}
				onStage={onStage}
				owners={owners}
				privacy={privacy}
				reduced={reduced}
				shown={shown}
				slots={slots}
				snapshot={snapshot}
				timerSkin={{ color: PASSPORT_ACT_ART.timer }}
			/>
			{stations
				.filter(({ act }) => act.act === "asking" && act.ask)
				.map(({ act, station }) => {
					const spots: ActSpots = {
						paths,
						slot: slotFor(act.agentId),
						station: `tab-${act.agentId}`,
					};
					return (
						<AskSlip
							act={act}
							arrive={settled}
							from={station.at}
							key={`${act.agentId}:${act.ask?.id}`}
							nowMs={nowMs}
							reduced={reduced}
							to={actorTarget(act, spots, reduced).position}
						/>
					);
				})}
			{stations.map(({ act, station }) => (
				<group key={act.agentId}>
					{deniedOf(act) ? (
						<DeniedStamp at={deniedAt(station, iconOnly)} />
					) : null}
					<ActStation
						act={act}
						at={officerAt(station)}
						clock={clock}
						iconOnly={iconOnly || noteIcons}
						layout={stationLayout(station, iconOnly)}
						limitText={iconOnly ? borderOpens : borderClosed}
						limitTone={iconOnly ? PHONE_LIMIT_TONE : undefined}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						pipSkin={INK_PIPS}
						privacy={privacy}
						reduced={reduced}
						shown={shown}
						snapshot={snapshot}
					/>
				</group>
			))}
		</group>
	);
}
