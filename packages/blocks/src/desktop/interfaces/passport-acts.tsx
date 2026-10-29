/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ClockOptions,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	waitBand,
} from "@ryuhq/protocol/interfaces";
import { useEffect, useRef, useState } from "react";
import type { Group, Mesh } from "three";
import { GAME_PLATE } from "./game-hud.tsx";
import {
	ActStation,
	LIMIT_TONE,
	type LimitText,
	limitIsLikely,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actBubble,
	actKey,
	actorTarget,
	type BudgetItem,
	bubbleOverlayId,
	type OffStage,
	SHORT_BUBBLE_SECONDS,
	WORK_BUBBLE_SECONDS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { ALARM_SPACING } from "./game3d-alarm.tsx";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import {
	LIFE_FACE_CAMERA,
	type LifeAction,
	type LifeItem,
	type LifePaths,
	type LifeScript,
	type LifeStep,
} from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { bandColor, queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type { MemberLooks, VillagerSpec } from "./game3d-villager.tsx";
import {
	type DeskLayout,
	type DeskStation,
	deskPoint,
	PAGE_TOP,
} from "./passport-desk.tsx";
import { PASSPORT_ACT_ART } from "./passport-palette.ts";

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

/** Where an agent's villager stands: on its tab. */
export function officerAt(station: DeskStation): Vec3 {
	return station.at;
}

/** An officer's stance for its act (it stays on its tab). */
function officerAction(act: InterfaceAgentAct): LifeAction {
	switch (act.act) {
		case "asking":
			return act.carry === null ? "wave" : "look";
		case "blocked":
			return "slump";
		case "working":
			return act.stalled ? "idle" : "work";
		case "waiting":
			return "look";
		default:
			return "idle";
	}
}

/**
 * The officer's script: at its tab, its stance and its act's bubble (a
 * work bubble fades after 6 s and is left out under reduced motion). On a
 * phone (`narrow`) a delivery says nothing: its page set down on the
 * customs desk carries it, and its bubble would cover the next tabs.
 */
export function officerLife(
	act: InterfaceAgentAct,
	station: Vec3,
	reduced: boolean,
	narrow = false
): LifeScript {
	const bubble = actBubble(act);
	const steps: LifeStep[] = [
		{ bubble: null, do: "say" },
		{ at: station, do: "place", facing: LIFE_FACE_CAMERA },
		{ action: officerAction(act), do: "pose" },
	];
	const work = act.act === "working";
	// Blocked and limited officers say nothing: their alarm or limit note
	// carries the words (one overlay, spec 4.1 item 2).
	const speaks =
		act.act === "asking" ||
		(act.act === "delivering" && !narrow) ||
		act.act === "waiting" ||
		(work && !reduced && !act.stalled);
	if (bubble && speaks) {
		let seconds: number | undefined;
		if (work || act.act === "waiting") {
			seconds = WORK_BUBBLE_SECONDS;
		} else if (act.act === "delivering") {
			seconds = SHORT_BUBBLE_SECONDS;
		}
		steps.push({ bubble, do: "say", seconds });
	}
	if (act.act === "blocked") {
		steps.push({ do: "effect", effect: "smoke" });
	}
	return {
		idle: [{ do: "wait", seconds: 5 }],
		key: actKey(act, { paths: { links: [], points: {} }, station: "tab" }),
		steps,
	};
}

/** The officers as act villagers (plus their helpers), named by their acts. */
export function actOfficers({
	acts,
	layout,
	looks,
	narrow = false,
	onAsk,
	reduced,
	shown,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	layout: DeskLayout;
	looks: ReadonlyMap<string, MemberLooks>;
	/** A phone's stage: icon plates, and no delivery bubbles. */
	narrow?: boolean;
	onAsk: (askId: string) => void;
	reduced: boolean;
	shown: ReadonlySet<string>;
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	for (const station of layout.stations) {
		const agentId = station.country?.agent.id;
		const act = agentId ? acts.get(agentId) : undefined;
		const look = agentId ? looks.get(agentId) : undefined;
		if (!(act && look)) {
			continue;
		}
		const at = officerAt(station);
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		cast.push({
			actAgent: act.agentId,
			activate: asking ? () => onAsk(asking.id) : undefined,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			// Bubbles hang outward, off the booklet's pages: up from a back
			// tab, to the side from a side tab.
			bubbleSide: station.edge === "top" ? "up" : station.edge,
			facing: LIFE_FACE_CAMERA,
			id: act.agentId,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Apply for a visa.`,
			life: officerLife(act, at, reduced, narrow),
			looks: look,
			name: act.agentName,
			pose: "idle",
			position: at,
		});
		cast.push(
			...apprenticeSpecs({
				agentId: act.agentId,
				helpers: act.helpers,
				looks: look,
				station: at,
			})
		);
	}
	return cast;
}

/**
 * The narrowest room (px) where a spread's side tabs have space for a work
 * bubble hung outward and its back row's clip strip for alarm words. A
 * spread squeezed beside a sheet is narrower: its bubble would push the
 * plate onto a page, and alarm words parted in the strip would slide onto
 * the pages.
 */
export const ROOMY_DESK = 1024;

/**
 * Whether the desk keeps an act overlay, so no plate or bubble covers the
 * printed page (the notes' rule). A phone (icon-only plates) drops every
 * work bubble (working, waiting, delivering): an officer stands on a tab
 * hard by the page. A spread short of `ROOMY_DESK` drops a side tab's work
 * bubble, which hangs outward and would push its plate onto a page; a back
 * tab's still rises off the booklet. The words stay in the plate's label.
 */
export function deskKeeps(
	item: BudgetItem,
	layout: DeskLayout,
	{ iconOnly, roomy }: { iconOnly: boolean; roomy: boolean }
): boolean {
	if (item.kind !== "work-bubble") {
		return true;
	}
	if (iconOnly) {
		return false;
	}
	if (roomy) {
		return true;
	}
	const agentId = item.id.slice(item.id.indexOf(":") + 1);
	return !layout.stations.some(
		(station) => station.edge !== "top" && station.country?.agent.id === agentId
	);
}

/**
 * The customs desk's places in desk coordinates (across, toward): the
 * queue "you-1".."you-4" in a row before the booklet's front edge, front
 * first from the desk leftward, "you-tray" on the desk, "you" before it
 * (an ask with no queue place left), the desk itself and its lamp.
 */
const CUSTOMS = {
	single: {
		desk: [2.4, 4.5],
		lamp: [3.9, 4.2],
		// Clear of a left tab's status board, which hangs below the page.
		slots: [
			[-1.0, 1.45],
			[2.0, 1.45],
			[-1.0, 2.95],
			[2.0, 2.95],
		],
		tally: [-3.9, 3.8],
		tray: [0.2, 4.4],
		you: [-0.2, 3.7],
	},
	spread: {
		desk: [3.6, 2.7],
		lamp: [5.8, 2.4],
		slots: [
			[-0.6, 1.85],
			[-3.4, 1.85],
			[-6.2, 1.85],
			[-9.0, 1.85],
		],
		tally: [-8.6, 2.9],
		tray: [2.8, 2.6],
		you: [1.6, 1.7],
	},
} as const;

function customs(layout: DeskLayout, point: readonly [number, number], y = 0) {
	return deskPoint(point[0], layout.halfB + point[1], y);
}

/** The customs desk's places on the desk (world). */
export function customsPoints(layout: DeskLayout): Record<string, Vec3> {
	const plan = CUSTOMS[layout.mode];
	const points: Record<string, Vec3> = {
		you: customs(layout, plan.you),
		"you-tray": customs(layout, plan.tray),
	};
	for (const [index, slot] of plan.slots.entries()) {
		points[`you-${index + 1}`] = customs(layout, slot);
	}
	return points;
}

/** The waypoints: the customs places and every tab (where slips start). */
export function deskPaths(layout: DeskLayout): LifePaths {
	const points: Record<string, Vec3> = { ...customsPoints(layout) };
	const links: [string, string][] = [];
	for (const station of layout.stations) {
		if (!station.country) {
			continue;
		}
		const id = `tab-${station.country.agent.id}`;
		points[id] = station.at;
		links.push([id, "you"]);
	}
	return { links, points };
}

/** Where the kit's you-spot pieces sit at the customs desk. */
export function customsLayout(layout: DeskLayout): YouSpotLayout {
	const plan = CUSTOMS[layout.mode];
	const points = customsPoints(layout);
	const at = (id: YouSlot): Vec3 => points[id] ?? [0, 0, 0];
	const tray = customs(layout, plan.tray, 0.55);
	const step = deskPoint(0.55, 0);
	return {
		offStage: customs(layout, plan.tally),
		slots: {
			"you-1": at("you-1"),
			"you-2": at("you-2"),
			"you-3": at("you-3"),
			"you-4": at("you-4"),
		},
		tally: customs(layout, plan.tally, 0.6),
		timer: deskPoint(0.55, 0.25),
		tray,
		trayStep: step,
	};
}

/**
 * A tab's pieces in its margin lane, off the printed page:
 * [across, out, up], `out` away from the booklet and `across` screen-right
 * on the back edge or toward the desk's back (screen up) on a side edge.
 */
type Lane = Record<
	| "alarms"
	| "board"
	| "cue"
	| "limit"
	| "next"
	| "pips"
	| "suggestion"
	| "unread",
	readonly [number, number, number]
>;

/**
 * Where a tab's notes (alarms, the status board with its limit words, the
 * answer-ready and suggestion notes) are clipped: in a margin lane outside
 * the printed page, so they never cover a page's header, name or status.
 * A side tab's notes hang outward, off the booklet's side. The back row
 * stands back from the booklet (`RING`), and a back tab's notes ride in the
 * clip strip that opens between the row and the booklet's back edge, in
 * one row on a wide stage (further alarms step along the strip) and rising
 * as icons on a phone. A back tab's status board stands behind its row,
 * above the name plates and speech bubbles.
 */
const LANES: Record<DeskLayout["mode"], { side: Lane; top: Lane }> = {
	single: {
		side: {
			alarms: [0.3, 0.55, 0],
			board: [-1.5, 2.0, 0],
			cue: [0, 0, 0.02],
			limit: [0.9, 0.45, 0],
			next: [-0.9, 0.5, 0],
			pips: [-0.7, 0.45, 0.05],
			suggestion: [0.75, 0.75, 0],
			unread: [-0.55, 0.8, 0],
		},
		top: {
			alarms: [0, -1.45, 0],
			board: [0, -1.25, 0],
			cue: [0, 0, 0.02],
			limit: [-0.8, 0.4, 0],
			next: [0.8, 0.45, 0],
			pips: [-0.75, 0.35, 0.05],
			suggestion: [-0.8, -1.3, 0],
			unread: [0.8, -1.3, 0],
		},
	},
	spread: {
		side: {
			alarms: [0.35, 0.75, 0],
			board: [-0.9, 1.9, 0],
			cue: [0, 0, 0.02],
			limit: [1.0, 0.5, 0],
			next: [-1.3, 0.7, 0],
			pips: [-0.5, 0.6, 0.05],
			suggestion: [0.85, 1.0, 0],
			unread: [-0.7, 1.0, 0],
		},
		top: {
			// The notes sink to the strip's paper (their beacons and marks
			// under the desk), so each plate lies in the strip's one row.
			alarms: [0, -1.1, -0.9],
			board: [0, 4.6, 0],
			cue: [0, 0, 0.02],
			limit: [-0.9, 0.5, 0],
			next: [0.9, 0.6, 0],
			pips: [-0.9, 0.4, 0.05],
			suggestion: [-1.25, -1.1, -0.6],
			unread: [1.25, -1.1, -0.3],
		},
	},
};

/**
 * How far each further back-row alarm steps along the strip (desk units),
 * so the column never climbs into the row behind: a wide stage's plates
 * carry words, a phone's are icons.
 */
const STRIP_STEP = { single: 1.1, spread: 2.5 } as const;

/**
 * A tab's station layout on the desk: its lane turned to its edge, so its
 * notes sit off the printed page whichever side it is on.
 */
export function stationLayout(
	station: DeskStation,
	narrow = false
): Partial<StationLayout> {
	const top = station.edge === "top";
	const lane = LANES[narrow ? "single" : "spread"][top ? "top" : "side"];
	const place = ([across, out, up]: readonly [number, number, number]): Vec3 =>
		top
			? deskPoint(across, -out, up)
			: deskPoint(station.out[0] * out, -across, up);
	const layout: Partial<StationLayout> = {
		alarmSide: station.edge === "top" ? "center" : station.edge,
		alarms: place(lane.alarms),
		board: place(lane.board),
		cue: place(lane.cue),
		limit: place(lane.limit),
		next: place(lane.next),
		pips: place(lane.pips),
		suggestion: place(lane.suggestion),
		unread: place(lane.unread),
	};
	if (top) {
		// Each further alarm steps along the strip (the beacons' own spacing
		// added back), so the column never climbs into the row behind.
		const step = deskPoint(STRIP_STEP[narrow ? "single" : "spread"], 0);
		layout.alarmRows = 0;
		layout.alarmStep = [step[0] + ALARM_SPACING, 0, step[2]];
	}
	return layout;
}

/**
 * Whether an officer is DENIED: it has a counted failure (the rule
 * `actTotals.failed` counts by). An interrupted run keeps the kit's grey
 * flag and a rate limit its closed border, with no red stamp.
 */
export function deniedOf(act: InterfaceAgentAct): boolean {
	return act.blockers.some(
		(blocker) =>
			blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
	);
}

/** The limit in the passport's words: "Border closed till 15:10". */
export const borderClosed: LimitText = (act, clearsAt) => {
	const words = clearsAt ? `border closed till ${clearsAt}` : "border closed";
	return limitIsLikely(act)
		? words
		: `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/**
 * The limit on a phone, where a side tab's lane is narrower than the full
 * words: "Opens 15:10" (or "Closed" with no reset time).
 */
export const borderOpens: LimitText = (act, clearsAt) => {
	const words = clearsAt ? `opens ${clearsAt}` : "closed";
	return limitIsLikely(act)
		? words
		: `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

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

/**
 * The customs desk: a small counter with its lamp, which burns in the
 * band colour of the oldest ask waiting (first in `compareAsks` order) and
 * pulses only in the last two minutes before an expiry, never under
 * reduced motion.
 */
function CustomsDesk({
	at,
	first,
	lampAt,
	nowMs,
	reduced,
}: {
	at: Vec3;
	first: InterfaceAsk | undefined;
	lampAt: Vec3;
	nowMs: number;
	reduced: boolean;
}) {
	const bulb = useRef<Mesh>(null);
	const since = first?.since ? Date.parse(first.since) : null;
	const until = first?.expiresAt ? Date.parse(first.expiresAt) : null;
	const band = first ? waitBand(since, nowMs, until) : "unknown";
	const pulse = band === "expiring" && !reduced;
	useFrame(({ clock }) => {
		const node = bulb.current;
		if (!node) {
			return;
		}
		node.scale.setScalar(
			pulse ? 1 + Math.sin(clock.elapsedTime * 6) * 0.18 : 1
		);
	});
	return (
		<group>
			<group position={at} rotation={[0, Math.PI / 4, 0]}>
				<ToonMesh
					castShadow
					color={PASSPORT_ACT_ART.stampHandle}
					ink={0.02}
					position={[0, 0.25, 0]}
				>
					<boxGeometry args={[1.9, 0.5, 0.8]} />
				</ToonMesh>
				<ToonMesh
					color={PASSPORT_ACT_ART.page}
					ink={0.012}
					position={[0, 0.53, 0]}
				>
					<boxGeometry args={[2.0, 0.06, 0.9]} />
				</ToonMesh>
			</group>
			<group position={lampAt}>
				<ToonMesh
					castShadow
					color={PASSPORT_ACT_ART.lampStand}
					ink={0.015}
					position={[0, 0.05, 0]}
				>
					<cylinderGeometry args={[0.28, 0.32, 0.1, 16]} />
				</ToonMesh>
				<ToonMesh color={PASSPORT_ACT_ART.lampStand} position={[0, 0.6, 0]}>
					<cylinderGeometry args={[0.04, 0.04, 1.1, 8]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={PASSPORT_ACT_ART.lampShade}
					ink={0.015}
					position={[0, 1.2, 0]}
				>
					<coneGeometry args={[0.36, 0.42, 16, 1, true]} />
				</ToonMesh>
				<mesh position={[0, 1.02, 0]} ref={bulb}>
					<sphereGeometry args={[0.16, 14, 10]} />
					<meshBasicMaterial
						color={first ? bandColor(band) : PASSPORT_ACT_ART.bulb}
						toneMapped={false}
					/>
				</mesh>
			</group>
		</group>
	);
}

/** The customs desk's empty-state line. */
export const NO_VISAS_WAITING = "No visas waiting";

/**
 * The customs desk with no act layer (a host that sends no asks): the
 * counter and its unlit lamp at the booklet's front edge, and a plate on
 * the counter that says the desk is empty.
 */
export function EmptyCustomsDesk({ layout }: { layout: DeskLayout }) {
	const plan = CUSTOMS[layout.mode];
	return (
		<group>
			<CustomsDesk
				at={customs(layout, plan.desk)}
				first={undefined}
				lampAt={customs(layout, plan.lamp)}
				nowMs={0}
				reduced
			/>
			<group position={customs(layout, plan.desk, 0.95)}>
				<Html center zIndexRange={[18, 0]}>
					<p
						className={cn(
							GAME_PLATE,
							"gk-display pointer-events-none flex h-7 select-none items-center whitespace-nowrap rounded-full px-2.5 text-(--gk-ink-muted) text-[12px] leading-none"
						)}
						data-customs-empty=""
						data-iso-plate=""
					>
						{NO_VISAS_WAITING}
					</p>
				</Html>
			</group>
		</group>
	);
}

/**
 * Where the DENIED stamp stands from its villager: inward on the page edge,
 * or, for a wide stage's back tab (whose clip strip holds its alarm notes),
 * beside the villager in its row.
 */
function deniedAt(station: DeskStation, narrow: boolean): Vec3 {
	const inward = station.edge === "top" && !narrow ? 0 : 0.7;
	const a = station.ab[0] - station.out[0] * inward - station.along[0] * 0.95;
	const b = station.ab[1] - station.out[1] * inward - station.along[1] * 0.95;
	return deskPoint(a, b, inward === 0 ? 0 : PAGE_TOP);
}

/**
 * A DENIED stamp for an officer with a counted stopped run, whatever it is
 * doing now (it stays in sight while another run works): a red stamp block
 * on its page edge with "DENIED" pressed on its tag. The alarm notes beside
 * it carry the reason and open the blocker card.
 */
function DeniedStamp({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={PASSPORT_ACT_ART.sealRed}
				ink={0.02}
				position={[0, 0.12, 0]}
			>
				<cylinderGeometry args={[0.24, 0.27, 0.24, 16]} />
			</ToonMesh>
			<ToonMesh color={PASSPORT_ACT_ART.stampHandle} position={[0, 0.36, 0]}>
				<cylinderGeometry args={[0.07, 0.09, 0.26, 10]} />
			</ToonMesh>
			<group position={[0, 0.3, 0]}>
				<Html center zIndexRange={[16, 0]}>
					<span
						aria-hidden="true"
						className="gk-display pointer-events-none -rotate-6 select-none rounded-md border-(--gk-bad) border-2 bg-(--gk-plate) px-1.5 font-bold text-(--gk-bad) text-[12px] uppercase leading-5 tracking-wider"
						data-iso-plate=""
					>
						Denied
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
