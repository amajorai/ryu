/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import {
	type LimitText,
	limitIsLikely,
	type StationLayout,
} from "./game3d-act-stage.tsx";
import { ALARM_SPACING } from "./game3d-alarm.tsx";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import {
	type DeskLayout,
	type DeskStation,
	deskPoint,
	PAGE_TOP,
} from "./passport-desk.tsx";
import { PASSPORT_ACT_ART } from "./passport-palette.ts";

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
 * Where the DENIED stamp stands from its villager: inward on the page edge,
 * or, for a wide stage's back tab (whose clip strip holds its alarm notes),
 * beside the villager in its row.
 */
export function deniedAt(station: DeskStation, narrow: boolean): Vec3 {
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
export function DeniedStamp({ at }: { at: Vec3 }) {
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
