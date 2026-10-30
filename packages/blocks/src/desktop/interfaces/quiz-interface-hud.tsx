import type {
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { MessageCircleQuestion, RotateCcw, Trophy } from "lucide-react";
import type { RefObject } from "react";
import { GameAction, GameIconButton, GameTitlePlate } from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import { actSummaryLine, type actTotals } from "./game3d-acts.ts";
import { type IsoStageProps, IsoZoomControls } from "./game3d-stage.tsx";
import {
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";
import type { useActClockOptions, useActs } from "./use-acts.ts";

/** The quiz HUD: the title plate, the act buttons, a fresh board and zoom. */
export function QuizHud({
	acts,
	canReset,
	clock,
	compact,
	isEmpty,
	isoView,
	loading,
	newGame,
	nowMs,
	onAsk,
	onBlocker,
	openFinal,
	queueOpener,
	snapshot,
	status,
	totals,
	unowned,
	withActs,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	canReset: boolean;
	clock: ReturnType<typeof useActClockOptions>;
	compact: boolean;
	isEmpty: boolean;
	isoView: NonNullable<IsoStageProps["view"]>;
	loading: boolean;
	newGame: () => void;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	openFinal: (agentId?: string) => void;
	queueOpener: RefObject<(() => void) | null>;
	snapshot: InterfaceSnapshot;
	status: string;
	totals: ReturnType<typeof actTotals>;
	unowned: ReturnType<typeof useActs>["unowned"];
	withActs: boolean;
}) {
	return (
		<>
			<GameHudSlot
				at="top-left"
				className={
					withActs
						? "max-w-[calc(100%-7.5rem)] flex-col items-start [&>*]:max-w-full"
						: undefined
				}
			>
				<GameTitlePlate
					compact={compact}
					icon={<Trophy aria-hidden="true" />}
					keepStatus={withActs}
					status={withActs ? actSummaryLine(totals) : status}
					title="Quiz Show"
				/>
				{withActs ? (
					<>
						<BlindSpotCaption snapshot={snapshot} />
						<div className="flex gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={totals}
							/>
							<QueueButton
								acts={acts}
								clock={clock}
								narrow={compact}
								nowMs={nowMs}
								onAsk={onAsk}
								onBlocker={onBlocker}
								openRef={queueOpener}
								snapshot={snapshot}
								totals={totals}
								unowned={unowned}
							/>
						</div>
					</>
				) : null}
			</GameHudSlot>
			<GameHudSlot at="top-right" className="items-center">
				{/* With acts the board follows the agents; there is no game to reset. */}
				{withActs ? null : (
					<GameIconButton
						disabled={!canReset}
						label="New game"
						onClick={newGame}
						title={
							canReset
								? "New game: put every clue back on the board"
								: "No clues played yet"
						}
					>
						<RotateCcw
							aria-hidden="true"
							className="size-5"
							strokeWidth={2.5}
						/>
					</GameIconButton>
				)}
				<GameAction
					compact={compact}
					disabled={loading}
					icon={<MessageCircleQuestion aria-hidden="true" />}
					label="Final question"
					onClick={() => openFinal()}
				/>
			</GameHudSlot>
			{loading || isEmpty ? null : (
				<GameHudSlot at="bottom-right">
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);
}
