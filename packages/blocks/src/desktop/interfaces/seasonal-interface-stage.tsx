import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type {
	ComponentProps,
	KeyboardEvent,
	ReactNode,
	RefObject,
} from "react";
import type { islandFor } from "./game3d-ground.tsx";
import { IsoStage, type useIsoView } from "./game3d-stage.tsx";
import type { useVillagerLooks } from "./game3d-villager.tsx";
import { ActAgentList, AskQueueList } from "./interface-ask-card.tsx";
import { type SeasonActors, SeasonDiorama } from "./seasonal-diorama.tsx";
import { SeasonalGrid } from "./seasonal-grid.tsx";
import {
	ACT_PORTRAIT,
	ACTS_FILL,
	DIORAMA_LABEL,
} from "./seasonal-interface-constants.tsx";
import type {
	Season,
	SeasonBoard,
	SeasonCopy,
	SeasonDoor,
} from "./seasonal-model.ts";
import { EmptyNote, GiftCard } from "./seasonal-parts.tsx";
import type { SeasonWorld } from "./seasonal-world.ts";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

export interface SeasonalStageProps {
	activate: (number: number, element: HTMLButtonElement) => void;
	activeNumber: number | null;
	actors: SeasonActors | undefined;
	acts: ActsView["acts"];
	actsOn: boolean;
	board: SeasonBoard;
	clock: ReturnType<typeof useActClockOptions>;
	closeGift: () => void;
	compose: () => void;
	copy: SeasonCopy;
	doorList: (flush: boolean) => ReactNode;
	empty: boolean;
	filledDoors: SeasonDoor[];
	gift: number | null;
	giftDoor: SeasonDoor | null;
	giftId: string;
	giftPosition: ComponentProps<typeof GiftCard>["position"];
	headingRef: RefObject<HTMLHeadingElement | null>;
	hudTop: number;
	insets: ComponentProps<typeof IsoStage>["insets"];
	isoView: ReturnType<typeof useIsoView>;
	labelOf: (door: SeasonDoor) => string;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	night: boolean;
	now: number;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	onDoorKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	openThread: (threadId: string) => void;
	reclose: () => void;
	reduceMotion: boolean;
	sceneId: string;
	season: Season;
	shape: ReturnType<typeof islandFor>;
	sheetCover: number;
	snapshot: InterfaceSnapshot;
	stageRef: RefObject<HTMLDivElement | null>;
	today: number | null;
	unowned: ActsView["unowned"];
	weather: boolean;
	world: SeasonWorld;
}

/** The board's stage: the diorama (or its grid fallback) and the gift card. */
export function SeasonalStage({
	activate,
	activeNumber,
	actors,
	acts,
	actsOn,
	board,
	clock,
	closeGift,
	compose,
	copy,
	doorList,
	empty,
	filledDoors,
	gift,
	giftDoor,
	giftId,
	giftPosition,
	headingRef,
	hudTop,
	insets,
	isoView,
	labelOf,
	looks,
	night,
	now,
	nowMs,
	onAsk,
	onBlocker,
	onDoorKeyDown,
	openThread,
	reclose,
	reduceMotion,
	sceneId,
	season,
	shape,
	sheetCover,
	snapshot,
	stageRef,
	today,
	unowned,
	weather,
	world,
}: SeasonalStageProps) {
	const tl = useLiteralMessages();
	return (
		<div className="relative min-h-0 flex-1" ref={stageRef}>
			{actsOn ? (
				<AskQueueList
					acts={acts}
					clock={clock}
					fallbackFocus={headingRef}
					nowMs={nowMs}
					onAsk={onAsk}
					onBlocker={onBlocker}
					snapshot={snapshot}
					unowned={unowned}
				/>
			) : null}
			<div className="absolute inset-0">
				<IsoStage
					bounds={{ ...world.bounds, top: world.top }}
					fallback={
						<div
							className="absolute inset-0 overflow-y-auto pb-24"
							style={{ paddingTop: hudTop + 8 }}
						>
							<SeasonalGrid
								activeNumber={activeNumber}
								doors={board.doors}
								giftId={giftId}
								giftNumber={gift}
								label={`${copy.board} ${copy.doors}`}
								labelOf={labelOf}
								onActivate={activate}
								onKeyDown={onDoorKeyDown}
								today={today}
							/>
							{actsOn ? (
								<section
									aria-labelledby={`${sceneId}-agents`}
									className="mx-auto mt-4 w-full max-w-[720px] px-3"
								>
									<div className="overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-background p-4 text-foreground shadow-(--gk-lip)">
										<h2
											className="gk-display pb-2 text-[18px] leading-6"
											id={`${sceneId}-agents`}
										>
											Agents
										</h2>
										<ActAgentList
											acts={acts}
											clock={clock}
											nowMs={nowMs}
											onAsk={onAsk}
											onBlocker={onBlocker}
											onOpenThread={openThread}
											snapshot={snapshot}
										/>
									</div>
								</section>
							) : null}
							{filledDoors.length > 0 ? (
								<section
									aria-labelledby={`${sceneId}-list`}
									className="mx-auto mt-4 w-full max-w-[720px] px-3"
								>
									<div className="overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-background text-foreground shadow-(--gk-lip)">
										<h2
											className="gk-display px-4 pt-4 pb-2 text-[18px] leading-6"
											id={`${sceneId}-list`}
										>
											{tl("All {doors}", { doors: copy.doors })}
										</h2>
										{doorList(false)}
									</div>
								</section>
							) : null}
						</div>
					}
					// With acts the cast's plates need the room: frame closer.
					fill={actsOn ? ACTS_FILL[season] : undefined}
					// The street's cast fills its front half: zoom on to it.
					// Beside an open sheet it frames the street whole instead,
					// so its plates keep the room to part.
					fitPlates={
						actsOn && season === "lunar-new-year" && sheetCover === 0
							? {}
							: undefined
					}
					insets={insets}
					label={tl(
						"{board}: {diorama} Tab or the arrow keys move between them; drag to pan, plus and minus to zoom.",
						{ board: copy.board, diorama: DIORAMA_LABEL[season] }
					)}
					motes={weather && season !== "advent"}
					night={night}
					portrait={actsOn ? ACT_PORTRAIT[season] : undefined}
					reducedMotion={reduceMotion}
					view={isoView}
				>
					{({ quality, theme }) => (
						<SeasonDiorama
							activeNumber={activeNumber}
							actors={actors}
							doors={board.doors}
							giftId={giftId}
							giftNumber={gift}
							labelOf={labelOf}
							looks={looks}
							night={night}
							onActivate={activate}
							onKeyDown={onDoorKeyDown}
							quality={quality}
							reducedMotion={reduceMotion}
							season={season}
							shape={shape}
							theme={theme}
							today={today}
							weather={weather}
							world={world}
						/>
					)}
				</IsoStage>
			</div>
			{giftDoor ? (
				<GiftCard
					acts={actsOn}
					copy={copy}
					door={giftDoor}
					id={giftId}
					key={`${season}-${giftDoor.number}`}
					now={now}
					onClose={closeGift}
					onOpen={() => {
						if (giftDoor.thread) {
							openThread(giftDoor.thread.id);
						}
					}}
					onReclose={reclose}
					position={giftPosition}
					reduceMotion={reduceMotion}
				/>
			) : null}
			{empty ? <EmptyNote copy={copy} onAdd={compose} /> : null}
		</div>
	);
}
