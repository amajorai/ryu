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
	YouSpots,
} from "./game3d-act-stage.tsx";
import type { ActSkin, OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import {
	crossLayout,
	NOTICE_LIFT,
	youPoints,
	yourStallAt,
} from "./market-acts-cross.ts";
import {
	type KeeperStation,
	keeperLayout,
	stationOffset,
} from "./market-acts-stations.ts";
import type { MarketSquare, Vec3 } from "./market-model.ts";
import { MARKET_ACT_ART } from "./market-palette.ts";

/** The crates a queue notice stands on, `NOTICE_LIFT` tall. */
function NoticeCrates({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			{[0, 1].map((level) => (
				<ToonMesh
					castShadow={level === 0}
					color={MARKET_ACT_ART.crate}
					ink={0.02}
					key={level}
					position={[0, NOTICE_LIFT * ((level + 0.5) / 2), 0]}
					rotation={[0, level * 0.4, 0]}
					scale={[0.62, NOTICE_LIFT / 2 - 0.02, 0.62]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

export const SKIN: ActSkin = {
	deliverable: {
		accent: MARKET_ACT_ART.parcelString,
		color: MARKET_ACT_ART.parcel,
		shape: "box",
	},
};
export const MARKET_ACT_SKIN = SKIN;

/**
 * The limit chalked on the shop's board: "Back 15:10", "Closed for now"
 * with no reset time. An inferred limit reads "Likely back 15:10" (the kit
 * adds "Likely ").
 */
export const chalkedLimit: LimitText = (act, clearsAt) => {
	const words = clearsAt ? `back ${clearsAt}` : "closed for now";
	return limitIsLikely(act)
		? words
		: `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** The crate's goods as progress pips: sold, still on the shelf, a guess. */
const CRATE_PIPS = {
	done: MARKET_ACT_ART.pipDone,
	estimate: MARKET_ACT_ART.pipEstimate,
	todo: MARKET_ACT_ART.pipTodo,
} as const;

/** A small counter: your stall at the market cross. */
function YourStall({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, Math.PI / 4, 0]}>
			<ToonMesh
				castShadow
				color={MARKET_ACT_ART.stallWood}
				ink={0.02}
				position={[0, 0.3, 0]}
				scale={[1.3, 0.6, 0.5]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={MARKET_ACT_ART.stallTop}
				ink={0.015}
				position={[0, 0.63, 0]}
				scale={[1.4, 0.06, 0.6]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={MARKET_ACT_ART.stallCloth}
				ink={0.012}
				position={[0, 0.32, 0.26]}
				scale={[1.2, 0.36, 0.02]}
			>
				<boxGeometry />
			</ToonMesh>
		</group>
	);
}

/** The crate on the counter that holds a keeper's progress pips. */
function PipCrate({ at }: { at: Vec3 }) {
	return (
		<ToonMesh
			castShadow
			color={MARKET_ACT_ART.crate}
			ink={0.02}
			position={[at[0], at[1] - 0.17, at[2]]}
			scale={[0.95, 0.3, 0.42]}
		>
			<boxGeometry />
		</ToonMesh>
	);
}

/**
 * A blocked keeper's shutter, pulled half down across its own stretch of
 * the lot's front, wider than the keeper and its plate so it shows to both
 * sides of them (the alarm plate is the reason sign). At a shop it closes
 * the lower half of the shopfront behind the keeper (the awning hides the
 * wall above about 0.85 from the camera's pitch); at a stall, the
 * counter's front behind the keeper.
 */
function HalfShutter({ station }: { station: KeeperStation }) {
	const yaw = station.facing === "south" ? 0 : Math.PI / 2;
	const { stall } = station;
	// On the shop's wall, or on the stall counter's front face.
	const back = stationOffset(station, 0, -station.wall, 0);
	const width = station.stretch;
	const top = stall ? 0.6 : 0.82;
	const bottom = 0.08;
	const height = top - bottom;
	const ribs = [0.2, 0.4, 0.6, 0.8].map(
		(share) => (share - 0.5) * (height - 0.08)
	);
	return (
		<group
			position={[back[0], (top + bottom) / 2, back[2]]}
			rotation={[0, yaw, 0]}
		>
			<ToonMesh
				color={MARKET_ACT_ART.shutter}
				ink={0.015}
				scale={[width, height, 0.05]}
			>
				<boxGeometry />
			</ToonMesh>
			{ribs.map((y) => (
				<ToonMesh
					color={MARKET_ACT_ART.shutterRib}
					key={y}
					position={[0, y, 0.03]}
					scale={[width - 0.02, 0.04, 0.02]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

export interface MarketActPropsInput {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	block: MarketSquare;
	clock?: ClockOptions;
	/** A narrow stage: icon-only plates, and the phone layouts of the cross and stations. */
	iconOnly: boolean;
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
	stations: readonly KeeperStation[];
}

/** The act props: the cross queue, your stall and tray, and each station's cues. */
export function MarketActProps({
	acts,
	block,
	clock,
	iconOnly,
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
}: MarketActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	return (
		<group>
			<YourStall at={yourStallAt(block)} />
			{slots.slots
				.filter((slot) => slot.carrier === "notice")
				.map((slot) => {
					const at = youPoints(block, iconOnly)[slot.point];
					return at ? <NoticeCrates at={at} key={slot.ask.id} /> : null;
				})}
			<YouSpots
				iconOnly={iconOnly}
				item={SKIN.deliverable}
				layout={crossLayout(block, iconOnly)}
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
				timerSkin={{ color: MARKET_ACT_ART.chalkboard }}
			/>
			{stations.map((station) => {
				const act = acts.get(station.agentId);
				if (!act) {
					return null;
				}
				const layout = keeperLayout(station, iconOnly);
				const pips = layout.pips;
				return (
					<group key={station.id}>
						{/* The crate stands on every counter; an idle keeper's is empty. */}
						<PipCrate
							at={[station.at[0] + pips[0], pips[1], station.at[2] + pips[2]]}
						/>
						{act.act === "blocked" ? <HalfShutter station={station} /> : null}
						<ActStation
							act={act}
							at={station.at}
							clock={clock}
							iconOnly={iconOnly}
							layout={layout}
							limitText={chalkedLimit}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							pipSkin={CRATE_PIPS}
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
