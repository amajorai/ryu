import type { ComponentProps } from "react";
import {
	ArcadeActions,
	ArcadeFilters,
	ArcadeMeters,
	ArcadePaytable,
	ArcadeTitle,
} from "./arcade-hud.tsx";
import type { buildFloor, nextJackpot } from "./arcade-model.ts";
import type { ArcadePalette } from "./arcade-palette.ts";
import { GameHudSlot } from "./game-shell.tsx";
import { actSummaryLine, type actTotals } from "./game3d-acts.ts";
import { type IsoView, IsoZoomControls } from "./game3d-stage.tsx";
import {
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";

type QueueProps = ComponentProps<typeof QueueButton>;

/** The floor's HUD: title, actions, filter chips, meters and the paytable. */
export function ArcadeHud({
	acts,
	answersReady,
	clearFilter,
	clock,
	compact,
	composerFor,
	empty,
	filterId,
	filters,
	floor,
	hudWidth,
	isoView,
	loading,
	meters,
	newGame,
	next,
	nowMs,
	onAsk,
	onBlocker,
	open,
	palette,
	queueOpener,
	snapshot,
	toggleFilter,
	totals,
	unowned,
	withActs,
}: {
	acts: QueueProps["acts"];
	answersReady: number;
	clearFilter: () => void;
	clock: QueueProps["clock"];
	compact: boolean;
	composerFor: string | null;
	empty: boolean;
	filterId: string | null;
	filters: boolean;
	floor: ReturnType<typeof buildFloor>;
	hudWidth: number;
	isoView: IsoView;
	loading: boolean;
	meters: boolean;
	newGame: () => void;
	next: ReturnType<typeof nextJackpot>;
	nowMs: number;
	onAsk: QueueProps["onAsk"];
	onBlocker: QueueProps["onBlocker"];
	open: (threadId: string, machineId?: string | null) => void;
	palette: ArcadePalette;
	queueOpener: NonNullable<QueueProps["openRef"]>;
	snapshot: QueueProps["snapshot"];
	toggleFilter: (groupId: string) => void;
	totals: ReturnType<typeof actTotals>;
	unowned: QueueProps["unowned"];
	withActs: boolean;
}) {
	const actButtons = (
		<>
			<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
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
		</>
	);
	const actions = (
		<ArcadeActions
			compact={compact}
			floor={floor}
			loading={loading}
			next={withActs ? undefined : next}
			onCollect={open}
			onNewGame={newGame}
		/>
	);
	let filtersTop = compact ? "top-14" : "top-20";
	if (withActs) {
		filtersTop = compact ? "top-24" : "top-28";
	}
	const filterChips =
		filters && !loading ? (
			<ArcadeFilters
				acted={withActs}
				cabinets={floor.wall}
				filterId={filterId}
				onClear={clearFilter}
				onToggle={toggleFilter}
			/>
		) : null;
	return (
		<>
			<GameHudSlot
				at="top-left"
				className={withActs ? "right-0 flex-col items-start" : "right-0"}
			>
				{withActs ? (
					<>
						<div className="flex w-full min-w-0 gap-2">
							<ArcadeTitle
								compact={compact}
								floor={floor}
								status={actSummaryLine(totals)}
							/>
							<div className="ms-auto flex shrink-0 items-start gap-2">
								{compact ? null : actButtons}
								{actions}
							</div>
						</div>
						<BlindSpotCaption snapshot={snapshot} />
						{/* On a phone the title can wrap: the chips follow the
						    column, so they never cover the caption. */}
						{compact && filterChips ? (
							<div className="max-w-full">{filterChips}</div>
						) : null}
					</>
				) : (
					<>
						<ArcadeTitle compact={compact} floor={floor} />
						<div className="ms-auto">{actions}</div>
					</>
				)}
			</GameHudSlot>
			{filterChips && !(withActs && compact) ? (
				<GameHudSlot at="top" className={filtersTop}>
					{filterChips}
				</GameHudSlot>
			) : null}
			{loading || empty ? null : (
				<>
					<GameHudSlot
						at="bottom-left"
						className={withActs ? "flex-col items-start" : undefined}
					>
						{withActs && compact ? (
							<div className="flex gap-2">{actButtons}</div>
						) : null}
						{meters ? (
							<ArcadeMeters
								answers={withActs ? answersReady : undefined}
								compact={compact}
								floor={floor}
								running={withActs ? totals.working : undefined}
							/>
						) : null}
					</GameHudSlot>
					<GameHudSlot at="bottom-right">
						{/* The paytable counts legacy statuses; with acts the HUD summary does. */}
						{hudWidth >= 1100 && composerFor === null && !withActs ? (
							<ArcadePaytable floor={floor} palette={palette} />
						) : null}
						<IsoZoomControls view={isoView} />
					</GameHudSlot>
				</>
			)}
		</>
	);
}
