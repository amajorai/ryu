import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	SeasonalParams,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, List, Plus } from "lucide-react";
import type { RefObject } from "react";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameTitlePlate,
} from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import {
	actSummaryLine,
	type actTotals,
	type overlayBudget,
} from "./game3d-acts.ts";
import { IsoZoomControls, type useIsoView } from "./game3d-stage.tsx";
import {
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";
import {
	FROM_TODAY,
	headerSummary,
	PLATE_BUTTON,
	SEASON_ICON,
	type SidePanel,
} from "./seasonal-interface-constants.tsx";
import {
	SEASON_COPY,
	SEASONS,
	type Season,
	type SeasonBoard,
	type SeasonCopy,
	type SeasonDoor,
} from "./seasonal-model.ts";
import { Legend } from "./seasonal-parts.tsx";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

export interface SeasonalHudProps {
	acts: ActsView["acts"];
	actsOn: boolean;
	board: SeasonBoard;
	budget: ReturnType<typeof overlayBudget>;
	clock: ReturnType<typeof useActClockOptions>;
	compact: boolean;
	compose: () => void;
	copy: SeasonCopy;
	filledDoors: SeasonDoor[];
	hudRef: RefObject<HTMLDivElement | null>;
	isoView: ReturnType<typeof useIsoView>;
	loading: boolean;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	pickSeason: (picked: unknown) => void;
	queueOpener: RefObject<(() => void) | null>;
	season: Season;
	seasonSetting: SeasonalParams["season"];
	showList: () => void;
	showMore: () => void;
	side: SidePanel;
	snapshot: InterfaceSnapshot;
	today: number | null;
	totals: ReturnType<typeof actTotals>;
	unowned: ActsView["unowned"];
}

/** The board's HUD: title, season, More, Add, the legend and All doors. */
export function SeasonalHud({
	acts,
	actsOn,
	board,
	budget,
	clock,
	compact,
	compose,
	copy,
	filledDoors,
	hudRef,
	isoView,
	loading,
	nowMs,
	onAsk,
	onBlocker,
	pickSeason,
	queueOpener,
	season,
	seasonSetting,
	showList,
	showMore,
	side,
	snapshot,
	today,
	totals,
	unowned,
}: SeasonalHudProps) {
	const tl = useLiteralMessages();
	return (
		<>
			<GameHudSlot at="top-left" className="min-w-0 max-w-[calc(100%-8rem)]">
				{actsOn ? (
					<div className="flex min-w-0 flex-col items-start gap-2" ref={hudRef}>
						<GameTitlePlate
							compact={compact}
							icon={SEASON_ICON[season]}
							keepStatus
							status={loading ? "Setting up the board" : actSummaryLine(totals)}
							title={copy.board}
						/>
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
					<GameTitlePlate
						compact={compact}
						icon={SEASON_ICON[season]}
						status={
							loading ? "Setting up the board" : headerSummary(board, copy)
						}
						title={copy.board}
					/>
				)}
			</GameHudSlot>
			<GameHudSlot at="top-right" className="items-center">
				{compact ? (
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger
								render={
									<DropdownMenuTrigger
										aria-label={tl("Season: {label}", { label: copy.label })}
										render={<button className={PLATE_BUTTON} type="button" />}
									/>
								}
							>
								{/* With acts the summary line needs the room: the season's icon. */}
								{actsOn ? (
									<span className="flex [&_svg]:size-5">
										{SEASON_ICON[season]}
									</span>
								) : (
									<>
										{copy.label}
										<ChevronDown aria-hidden="true" className="size-4" />
									</>
								)}
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{tl("Season: {label}", { label: copy.label })}
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent
							align="end"
							className="w-48"
							drawerLabel="Season"
						>
							<DropdownMenuGroup>
								<DropdownMenuRadioGroup
									onValueChange={pickSeason}
									value={seasonSetting}
								>
									<DropdownMenuRadioItem value="auto">
										{FROM_TODAY}
									</DropdownMenuRadioItem>
									{SEASONS.map((item) => (
										<DropdownMenuRadioItem key={item} value={item}>
											{SEASON_COPY[item].label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					<div
						aria-label="Season"
						className={cn(
							GAME_PLATE,
							"pointer-events-auto flex h-12 items-center gap-1 p-1"
						)}
						role="group"
					>
						{(["auto", ...SEASONS] as const).map((item) => (
							<button
								aria-pressed={item === seasonSetting}
								className={cn(
									"gk-display h-full rounded-[11px] px-3.5 text-[15px] transition-colors",
									GAME_FOCUS,
									item === seasonSetting
										? "bg-(--gk-accent) text-(--gk-accent-ink)"
										: "text-(--gk-ink-muted) hover:bg-(--gk-plate-sunk) hover:text-(--gk-ink)"
								)}
								key={item}
								onClick={() => pickSeason(item)}
								type="button"
							>
								{item === "auto" ? FROM_TODAY : SEASON_COPY[item].label}
							</button>
						))}
					</div>
				)}
				{board.overflow.length > 0 ? (
					<button
						aria-pressed={side === "more"}
						className={PLATE_BUTTON}
						onClick={showMore}
						type="button"
					>
						{copy.more}
						<span className="text-(--gk-ink-muted) tabular-nums">
							{board.overflow.length}
						</span>
					</button>
				) : null}
				<GameAction
					compact={compact}
					disabled={loading}
					icon={<Plus aria-hidden="true" strokeWidth={3} />}
					label={copy.add}
					onClick={compose}
				/>
			</GameHudSlot>
			{loading ? null : (
				<GameHudSlot at="bottom-left">
					<Legend acts={actsOn} today={today !== null} />
				</GameHudSlot>
			)}
			{loading ? null : (
				<GameHudSlot at="bottom-right">
					{filledDoors.length === 0 || compact ? null : (
						<button
							aria-pressed={side === "all"}
							className={PLATE_BUTTON}
							onClick={showList}
							type="button"
						>
							<List aria-hidden="true" className="size-4" strokeWidth={2.5} />
							{tl("All {doors}", { doors: copy.doors })}
							<span className="text-(--gk-ink-muted) tabular-nums">
								{filledDoors.length}
							</span>
						</button>
					)}
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);
}
