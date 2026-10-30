import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { BookOpen, Map as MapIcon, Stamp } from "lucide-react";
import type { ReactNode } from "react";
import { GAME_FOCUS, GAME_PLATE, GameTitlePlate } from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import type { actTotals, overlayBudget } from "./game3d-acts.ts";
import { IsoZoomControls, type useIsoView } from "./game3d-stage.tsx";
import {
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import type { DeskMode } from "./passport-desk.tsx";
import {
	PageNav,
	pageTabs,
	spreadCaption,
} from "./passport-interface-pages.tsx";
import type { PassportSheet } from "./passport-interface-panel.tsx";
import type { Passport, PassportSpread } from "./passport-model.ts";
import type { PassportNavigation } from "./passport-navigation.ts";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

type RendererProps = InterfaceRendererProps<unknown>;

/** The passport's HUD: title, the act buttons, the sheet toggles, page controls, zoom. */
export function PassportHud({
	acts,
	actsOn,
	actTotalsNow,
	budget,
	clock,
	compact,
	deskShown,
	deskSpread,
	goToPage,
	isoView,
	loading,
	mode,
	next,
	nowMs,
	onAsk,
	onBlocker,
	panelOpen,
	passport,
	previous,
	queueOpener,
	sheet,
	snapshot,
	spread,
	spreads,
	summary,
	toggleSheet,
	unowned,
}: {
	acts: ActsView["acts"];
	actsOn: boolean;
	actTotalsNow: ReturnType<typeof actTotals>;
	budget: ReturnType<typeof overlayBudget>;
	clock: ReturnType<typeof useActClockOptions>;
	compact: boolean;
	deskShown: boolean;
	deskSpread: PassportSpread | undefined;
	goToPage: PassportNavigation["goToPage"];
	isoView: ReturnType<typeof useIsoView>;
	loading: boolean;
	mode: DeskMode;
	next: PassportNavigation["next"];
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	panelOpen: boolean;
	passport: Passport;
	previous: PassportNavigation["previous"];
	queueOpener: { current: (() => void) | null };
	sheet: PassportSheet | null;
	snapshot: RendererProps["snapshot"];
	spread: number;
	spreads: readonly PassportSpread[];
	summary: string;
	toggleSheet: (next: PassportSheet) => void;
	unowned: ActsView["unowned"];
}): ReactNode {
	const tl = useLiteralMessages();
	const titlePlate = (
		<GameTitlePlate
			compact={compact}
			icon={<Stamp strokeWidth={2.25} />}
			keepStatus={actsOn}
			status={summary}
			title="Passport"
		/>
	);
	const hud = (
		<>
			<GameHudSlot
				at="top-left"
				className={actsOn ? "right-0 flex-wrap" : "right-0"}
			>
				{actsOn && !loading ? (
					<div className="flex min-w-0 flex-col items-start gap-2">
						{titlePlate}
						<div className="pointer-events-auto flex flex-wrap items-center gap-2">
							<NeedYouButton
								onAsk={onAsk}
								snapshot={snapshot}
								totals={actTotalsNow}
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
								totals={actTotalsNow}
								unowned={unowned}
							/>
						</div>
						<span className="pointer-events-auto">
							<BlindSpotCaption snapshot={snapshot} />
						</span>
					</div>
				) : (
					titlePlate
				)}
				<div
					aria-label="Passport and map"
					className={cn(
						GAME_PLATE,
						"pointer-events-auto ms-auto flex shrink-0 gap-1 p-1",
						actsOn && "self-start"
					)}
					role="group"
				>
					{(
						[
							["booklet", "Booklet", BookOpen],
							["map", "Map of travels", MapIcon],
						] as const
					).map(([value, label, Icon]) => (
						<button
							aria-label={label}
							aria-pressed={sheet === value && !panelOpen}
							className={cn(
								"gk-display flex h-10 items-center gap-2 rounded-xl px-3 text-[16px] transition-colors hover:bg-(--gk-plate-sunk) aria-pressed:bg-(--gk-accent) aria-pressed:text-(--gk-accent-ink)",
								GAME_FOCUS
							)}
							key={value}
							onClick={() => toggleSheet(value)}
							type="button"
						>
							<Icon aria-hidden="true" className="size-5" strokeWidth={2.25} />
							{compact ? null : label}
						</button>
					))}
				</div>
			</GameHudSlot>
			{deskShown && sheet !== "booklet" ? (
				<GameHudSlot
					at="bottom-left"
					// Clear of the zoom controls in the bottom-right corner.
					className="right-[76px]"
				>
					<PageNav
						caption={spreadCaption(deskSpread, passport.pages.length, tl)}
						compact={mode === "single"}
						hasNext={spread < spreads.length - 1}
						hasPrevious={spread > 0}
						onNext={next}
						onPage={goToPage}
						onPrevious={previous}
						tabs={pageTabs(passport, deskSpread, tl)}
					/>
				</GameHudSlot>
			) : null}
			{loading ? null : (
				<GameHudSlot at="bottom-right">
					<IsoZoomControls view={isoView} />
				</GameHudSlot>
			)}
		</>
	);
	return hud;
}
