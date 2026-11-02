import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Pause, Play, Plus, Warehouse } from "lucide-react";
import { GameAction, GameIconButton, GameTitlePlate } from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import { type IsoView, IsoZoomControls } from "./game3d-stage.tsx";
import {
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";
import type { WarehouseActs } from "./warehouse-interface-acts.tsx";
import {
	type FloorStats,
	type OrderTab,
	warehouseCount,
} from "./warehouse-model.ts";
import { StatsStrip } from "./warehouse-parts.tsx";

/**
 * The Warehouse's HUD over the floor: the title plate (the shift and its
 * pickers, or the acts' summary), the act row, Pause and Create order, the
 * stats strip and the zoom. Split out of `warehouse-interface.tsx`.
 */

interface WarehouseHudProps {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	actsOn: boolean;
	clipboardShare: number;
	clock: ClockOptions | undefined;
	compact: boolean;
	isoView: IsoView;
	loading: boolean;
	narrow: boolean;
	nowMs: number;
	onCreate: () => void;
	onPickTab: (tab: OrderTab) => void;
	onTogglePaused: () => void;
	panelCover: number;
	paused: boolean;
	reduceMotion: boolean;
	snapshot: InterfaceSnapshot;
	stats: FloorStats;
	tab: OrderTab;
	unowned: Parameters<typeof QueueButton>[0]["unowned"];
	warehouseActs: WarehouseActs;
}

export function WarehouseHud({
	acts,
	actsOn,
	clipboardShare,
	clock,
	compact,
	isoView,
	loading,
	narrow,
	nowMs,
	onCreate,
	onPickTab,
	onTogglePaused,
	panelCover,
	paused,
	reduceMotion,
	snapshot,
	stats,
	tab,
	unowned,
	warehouseActs,
}: WarehouseHudProps) {
	const { budget, onAsk, onBlocker, queueOpener, totals } = warehouseActs;
	const titlePlate = (
		<GameTitlePlate
			compact={compact}
			icon={<Warehouse strokeWidth={2.25} />}
			keepStatus={actsOn}
			status={
				actsOn && !loading ? (
					actSummaryLine(totals)
				) : (
					<>
						<span className="dark:hidden">Day shift</span>
						<span className="hidden dark:inline">Night shift</span>
						{loading
							? null
							: ` · ${warehouseCount(snapshot.agents.length, "picker")}`}
					</>
				)
			}
			title="Warehouse"
		/>
	);
	return (
		<div
			className="absolute top-0 left-0"
			style={{
				bottom: narrow ? `${clipboardShare * 100}%` : 0,
				right: panelCover,
			}}
		>
			<GameHudSlot
				at="top-left"
				className={actsOn ? "right-0 flex-wrap" : "right-0"}
			>
				{actsOn ? (
					<div className="flex min-w-0 flex-col items-start gap-2">
						{titlePlate}
						<div className="flex flex-wrap items-center gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={totals}
							/>
							<QueueButton
								acts={acts}
								clock={clock}
								narrow={budget.narrow}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								openRef={queueOpener}
								snapshot={snapshot}
								totals={totals}
								unowned={unowned}
							/>
						</div>
						<BlindSpotCaption snapshot={snapshot} />
					</div>
				) : (
					titlePlate
				)}
				<div className="ms-auto flex items-start gap-2">
					{reduceMotion || loading ? null : (
						<span className="pointer-events-auto mt-1">
							<GameIconButton
								label={paused ? "Resume" : "Pause"}
								onClick={onTogglePaused}
								title={paused ? "Resume the floor" : "Pause the floor"}
							>
								{paused ? (
									<Play
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								) : (
									<Pause
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								)}
								<span className="sr-only">{paused ? "Resume" : "Pause"}</span>
							</GameIconButton>
						</span>
					)}
					<GameAction
						compact={compact}
						disabled={loading}
						icon={<Plus strokeWidth={2.75} />}
						label="Create order"
						onClick={onCreate}
					/>
				</div>
			</GameHudSlot>
			{narrow ? null : (
				<GameHudSlot at="bottom-left">
					<StatsStrip
						activeTab={tab}
						compact={compact}
						loading={loading}
						onPick={onPickTab}
						stats={stats}
					/>
				</GameHudSlot>
			)}
			{narrow || loading ? null : (
				<GameHudSlot at="bottom-right">
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</div>
	);
}
