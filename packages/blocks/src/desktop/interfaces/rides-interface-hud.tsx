import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { RefObject } from "react";
import { GAME_PLATE } from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import type { ActTotals } from "./game3d-acts.ts";
import { actSummaryLine } from "./game3d-acts.ts";
import { IsoZoomControls, type useIsoView } from "./game3d-stage.tsx";
import {
	ActStatus,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";
import { RidesActCounters, RidesCounters } from "./rides-hud.tsx";
import type { DriverOption } from "./rides-model.ts";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

/** The rides stage's HUD: the act summary and buttons, zoom, and counters. */
export function RidesInterfaceHud({
	acts,
	clock,
	counts,
	isoView,
	nowMs,
	onAsk,
	onBlocker,
	options,
	queueOpener,
	source,
	stageWidth,
	threadOpen,
	totals,
	unowned,
	wide,
	withActs,
}: {
	acts: ActsView["acts"];
	clock: ReturnType<typeof useActClockOptions>;
	counts: { arrived: number; enRoute: number };
	isoView: ReturnType<typeof useIsoView>;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	options: DriverOption[];
	queueOpener: RefObject<(() => void) | null>;
	source: InterfaceSnapshot;
	stageWidth: number;
	threadOpen: boolean;
	totals: ActTotals;
	unowned: ActsView["unowned"];
	wide: boolean;
	withActs: boolean;
}) {
	return (
		<>
			{withActs ? (
				<GameHudSlot
					at={wide ? "top-right" : "top-left"}
					className={cn(
						"flex-col",
						wide
							? "right-20 items-end"
							: "max-w-[calc(100%-4.5rem)] items-start"
					)}
				>
					{/* Wide stages carry the summary in the panel's header, which
					    an open trip hides. */}
					{wide && !threadOpen ? null : (
						<p
							className={cn(
								GAME_PLATE,
								"pointer-events-auto w-fit max-w-full truncate rounded-xl px-3 py-1.5 font-semibold text-[13px]"
							)}
							data-act-summary=""
						>
							{actSummaryLine(totals)}
						</p>
					)}
					<BlindSpotCaption snapshot={source} />
					<div className="flex gap-2">
						<NeedYouButton onAsk={onAsk} snapshot={source} totals={totals} />
						<QueueButton
							acts={acts}
							clock={clock}
							narrow={!wide && stageWidth < 640}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							openRef={queueOpener}
							snapshot={source}
							totals={totals}
							unowned={unowned}
						/>
					</div>
				</GameHudSlot>
			) : null}
			<GameHudSlot at="top-right">
				<IsoZoomControls view={isoView} />
			</GameHudSlot>
			{wide ? (
				<GameHudSlot at="bottom-right">
					{withActs ? (
						<RidesActCounters
							acts={acts}
							answers={
								(source.asks ?? []).filter((ask) => ask.kind === "reply").length
							}
							totals={totals}
						/>
					) : (
						<RidesCounters
							arrived={counts.arrived}
							enRoute={counts.enRoute}
							free={options.filter((option) => option.available).length}
						/>
					)}
				</GameHudSlot>
			) : null}
		</>
	);
}

/** An agent's act words and status for its row in the list fallback. */
export function ridesActRow({
	acts,
	clock,
	nowMs,
	onAsk,
	onBlocker,
	source,
}: {
	acts: ActsView["acts"];
	clock: ReturnType<typeof useActClockOptions>;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	source: InterfaceSnapshot;
}) {
	return (agentId: string) => {
		const act = acts.get(agentId);
		return act
			? {
					label: act.ariaLabel,
					status: (
						<ActStatus
							act={act}
							clock={clock}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							snapshot={source}
						/>
					),
				}
			: null;
	};
}
