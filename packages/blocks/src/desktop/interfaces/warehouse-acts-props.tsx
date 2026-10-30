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
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import type { ActSkin, OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { DISPATCH_DESK, youPoints } from "./warehouse-acts-queue.ts";
import {
	forkliftAt,
	type PickerStation,
	SLAB,
} from "./warehouse-acts-stations.ts";
import { tileToWorld } from "./warehouse-diorama.tsx";
import { WAREHOUSE_ACT_ART } from "./warehouse-palette.ts";

export const SKIN: ActSkin = {
	deliverable: {
		accent: WAREHOUSE_ACT_ART.parcelTape,
		color: WAREHOUSE_ACT_ART.parcel,
		shape: "box",
	},
};

/**
 * The limit in the warehouse's words, on the forklift's board: "Back 15:10",
 * "Parked for now" with no reset time. An inferred limit reads "Likely back
 * 15:10" (the kit adds "Likely ").
 */
export const forkliftLimit: LimitText = (act, clearsAt) => {
	const words = clearsAt ? `back ${clearsAt}` : "parked for now";
	return limitIsLikely(act)
		? words
		: `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** The basket's items as progress pips: picked, still to pick, a guess. */
const BASKET_PIPS = {
	done: WAREHOUSE_ACT_ART.pipDone,
	estimate: WAREHOUSE_ACT_ART.pipEstimate,
	todo: WAREHOUSE_ACT_ART.pipTodo,
} as const;

/** The dispatch desk by the dock, where answers are set down. */
function DispatchDesk() {
	const at = tileToWorld(DISPATCH_DESK.x, DISPATCH_DESK.y, SLAB);
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={WAREHOUSE_ACT_ART.desk}
				ink={0.02}
				position={[0, 0.3, 0]}
				scale={[1.2, 0.6, 0.5]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={WAREHOUSE_ACT_ART.deskTop}
				ink={0.015}
				position={[0, 0.63, 0]}
				scale={[1.3, 0.06, 0.6]}
			>
				<boxGeometry />
			</ToonMesh>
		</group>
	);
}

/** A small forklift, where a limited picker sits out its limit. */
function Forklift({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, Math.PI / 2, 0]}>
			<ToonMesh
				castShadow
				color={WAREHOUSE_ACT_ART.forklift}
				ink={0.02}
				position={[0, 0.2, 0]}
				scale={[0.5, 0.26, 0.7]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={WAREHOUSE_ACT_ART.forkliftMast}
				ink={0.015}
				position={[0, 0.55, 0.36]}
				scale={[0.42, 0.7, 0.05]}
			>
				<boxGeometry />
			</ToonMesh>
			{[-0.12, 0.12].map((x) => (
				<ToonMesh
					color={WAREHOUSE_ACT_ART.forkliftMast}
					key={x}
					position={[x, 0.06, 0.6]}
					scale={[0.06, 0.03, 0.42]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

/** How high a notice's pallet stack stands (world units). */
const NOTICE_LIFT = 0.8;

function lifted([x, y, z]: Vec3): Vec3 {
	return [x, y + NOTICE_LIFT, z];
}

/** The pallets a queue notice stands on, `NOTICE_LIFT` tall. */
function NoticePallets({ at }: { at: Vec3 }) {
	const [x, y, z] = at;
	return (
		<group position={[x, y, z]}>
			{[0, 1, 2].map((level) => (
				<ToonMesh
					castShadow={level === 0}
					color={
						level % 2 === 0
							? WAREHOUSE_ACT_ART.pallet
							: WAREHOUSE_ACT_ART.parcel
					}
					ink={0.015}
					key={level}
					position={[0, NOTICE_LIFT * ((level + 0.5) / 3), 0]}
					scale={[0.7, NOTICE_LIFT / 3, 0.6]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

export function dispatchLayout(narrow = false): YouSpotLayout {
	const points = youPoints(narrow);
	const at = (id: string) => points[id] ?? [0, 0, 0];
	const desk = tileToWorld(DISPATCH_DESK.x, DISPATCH_DESK.y, SLAB);
	return {
		// Out on the yard beside the dispatch desk, clear of the tray, the
		// queue and the truck; on a phone, where the queue fills the dock,
		// outside the floor's open front, in a column of its own.
		offStage: narrow ? tileToWorld(11.5, 14.8, 0.7) : tileToWorld(21, 4.6, 0.7),
		// A notice is pinned on a pallet stack, so its plate rides at a
		// queued picker's head height and the rows keep apart.
		slots: {
			"you-1": lifted(at("you-1")),
			"you-2": lifted(at("you-2")),
			"you-3": lifted(at("you-3")),
			"you-4": lifted(at("you-4")),
		},
		// Past the queue's back places.
		tally: narrow ? tileToWorld(18.2, 1.2, 0.7) : tileToWorld(20.6, 2.4, 0.7),
		timer: [0.45, 0, 0.2],
		tray: [desk[0] - 0.3, desk[1] + 0.66, desk[2]],
		trayStep: [0.5, 0, 0],
	};
}

export interface WarehouseActPropsInput {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	iconOnly: boolean;
	/** A phone stage: the queue's narrow places. */
	narrow: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	stations: readonly PickerStation[];
}

/** The act props: the dispatch queue and desk, and each station's cues. */
export function WarehouseActProps({
	acts,
	clock,
	iconOnly,
	narrow,
	nowMs,
	offStage,
	onAsk,
	onBlocker,
	onQueue,
	onStage,
	owners,
	reduced,
	shown,
	slots,
	snapshot,
	stations,
}: WarehouseActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	return (
		<group>
			<DispatchDesk />
			{slots.slots
				.filter((slot) => slot.carrier === "notice")
				.map((slot) => {
					const at = youPoints(narrow)[slot.point];
					return at ? <NoticePallets at={at} key={slot.ask.id} /> : null;
				})}
			<YouSpots
				iconOnly={iconOnly}
				item={SKIN.deliverable}
				layout={dispatchLayout(narrow)}
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
				timerSkin={{ color: WAREHOUSE_ACT_ART.timer }}
			/>
			{stations.map((station) => {
				const act = acts.get(station.agentId);
				if (!act) {
					return null;
				}
				return (
					<group key={station.id}>
						{act.act === "limited" ? (
							<Forklift at={forkliftAt(station)} />
						) : null}
						<ActStation
							act={act}
							at={station.at}
							clock={clock}
							iconOnly={iconOnly}
							layout={narrow ? station.narrowLayout : station.layout}
							limitText={forkliftLimit}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							pipSkin={BASKET_PIPS}
							privacy={privacy}
							reduced={reduced}
							shown={shown}
							snapshot={snapshot}
						/>
					</group>
				);
			})}
		</group>
	);
}
