import { cn } from "@ryu/ui/lib/utils";
import {
	compareAsks,
	type InterfaceParamsByRenderer,
} from "@ryuhq/protocol/interfaces";
import { Megaphone, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { GameAction, GameIconButton } from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import { type ActTotals, actSummaryLine } from "./game3d-acts.ts";
import type { WebGLProbe } from "./game3d-toon.ts";
import { BlindSpotCaption } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { TownDesk } from "./town-desk.tsx";
import {
	CityHallButton,
	DataViewControl,
	SpeedControl,
	TownStatsPlate,
	TownTitle,
	ZoomControls,
} from "./town-hud.tsx";
import {
	formatFunds,
	type Town,
	type TownStats,
	upcomingRuns,
} from "./town-model.ts";
import type { TownDataView, TownPalette } from "./town-palette.ts";
import type { TownCamera } from "./town-scene.tsx";

type TownProps = InterfaceRendererProps<InterfaceParamsByRenderer["town"]>;

export interface TownInterfaceHudProps {
	actButtons: ReactNode;
	activeThreadId: TownProps["activeThreadId"];
	actsOn: boolean;
	cameraRef: RefObject<TownCamera | null>;
	chooseDataView: (next: TownDataView) => void;
	chooseSpeed: (next: number) => void;
	dataView: TownDataView;
	deskDocked: boolean;
	deskOpen: boolean;
	deskQueue: { count: number; list: ReactNode } | undefined;
	effectiveSpeed: number;
	focusedId: string | null;
	hallCount: number;
	hear: (threadId: string) => void;
	isEmpty: boolean;
	loading: TownProps["loading"];
	narrowStage: boolean;
	openAsk: (askId: string) => void;
	palette: TownPalette;
	petitionsRef: RefObject<HTMLHeadingElement | null>;
	sceneTown: Town;
	selectBuilding: (agentId: string) => void;
	setDeskOpen: (next: boolean | ((open: boolean) => boolean)) => void;
	showDistrict: (districtId: string) => void;
	showHall: () => void;
	snapshot: TownProps["snapshot"];
	stats: TownStats;
	tally: ActTotals;
	town: Town;
	webgl: WebGLProbe | null;
}

/** The town's HUD: title, City Hall, speed, petitions, data view and zoom. */
export function TownInterfaceHud({
	actButtons,
	activeThreadId,
	actsOn,
	cameraRef,
	chooseDataView,
	chooseSpeed,
	dataView,
	deskDocked,
	deskOpen,
	deskQueue,
	effectiveSpeed,
	focusedId,
	hallCount,
	hear,
	isEmpty,
	loading,
	narrowStage,
	openAsk,
	palette,
	petitionsRef,
	sceneTown,
	selectBuilding,
	setDeskOpen,
	showDistrict,
	showHall,
	snapshot,
	stats,
	tally,
	town,
	webgl,
}: TownInterfaceHudProps) {
	const firstPetition = town.petitions[0];
	// With acts "Hear next" answers the first blocking ask, in ask order.
	const nextAsk = actsOn
		? [...(snapshot.asks ?? [])]
				.filter((ask) => ask.blocking)
				.sort(compareAsks)[0]
		: undefined;
	const desk = deskDocked ? (
		<TownDesk
			activeThreadId={activeThreadId}
			actQueue={deskQueue}
			className={
				deskDocked
					? "absolute bottom-4 left-4 w-[340px]"
					: "absolute inset-x-2.5 bottom-2.5 z-10 sm:right-auto sm:w-[360px]"
			}
			dataView={dataView}
			header={
				deskDocked ? null : (
					<GameIconButton
						label="Close City Hall"
						onClick={() => setDeskOpen(false)}
						title="Close City Hall (Esc)"
					>
						<X aria-hidden="true" className="size-5" strokeWidth={2.5} />
					</GameIconButton>
				)
			}
			headingRef={petitionsRef}
			loading={loading}
			onAgent={selectBuilding}
			onDistrict={showDistrict}
			onHall={showHall}
			onHear={hear}
			palette={palette}
			selectedId={focusedId}
			style={{ top: narrowStage ? 70 : 84 }}
			town={sceneTown}
			upcoming={upcomingRuns(snapshot.events)}
		/>
	) : null;
	return (
		<>
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 flex items-start",
					narrowStage ? "gap-2 p-2.5" : "gap-3 p-4"
				)}
			>
				<div className="flex min-w-0 flex-col items-start gap-2">
					<div className="max-w-full">
						<TownTitle
							actStatus={actsOn ? actSummaryLine(tally) : undefined}
							compact={narrowStage}
							speed={effectiveSpeed}
						/>
					</div>
					{actsOn ? <BlindSpotCaption snapshot={snapshot} /> : null}
				</div>
				{deskDocked ? null : (
					<CityHallButton
						actMode={actsOn}
						onClick={() => setDeskOpen((open) => !open)}
						open={deskOpen}
						petitions={hallCount}
					/>
				)}
				{deskDocked && !loading ? (
					<div className="flex min-w-0 flex-1 justify-center">
						<TownStatsPlate
							compact={false}
							funds={formatFunds(snapshot)}
							stats={stats}
						/>
					</div>
				) : null}
				<div className="ms-auto flex shrink-0 flex-wrap items-start justify-end gap-3">
					<SpeedControl onSpeed={chooseSpeed} speed={effectiveSpeed} />
					{narrowStage ? null : actButtons}
					{!(actsOn || loading || narrowStage) && firstPetition ? (
						<GameAction
							icon={<Megaphone strokeWidth={2.5} />}
							label="Hear next petition"
							onClick={() => hear(firstPetition.thread.id)}
						/>
					) : null}
					{actsOn && nextAsk && !narrowStage ? (
						<GameAction
							icon={<Megaphone strokeWidth={2.5} />}
							label="Hear next ask"
							onClick={() => openAsk(nextAsk.id)}
						/>
					) : null}
				</div>
			</div>
			{desk}
			{loading || isEmpty || webgl?.supported === false ? null : (
				<GameHudSlot
					at="bottom-left"
					className={cn("flex-col items-start", deskDocked && "left-[356px]")}
				>
					<DataViewControl
						actMode={actsOn}
						onChange={chooseDataView}
						palette={palette}
						value={dataView}
					/>
					{actsOn && narrowStage ? (
						<div className="flex gap-2">{actButtons}</div>
					) : null}
					{deskDocked || (actsOn && narrowStage) ? null : (
						<TownStatsPlate
							compact={narrowStage}
							funds={formatFunds(snapshot)}
							stats={stats}
						/>
					)}
				</GameHudSlot>
			)}
			{loading || isEmpty || webgl?.supported === false ? null : (
				<GameHudSlot
					at="bottom-right"
					className={narrowStage ? "bottom-[60px]" : undefined}
				>
					<ZoomControls
						onFit={() => cameraRef.current?.reset()}
						onZoom={(factor) => cameraRef.current?.zoomBy(factor)}
					/>
				</GameHudSlot>
			)}
		</>
	);
}
