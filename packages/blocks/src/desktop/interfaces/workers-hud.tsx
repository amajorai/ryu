import { BellRing, Monitor, MonitorX, MoonStar, Plus, Zap } from "lucide-react";
import type { ReactNode } from "react";
import {
	GameAction,
	GameCounter,
	GameCounters,
	GameLegend,
	GameTitlePlate,
} from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import type { ActTotals } from "./game3d-acts.ts";
import { type IsoView, IsoZoomControls } from "./game3d-stage.tsx";
import {
	ACT_STATE_LABELS,
	WORKER_STATE_LABELS,
	type WorkerState,
	type WorkerTotals,
} from "./workers-model.ts";
import { StatusLight } from "./workers-status.tsx";

/**
 * The Workers HUD on the shared game kit (game-shell.tsx): the workspace's
 * name and what needs you on the title plate, New task (the one primary
 * action) top right, the fleet's counters bottom left, and the screen
 * colours' legend and the zoom plate bottom right.
 */

function status(totals: WorkerTotals, loading: boolean): string | undefined {
	if (loading) {
		return;
	}
	if (totals.workers === 0) {
		return "No workers yet";
	}
	const parts = [`${totals.working} working`];
	if (totals.waitingOnYou > 0) {
		parts.push(`${totals.waitingOnYou} waiting on you`);
	}
	return parts.join(" · ");
}

const LEGEND: readonly WorkerState[] = [
	"working",
	"your-turn",
	"attention",
	"idle",
];

/** With acts the lights add the interrupted run's grey "paused". */
const ACT_LEGEND: readonly WorkerState[] = [
	"working",
	"your-turn",
	"attention",
	"paused",
	"idle",
];

/**
 * The act layer's HUD parts, when the host sends asks: the summary line
 * on the title plate, the blind-spot caption under it, the need-you and
 * Queue buttons, and the counters from the act totals.
 */
export interface WorkersHudActs {
	buttons: ReactNode;
	caption: ReactNode;
	summary: string;
	totals: ActTotals;
}

export function WorkersHud({
	acts = null,
	compact,
	legend,
	loading,
	newTaskOpen,
	onNewTask,
	title,
	totals,
	view,
}: {
	acts?: WorkersHudActs | null;
	compact: boolean;
	/** Room for the legend beside the counters. */
	legend: boolean;
	loading: boolean;
	newTaskOpen: boolean;
	onNewTask: () => void;
	title: string;
	totals: WorkerTotals;
	view: IsoView;
}) {
	const idle = totals.workers - totals.working - totals.waitingOnYou;
	const legendStates = acts ? ACT_LEGEND : LEGEND;
	const legendLabels = acts ? ACT_STATE_LABELS : WORKER_STATE_LABELS;
	// With acts the narrow HUD holds the need-you and Queue buttons even
	// before any worker has a desk (unowned asks still wait at the door).
	const bottom = !loading && (acts !== null || totals.workers > 0);
	return (
		<>
			<GameHudSlot at="top-left" className="right-0 items-start">
				<div className="flex min-w-0 flex-1 flex-col items-start gap-2">
					{/* Capped, so a long summary truncates instead of running under the actions. */}
					<div className="max-w-full">
						<GameTitlePlate
							compact={compact}
							icon={<Monitor strokeWidth={2.25} />}
							keepStatus={acts !== null}
							status={acts ? acts.summary : status(totals, loading)}
							title={title}
						/>
					</div>
					{acts?.caption}
				</div>
				<div className="ms-auto flex flex-col items-end gap-2">
					<GameAction
						compact={compact}
						disabled={loading || newTaskOpen}
						icon={<Plus strokeWidth={2.75} />}
						label="New task"
						onClick={onNewTask}
					/>
					{acts && !compact ? acts.buttons : null}
				</div>
			</GameHudSlot>
			{bottom ? (
				<>
					<GameHudSlot at="bottom-left">
						{acts && compact ? acts.buttons : null}
						{acts && !compact ? (
							<GameCounters label="Worker counters">
								<GameCounter
									compact={compact}
									icon={<BellRing strokeWidth={2.5} />}
									label="need you"
									tone={acts.totals.needYou > 0 ? "gold" : "info"}
									value={acts.totals.needYou}
								/>
								<GameCounter
									compact={compact}
									icon={<Zap strokeWidth={2.5} />}
									label="working"
									tone="good"
									value={acts.totals.working}
								/>
								<GameCounter
									compact={compact}
									icon={<MonitorX strokeWidth={2.5} />}
									label="failed"
									tone={acts.totals.failed > 0 ? "bad" : "info"}
									value={acts.totals.failed}
								/>
							</GameCounters>
						) : null}
						{acts ? null : (
							<GameCounters label="Worker counters">
								<GameCounter
									compact={compact}
									icon={<BellRing strokeWidth={2.5} />}
									label="waiting on you"
									tone={totals.waitingOnYou > 0 ? "warn" : "good"}
									value={totals.waitingOnYou}
								/>
								<GameCounter
									compact={compact}
									icon={<Zap strokeWidth={2.5} />}
									label="working"
									tone="good"
									value={totals.working}
								/>
								<GameCounter
									compact={compact}
									icon={<MoonStar strokeWidth={2.5} />}
									label="idle"
									tone="info"
									value={idle}
								/>
							</GameCounters>
						)}
					</GameHudSlot>
					<GameHudSlot at="bottom-right">
						{legend ? (
							<GameLegend
								items={legendStates.map((state) => ({
									key: state,
									label: legendLabels[state],
									mark: <StatusLight state={state} />,
								}))}
								label="Screen colours"
							/>
						) : null}
						<IsoZoomControls view={view} />
					</GameHudSlot>
				</>
			) : null}
		</>
	);
}
