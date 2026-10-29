/* eslint-disable react/no-unknown-property */
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	ActStation,
	type LimitText,
	limitIsLikely,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	type ActSpots,
	actLife,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	toolForActivity,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeCounts, apprenticeSpecs } from "./game3d-apprentice.tsx";
import { LIFE_FACE_CAMERA, type LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type { MemberLooks, VillagerSpec } from "./game3d-villager.tsx";
import { LOBBY_3D } from "./lobby-palette.ts";

/**
 * The lobby's act layer: the squad works at its places on the podium, each
 * at a console (its loading bar is the real progress), steps down to the
 * ready-check pad in front of it to ask (a ring and a banner light up
 * under the asker; notices for parked and unowned asks pin to posts
 * there), drops loot on the pad's tray for an unread answer, and shows its
 * stopped runs, cooldown, unread marks, suggestion notes and party slots
 * (helpers) at its place. Words only come from the act (`agentActs` on an
 * already-redacted snapshot); a limit reads "Cooldown, back 15:10" (or
 * "Likely cooldown, back 15:10" when the kit marks it estimated).
 */

/** What the lobby scene needs to act out the snapshot. */
export interface LobbyActView {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	/** Narrow stages: act props and plates collapse to glyphs. */
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	/** Owner names of asks, for notice plates ("Ada asks: …"). */
	owners: ReadonlyMap<string, string>;
	privacy: "full" | "redacted";
	/** The overlay budget's chosen ids (actOverlays). */
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
}

/** The lobby's produce: a loot drop. */
export const LOBBY_ACT_SKIN: ActSkin = {
	// Downed: a stopped run kneels by its console.
	blockedPose: "kneel",
	deliverable: { shape: "box" },
};

/** A floor point `across` the view (screen right) and `out` toward the camera. */
function floorPoint(across: number, out: number, y: number): Vec3 {
	const c = Math.SQRT1_2;
	return [across * c + out * c, y, -across * c + out * c];
}

/**
 * The ready-check pad in front of the podium. On wide stages the four
 * queue slots stand in one row, far enough apart that no plate covers the
 * next; on narrow (phone) stages they zig-zag in two columns wide of you
 * (left, right, left...) a step toward the camera each, so side by side
 * plates clear each other and you, and plates in one column stand a plate
 * height apart. The tray stands at the pad's right end (in front of you on
 * a phone); the off-stage tally stands beside the squad, on the podium's
 * right.
 */
export function lobbyYouSpot(narrow: boolean): {
	layout: YouSpotLayout;
	points: Record<string, Vec3>;
} {
	const slot = (index: number): Vec3 =>
		narrow
			? floorPoint(index % 2 === 0 ? -3.4 : 3.4, 3.9 + index * 1.3, 0)
			: floorPoint((index - 1.5) * 3.4, 5.6, 0);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((point, index) => [point, slot(index)])
	) as Record<YouSlot, Vec3>;
	// The wide tray stands front and centre, clear of the PLAY panel.
	// On a phone the tray stands in front of you, between the two columns.
	const tray = narrow ? floorPoint(0, 7.4, 0) : floorPoint(-0.4, 6.4, 0);
	const last = slot(3);
	return {
		layout: {
			// Wide: down at the podium's front right, clear of the squad's
			// alarms (they hang under their consoles). On a phone at the
			// front, below the queue's columns, off the squad's name plates.
			offStage: narrow ? floorPoint(0, 9.4, 0.3) : floorPoint(6.6, 1.4, 0.6),
			slots,
			tally: [last[0] + 0.9, 0.6, last[2] - 0.9],
			tray,
		},
		points: { ...slots, you: floorPoint(0, 4.3, 0), "you-tray": tray },
	};
}

/**
 * Waypoints: each place on the podium, its step at the podium's front
 * edge and the plaza below it, joined along the front to the pad.
 */
export function lobbyPaths(
	stations: ReadonlyMap<string, Vec3>,
	podiumHeight: number,
	podiumRadius: number,
	you: Record<string, Vec3>
): LifePaths {
	const points: Record<string, Vec3> = { ...you };
	const links: [string, string][] = [
		// Each place reached down its own column (never across you or
		// the tray between the phone's two columns).
		["you", "you-1"],
		["you", "you-2"],
		["you-1", "you-3"],
		["you-2", "you-4"],
		["you", "you-tray"],
	];
	const c = Math.SQRT1_2;
	for (const [id, at] of stations) {
		const across = (at[0] - at[2]) * c;
		const edge = `edge:${id}`;
		const below = `below:${id}`;
		points[`station:${id}`] = at;
		points[edge] = floorPoint(across, podiumRadius - 0.4, podiumHeight);
		points[below] = floorPoint(across, podiumRadius + 0.3, 0);
		links.push([`station:${id}`, edge], [edge, below], [below, "you"]);
	}
	return { links, points };
}

/** A point beside a station: `across` and `out` from it. */
function besideStation(station: Vec3, across: number, out: number): Vec3 {
	const offset = floorPoint(across, out, 0);
	return [station[0] + offset[0], station[1], station[2] + offset[2]];
}

/**
 * Where a member's station pieces sit, inside its own place (members stand
 * 1.85 apart): the console and its loading bar in front, the board's
 * words over the console, openers to the right, the next sign and the
 * cooldown clock to the left.
 */
export const LOBBY_STATION_LAYOUT: Partial<StationLayout> = {
	// Centred under the member's own console, climbing a row per alarm
	// over its own feet (dropping would meet the ready pad's queue): a
	// neighbour on either side, so hanging left or right covers one.
	alarmRows: 1,
	alarmSide: "center",
	alarms: floorPoint(0, 1.2, -0.9),
	board: floorPoint(0, 1.45, 0),
	cue: [0, 0.02, 0],
	limit: floorPoint(-0.55, 0.3, 0),
	next: floorPoint(-0.55, -0.6, 0),
	pips: floorPoint(0, 0.8, 0.62),
	suggestion: floorPoint(-0.55, 1.05, 0),
	unread: floorPoint(0.55, -0.45, 0),
};

/**
 * "Cooldown, back 15:10": the lobby's words for a usage limit; lowercase
 * after the kit's "Likely " when the limit is only estimated.
 */
export const lobbyLimitText: LimitText = (act, at) => {
	const words = at ? `cooldown, back ${at}` : "cooldown";
	return limitIsLikely(act) ? words : `C${words.slice(1)}`;
};

/**
 * A squad member's villager for its act: its life script, its plate named
 * by the act sentence (an asking member's plate is its queue plate,
 * "Ada · 14m", and answers the ask), its tool while working.
 */
export function lobbyMember({
	act,
	base,
	looks,
	paths,
	reduced,
	view,
}: {
	act: InterfaceAgentAct;
	base: Pick<VillagerSpec, "facing" | "id" | "position">;
	looks: MemberLooks;
	paths: LifePaths;
	reduced: boolean;
	view: LobbyActView;
}): VillagerSpec[] {
	const spots: ActSpots = {
		paths,
		slot: slotOf(view.slots.slots, act.agentId),
		station: `station:${act.agentId}`,
		stationFacing: base.facing ?? LIFE_FACE_CAMERA,
	};
	const ask = act.act === "asking" ? act.ask : null;
	const queued = ask !== null && spots.slot !== null;
	const bubbleId = bubbleOverlayId(act);
	let bubble = bubbleId ? view.shown.has(bubbleId) : true;
	if (reduced && act.act === "delivering") {
		// It never fades under reduced motion; the loot's count says it.
		bubble = false;
	}
	const member: VillagerSpec = {
		...base,
		activate: ask ? () => view.onAsk(ask.id) : undefined,
		actAgent: act.agentId,
		bubble,
		iconOnly: queued ? false : undefined,
		label: ask ? `${act.ariaLabel} Answer their ask.` : act.ariaLabel,
		life: actLife(act, spots, LOBBY_ACT_SKIN, { reduced }),
		looks: {
			...looks,
			tool: act.act === "working" ? toolForActivity(act.carry) : undefined,
		},
		name: ask
			? queuePlateText(
					act.agentName,
					{
						approx: ask.sinceApprox,
						since: ask.since,
						until: ask.expiresAt ?? null,
						untilApprox: ask.expiresApprox,
					},
					view.nowMs
				)
			: act.agentName,
		pose: "idle",
		youSpot: queued ? "slot" : undefined,
	};
	return [
		member,
		...apprenticeSpecs({
			agentId: act.agentId,
			helpers: act.helpers,
			looks,
			station: besideStation(base.position, 0.2, -0.5),
		}),
	];
}

/** A flat ring on the ground: the ready check, or a cooldown. */
function Ring({
	at,
	color,
	radius,
}: {
	at: Vec3;
	color: string;
	radius: number;
}) {
	return (
		<mesh
			position={[at[0], at[1] + 0.02, at[2]]}
			rotation={[-Math.PI / 2, 0, 0]}
		>
			<ringGeometry args={[radius - 0.08, radius, 40]} />
			<meshBasicMaterial color={color} toneMapped={false} />
		</mesh>
	);
}

/** The ready-check banner on a pole beside an asking member. */
function Banner({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, LIFE_FACE_CAMERA, 0]}>
			<ToonMesh color={LOBBY_3D.bannerPole} position={[0, 0.95, 0]}>
				<cylinderGeometry args={[0.03, 0.03, 1.9, 8]} />
			</ToonMesh>
			<ToonMesh color={LOBBY_3D.readyBanner} position={[-0.28, 1.65, 0]}>
				<boxGeometry args={[0.52, 0.34, 0.02]} />
			</ToonMesh>
		</group>
	);
}

/** A member's console: a low desk with a screen (the loading bar sits on it). */
function Console({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, LIFE_FACE_CAMERA, 0]}>
			<ToonMesh color={LOBBY_3D.consoleBody} position={[0, 0.27, 0]}>
				<boxGeometry args={[0.7, 0.54, 0.3]} />
			</ToonMesh>
			<mesh position={[0, 0.48, 0.16]}>
				<boxGeometry args={[0.56, 0.08, 0.01]} />
				<meshBasicMaterial color={LOBBY_3D.consoleScreen} toneMapped={false} />
			</mesh>
		</group>
	);
}

/** Up to three party slots behind a member: one per helper, lit while it runs. */
function PartySlots({
	act,
	station,
}: {
	act: InterfaceAgentAct;
	station: Vec3;
}) {
	if (!act.helpers) {
		return null;
	}
	const { failed, running } = apprenticeCounts(act.helpers);
	const colors = [0, 1, 2].map((index) => {
		if (index < running) {
			return LOBBY_3D.partyOn;
		}
		return index < running + failed ? LOBBY_3D.partyFailed : LOBBY_3D.partyOff;
	});
	return (
		<group>
			{colors.map((color, index) => {
				// Down the member's right side, clear of the figure and the console.
				const at = besideStation(station, 0.95, 0.15 + index * 0.4);
				return (
					<mesh
						// biome-ignore lint/suspicious/noArrayIndexKey: the slots are positional.
						key={index}
						position={[at[0], at[1] + 0.03, at[2]]}
						rotation={[-Math.PI / 2, 0, 0]}
					>
						<circleGeometry args={[0.13, 20]} />
						<meshBasicMaterial color={color} toneMapped={false} />
					</mesh>
				);
			})}
		</group>
	);
}

/**
 * Everything the act layer draws besides the squad: the kit's you-spot
 * (notices, timers, tallies, the loot tray), the ready-check rings and
 * banners under asking members, and each member's place (console, the
 * kit's station, cooldown ring, party slots).
 */
export function LobbyActProps({
	onStage,
	reduced,
	stations,
	view,
	you,
}: {
	onStage: readonly InterfaceAgentAct[];
	reduced: boolean;
	stations: ReadonlyMap<string, Vec3>;
	view: LobbyActView;
	you: { layout: YouSpotLayout; points: Record<string, Vec3> };
}) {
	return (
		<group>
			<YouSpots
				iconOnly={view.iconOnly}
				item={LOBBY_ACT_SKIN.deliverable}
				layout={you.layout}
				nowMs={view.nowMs}
				offStage={view.offStage}
				onAsk={view.onAsk}
				onOpenQueue={view.onQueue}
				onStage={onStage}
				owners={view.owners}
				privacy={view.privacy}
				reduced={reduced}
				shown={view.shown}
				slots={view.slots}
				snapshot={view.snapshot}
			/>
			{view.slots.slots
				.filter((slot) => slot.carrier === "villager")
				.map((slot) => {
					const at = you.layout.slots[slot.point];
					return (
						<group key={slot.ask.id}>
							<Ring at={at} color={LOBBY_3D.readyRing} radius={0.5} />
							<Banner at={besideStation(at, -0.75, 0.15)} />
						</group>
					);
				})}
			{onStage.map((act) => {
				const station = stations.get(act.agentId);
				if (!station) {
					return null;
				}
				return (
					<group key={act.agentId}>
						<Console at={besideStation(station, 0, 0.8)} />
						{act.act === "limited" ? (
							<Ring at={station} color={LOBBY_3D.cooldown} radius={0.62} />
						) : null}
						{/* Downed: a stopped run lays a red mat under the member. */}
						{act.act === "blocked" &&
						act.blockers[0] &&
						act.blockers[0].kind !== "interrupted" ? (
							<Ring at={station} color={LOBBY_3D.partyFailed} radius={0.62} />
						) : null}
						<PartySlots act={act} station={station} />
						<ActStation
							act={act}
							at={station}
							clock={view.clock}
							iconOnly={view.iconOnly}
							layout={LOBBY_STATION_LAYOUT}
							limitText={lobbyLimitText}
							nowMs={view.nowMs}
							onAsk={view.onAsk}
							onBlocker={view.onBlocker}
							privacy={view.privacy}
							reduced={reduced}
							shown={view.shown}
							snapshot={view.snapshot}
						/>
					</group>
				);
			})}
		</group>
	);
}
