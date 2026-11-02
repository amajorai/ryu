import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceParamsByRenderer,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Club, Plus } from "lucide-react";
import type { RefObject } from "react";
import type { CardTableActs } from "./card-table-interface-acts.tsx";
import { HUD_TOP, PHONE_HUD_BELOW } from "./card-table-interface-layout.ts";
import type { SeatInfo } from "./card-table-model.ts";
import { CardTableRail } from "./card-table-rail.tsx";
import type { SeatActions } from "./card-table-seat.tsx";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameTitlePlate,
} from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import type { stageAgents } from "./game3d-acts.ts";
import {
	ActPlateButton,
	offStageLabel,
	offStageText,
} from "./game3d-signs.tsx";
import {
	BlindSpotCaption,
	NeedYouButton,
	openQueue,
	QueueButton,
} from "./interface-ask-card.tsx";

/**
 * The Card Table's HUD: the title plate with its summary, the act row
 * (need you, Queue, off-stage tally, blind-spot caption), the folded rail,
 * the Table/Cards switch and Deal a thread. Split out of
 * `card-table-interface.tsx`.
 */

export type TableLayout = InterfaceParamsByRenderer["card-table"]["layout"];

interface CardTableHudProps {
	actHudRef: RefObject<HTMLDivElement | null>;
	actions: SeatActions;
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	actsOn: boolean;
	clock: ClockOptions | undefined;
	compact: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	layout: TableLayout;
	loading: boolean;
	nowMs: number;
	onDeal: () => void;
	onLayout: (layout: TableLayout) => void;
	rail: SeatInfo[];
	railCollapsed: boolean;
	rootWidth: number;
	snapshot: InterfaceSnapshot;
	staged: ReturnType<typeof stageAgents>;
	summary: string;
	tableActs: CardTableActs;
	unowned: Parameters<typeof QueueButton>[0]["unowned"];
	unseated: Parameters<typeof CardTableRail>[0]["unseated"];
}

export function CardTableHud({
	actHudRef,
	actions,
	acts,
	actsOn,
	clock,
	compact,
	headingRef,
	layout,
	loading,
	nowMs,
	onDeal,
	onLayout,
	rail,
	railCollapsed,
	rootWidth,
	snapshot,
	staged,
	summary,
	tableActs,
	unowned,
	unseated,
}: CardTableHudProps) {
	const tl = useLiteralMessages();
	const { budget, onAsk, onBlocker, queueOpener, railActs, shown, totals } =
		tableActs;
	const isSpread = layout === "spread";
	return (
		<div className="pointer-events-none absolute inset-0 z-30">
			<h1
				className="sr-only"
				ref={headingRef}
				tabIndex={actsOn ? -1 : undefined}
			>
				Card Table
			</h1>
			{actsOn && !loading ? null : (
				<p className="sr-only @min-[560px]/game:hidden">{summary}</p>
			)}
			<GameHudSlot at="top-left" className="min-w-0 max-w-[calc(100%-9rem)]">
				{/* A phone keeps its top row for the table's controls: the title
				    shrinks to its icon (the name stays for screen readers). */}
				<span
					aria-hidden="true"
					className="pointer-events-auto grid @min-[560px]/game:hidden size-12 place-items-center rounded-2xl border-(--gk-edge) border-2 bg-(--gk-plate) shadow-(--gk-lip)"
					title="Card Table"
				>
					<span className="grid size-8 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink) [&_svg]:size-5">
						<Club />
					</span>
				</span>
				<div className="@max-[559px]/game:hidden min-w-0">
					<GameTitlePlate
						compact={compact}
						icon={<Club aria-hidden="true" />}
						keepStatus={actsOn}
						status={<span data-testid="card-table-summary">{summary}</span>}
						title="Card Table"
					/>
				</div>
			</GameHudSlot>
			{actsOn && !loading ? (
				<div
					className={cn(
						"absolute start-0 flex max-w-full flex-col items-start @min-[672px]/game:gap-3 gap-2 @min-[672px]/game:px-4 px-2.5 @min-[672px]/game:pt-2 pt-1",
						HUD_TOP
					)}
					ref={actHudRef}
				>
					{/* Phones hide the title plate: its summary shows here. */}
					<p
						className="pointer-events-auto @min-[560px]/game:hidden max-w-full truncate rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2.5 py-0.5 font-semibold text-(--gk-ink) text-[12px] shadow-[0_2px_0_var(--gk-edge)]"
						data-testid="card-table-summary-phone"
					>
						{summary}
					</p>
					<div className="pointer-events-auto flex flex-wrap items-center gap-2">
						<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
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
						{staged.offStage.count > 0 && shown.has("tally:off") ? (
							// The agents off the table, beside the queue: visible and
							// tappable whether the rail is a panel or folded.
							<ActPlateButton
								budgeted="tally"
								focusable
								kind="tally"
								label={offStageLabel(staged.offStage.count, tl)}
								onActivate={() => openQueue(queueOpener)}
								tally="off"
							>
								{budget.narrow || rootWidth < PHONE_HUD_BELOW
									? `+${staged.offStage.count}`
									: offStageText(staged.offStage)}
							</ActPlateButton>
						) : null}
					</div>
					<span className="pointer-events-auto">
						<BlindSpotCaption snapshot={snapshot} />
					</span>
				</div>
			) : null}
			<GameHudSlot at="top-right" className="items-center">
				{!(loading || isSpread) && railCollapsed ? (
					<span className="pointer-events-auto">
						<CardTableRail
							actions={actions}
							acts={railActs}
							collapsed
							seats={rail}
							unseated={unseated}
						/>
					</span>
				) : null}
				<div
					aria-label="Lay out as"
					className={cn(
						GAME_PLATE,
						"pointer-events-auto flex h-12 items-center gap-1 p-1"
					)}
					role="group"
				>
					{(
						[
							["poker", "Table"],
							["spread", "Cards"],
						] as const
					).map(([value, name]) => (
						<button
							aria-pressed={layout === value}
							className={cn(
								"gk-display h-full rounded-[11px] px-3.5 text-[15px] transition-colors",
								GAME_FOCUS,
								layout === value
									? "bg-(--gk-accent) text-(--gk-accent-ink)"
									: "text-(--gk-ink-muted) hover:bg-(--gk-plate-sunk) hover:text-(--gk-ink)"
							)}
							key={value}
							onClick={() => onLayout(value)}
							type="button"
						>
							{name}
						</button>
					))}
				</div>
				<GameAction
					compact={compact}
					disabled={loading}
					icon={<Plus aria-hidden="true" strokeWidth={3} />}
					label="Deal a thread"
					onClick={onDeal}
				/>
			</GameHudSlot>
		</div>
	);
}
