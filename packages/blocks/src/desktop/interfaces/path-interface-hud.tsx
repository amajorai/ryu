import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceParamsByRenderer,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Footprints, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { GameAction, GameLegend, GameTitlePlate } from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import { type ActTotals, actSummaryLine } from "./game3d-acts.ts";
import { IsoZoomControls } from "./game3d-stage.tsx";
import type { IsoView } from "./game3d-stage-view.tsx";
import { BlindSpotCaption } from "./interface-ask-card.tsx";
import { LEGEND_ITEMS } from "./path-interface-nav.tsx";
import type { PathModel } from "./path-model.ts";
import type { PathLeader, PathStats } from "./path-model-stats.ts";
import { PathStatsBar } from "./path-rail.tsx";

/** How many stops wait on you: the next one, attention, or your reply. */
function needYouCount(model: PathModel): number {
	return model.units.reduce(
		(count, unit) =>
			count +
			unit.stops.filter(
				(stop) =>
					stop.state === "current" ||
					stop.state === "attention" ||
					stop.state === "reply"
			).length,
		0
	);
}

/** The title plate's status line: progress, and how many stops need you. */
function usePathStatus(model: PathModel, loading: boolean): string {
	const tl = useLiteralMessages();
	if (loading) {
		return tl("Laying out the path");
	}
	const needYou = needYouCount(model);
	const progress = {
		done: String(model.doneCount),
		total: String(model.stopCount),
	};
	if (needYou > 0) {
		return tl(
			"{done} of {total} finished · {count, plural, one {{countText} need you} other {{countText} need you}}",
			{ ...progress, count: needYou, countText: String(needYou) }
		);
	}
	return tl("{done} of {total} finished", progress);
}

export interface PathHudProps {
	actButtons: ReactNode;
	compact: boolean;
	isEmpty: boolean;
	isoView: IsoView;
	leaders: PathLeader[];
	legendRoom: boolean;
	loading: boolean;
	model: PathModel;
	onNewThread: () => void;
	params: InterfaceParamsByRenderer["path"] | undefined;
	queueOn: boolean;
	snapshot: InterfaceSnapshot;
	stats: PathStats;
	tally: ActTotals;
}

/** The path's HUD: title and status, stats, New thread, acts and legend. */
export function PathHud({
	actButtons,
	compact,
	isEmpty,
	isoView,
	leaders,
	legendRoom,
	loading,
	model,
	onNewThread,
	params,
	queueOn,
	snapshot,
	stats,
	tally,
}: PathHudProps) {
	const status = usePathStatus(model, loading);
	return (
		<>
			<GameHudSlot at="top-left">
				<div className="flex min-w-0 flex-col items-start gap-2">
					<GameTitlePlate
						compact={compact}
						icon={<Footprints aria-hidden="true" />}
						keepStatus={queueOn}
						status={queueOn ? actSummaryLine(tally) : status}
						title="Path"
					/>
					{queueOn ? <BlindSpotCaption snapshot={snapshot} /> : null}
				</div>
			</GameHudSlot>
			<GameHudSlot at="top-right" className="items-start">
				{/* A phone's top row holds the act summary or the stats, not both:
				    with acts the summary line wins. The stats setting hides them. */}
				{loading ||
				isEmpty ||
				params?.stats === false ||
				(compact && queueOn) ? null : (
					<PathStatsBar leaders={leaders} stats={stats} />
				)}
				<GameAction
					compact={compact || !isEmpty}
					disabled={loading}
					icon={<Plus aria-hidden="true" strokeWidth={3} />}
					label="New thread"
					onClick={onNewThread}
				/>
				{/* On a phone the act buttons sit in the footer: the top row has
				    no room beside the stats and New thread. */}
				{compact ? null : actButtons}
			</GameHudSlot>
			{compact && actButtons ? (
				<GameHudSlot at="bottom-left">{actButtons}</GameHudSlot>
			) : null}
			{loading || isEmpty ? null : (
				<GameHudSlot at="bottom-right">
					{legendRoom ? (
						<GameLegend
							items={LEGEND_ITEMS.map((item) => ({
								key: item.key,
								label: item.label,
								mark: (
									<span
										className={cn(
											"size-3.5 rounded-full border-(--gk-edge) border-2",
											item.className
										)}
									/>
								),
							}))}
							label="What the stones mean"
						/>
					) : null}
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);
}
