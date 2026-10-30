import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { AnimatePresence } from "motion/react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { IsoStage, type IsoStageProps } from "./game3d-stage.tsx";
import type { QuizActView } from "./quiz-acts.tsx";
import { QuizBoardCells, QuizBoardFrame } from "./quiz-board.tsx";
import { QuizClueCard, QuizFinalQuestion } from "./quiz-cards.tsx";
import { QuizContestants } from "./quiz-contestants.tsx";
import { type Overlay, QUIZ_ACT_PLATE_FIT } from "./quiz-interface-state.ts";
import type { Contestant, QuizTile } from "./quiz-model.ts";
import { BOARD_BEZEL } from "./quiz-palette.ts";
import { QuizStudio, type QuizStudioProps } from "./quiz-studio.tsx";
import { STUDIO_BOUNDS, STUDIO_TOP } from "./quiz-world.ts";

/**
 * The studio set: the isometric stage (with the flat board and podiums as
 * its fallback) and the screen the clue and final question come up on.
 */
export function QuizStage({
	actView,
	animate,
	audience,
	board,
	boardLabel,
	cards,
	clueTile,
	contestantActs,
	contestants,
	finalOpen,
	handlers,
	headlines,
	inPlayId,
	insets,
	isoView,
	looks,
	night,
	onStage,
	openFinal,
	reducedMotion,
	shape,
	sheetCover,
	shown,
	tabStopId,
	withActs,
}: {
	actView: QuizActView | null;
	animate: boolean;
	audience: boolean;
	board: QuizStudioProps["board"];
	boardLabel: string;
	cards: ReactNode;
	clueTile: QuizTile | undefined;
	contestantActs: ComponentProps<typeof QuizContestants>["acts"];
	contestants: Contestant[];
	finalOpen: boolean;
	handlers: QuizStudioProps["handlers"];
	headlines: ReadonlyMap<string, string>;
	inPlayId: string | null;
	insets: IsoStageProps["insets"];
	isoView: IsoStageProps["view"];
	looks: QuizStudioProps["looks"];
	night: boolean;
	onStage: readonly InterfaceAgentAct[];
	openFinal: (agentId?: string) => void;
	reducedMotion: boolean;
	shape: QuizStudioProps["shape"];
	sheetCover: number;
	shown: (tile: QuizTile) => boolean;
	tabStopId: string | null;
	withActs: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="relative min-h-0 flex-1">
			<IsoStage
				bounds={{ ...STUDIO_BOUNDS, top: STUDIO_TOP }}
				fallback={
					<div className="absolute inset-0 flex flex-col overflow-y-auto @min-[672px]/game:pt-24 pt-20">
						<div className="flex min-h-[420px] flex-1 @min-[672px]/game:px-8 px-3 pb-4 [container:set/size]">
							<QuizBoardFrame
								cells={
									<QuizBoardCells
										animate={animate}
										board={board}
										handlers={handlers}
										inPlayId={inPlayId}
										isRevealed={shown}
										openId={clueTile ? clueTile.thread.id : null}
										tabStopId={tabStopId}
									/>
								}
								className="m-auto @max-[35rem]/set:h-auto h-[min(100cqh,calc(100cqw/1.75))] @max-[35rem]/set:w-full w-[min(100cqw,calc(100cqh*1.75))] @max-[35rem]/set:[container-type:inline-size]"
								label={boardLabel}
								rows={board.rows}
							/>
						</div>
						<QuizContestants
							acts={contestantActs}
							contestants={contestants}
							onAsk={openFinal}
						/>
					</div>
				}
				// With acts, zoom on to the board, the podiums and the lectern.
				fitPlates={withActs ? QUIZ_ACT_PLATE_FIT : undefined}
				insets={insets}
				label={tl(
					"{boardLabel}. The studio: the board's wall of tiles, the contestants at their podiums and the host. Tab or the arrow keys move between the clues and the contestants; drag to pan, plus and minus to zoom.",
					{ boardLabel }
				)}
				night={night}
				reducedMotion={reducedMotion}
				view={isoView}
			>
				{({ quality, theme }) => (
					<QuizStudio
						acts={actView ? { onStage, view: actView } : null}
						audience={audience}
						board={board}
						contestants={contestants}
						handlers={handlers}
						headlines={headlines}
						inPlayId={inPlayId}
						isRevealed={shown}
						looks={looks}
						night={night}
						onAsk={openFinal}
						openId={clueTile ? clueTile.thread.id : null}
						quality={quality}
						reducedMotion={reducedMotion}
						shape={shape}
						theme={theme}
					/>
				)}
			</IsoStage>
			{/* The clue and the final question come up on a screen over the set. */}
			{clueTile || finalOpen ? (
				<div
					className="pointer-events-none absolute inset-0 z-40 grid place-items-center @min-[672px]/game:px-8 px-3 @min-[672px]/game:pt-24 pt-20 pb-6"
					style={{ paddingRight: sheetCover + 12 }}
				>
					<div
						className="pointer-events-auto relative h-[min(100%,460px)] w-[min(100%,780px)] rounded-[10px] bg-(--quiz-frame) [container:board/size]"
						style={{ boxShadow: BOARD_BEZEL }}
					>
						{cards}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** The clue card and the final question, as they come up over the board. */
export function QuizOverlayCards({
	animate,
	answerRef,
	clueTile,
	contestants,
	finalFieldRef,
	onAnswer,
	onBack,
	onSubmitFinal,
	overlay,
	snapshot,
}: {
	animate: boolean;
	answerRef: RefObject<HTMLButtonElement | null>;
	clueTile: QuizTile | undefined;
	contestants: Contestant[];
	finalFieldRef: RefObject<HTMLTextAreaElement | null>;
	onAnswer: () => void;
	onBack: () => void;
	onSubmitFinal: (input: { agentId?: string; prompt: string }) => void;
	overlay: Overlay | null;
	snapshot: InterfaceSnapshot;
}) {
	return (
		<AnimatePresence>
			{clueTile ? (
				<QuizClueCard
					animate={animate}
					answerRef={answerRef}
					key={`clue-${clueTile.thread.id}`}
					onAnswer={onAnswer}
					onBack={onBack}
					snapshot={snapshot}
					tile={clueTile}
				/>
			) : null}
			{overlay?.kind === "final" ? (
				<QuizFinalQuestion
					agents={snapshot.agents}
					animate={animate}
					defaultAgentId={overlay.agentId ?? contestants[0]?.agent.id}
					featuredIds={contestants.map((entry) => entry.agent.id)}
					fieldRef={finalFieldRef}
					key="final"
					onCancel={onBack}
					onSubmit={onSubmitFinal}
				/>
			) : null}
		</AnimatePresence>
	);
}
