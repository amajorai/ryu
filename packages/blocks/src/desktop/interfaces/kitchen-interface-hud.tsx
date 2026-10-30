import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import type { ReactNode, RefObject } from "react";
import { GameHudSlot } from "./game-shell.tsx";
import type { ActTotals } from "./game3d-acts.ts";
import { actSummaryLine } from "./game3d-acts.ts";
import { type IsoView, IsoZoomControls } from "./game3d-stage.tsx";
import { BlindSpotCaption } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	type HudDensity,
	KitchenTitle,
	NewOrderButton,
	OrderRail,
	ServiceClock,
	ServiceScore,
} from "./kitchen-hud.tsx";
import type { actTickets, KitchenService } from "./kitchen-model.ts";
import type { KitchenPalette } from "./kitchen-palette.ts";

/** The kitchen's HUD: title, order rail, new order, score, clock and zoom. */
export function KitchenInterfaceHud({
	actButtons,
	activeThreadId,
	actsOn,
	density,
	fallbackRef,
	hoverId,
	isEmpty,
	isoView,
	loading,
	narrow,
	newOrder,
	palette,
	params,
	serve,
	service,
	setHoverId,
	snapshot,
	tally,
	ticketActs,
}: {
	actButtons: ReactNode;
	activeThreadId: string | null;
	actsOn: boolean;
	density: HudDensity;
	fallbackRef: RefObject<HTMLHeadingElement | null>;
	hoverId: string | null;
	isEmpty: boolean;
	isoView: IsoView;
	loading: boolean;
	narrow: boolean;
	newOrder: () => void;
	palette: KitchenPalette;
	params: InterfaceParamsByRenderer["kitchen"];
	serve: (threadId: string) => void;
	service: KitchenService;
	setHoverId: (id: string | null) => void;
	snapshot: InterfaceRendererProps<unknown>["snapshot"];
	tally: ActTotals;
	ticketActs: ReturnType<typeof actTickets> | null;
}) {
	return (
		<>
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start",
					narrow ? "gap-2.5 p-2.5" : "gap-3 p-4"
				)}
			>
				{/* Shrinks on a narrow stage so the title's status can wrap (K2). */}
				<div className="flex min-w-0 shrink flex-col items-start gap-2">
					<KitchenTitle
						actStatus={actsOn ? actSummaryLine(tally) : undefined}
						density={density}
						service={service}
					/>
					{actsOn ? <BlindSpotCaption snapshot={snapshot} /> : null}
				</div>
				<OrderRail
					activeThreadId={activeThreadId}
					className={cn(
						"order-3 basis-full",
						density === "wide" && "order-none mx-2 basis-0 self-stretch",
						density === "wide" && "flex-1"
					)}
					density={density}
					headingRef={fallbackRef}
					hoverId={hoverId}
					loading={loading}
					onHover={setHoverId}
					onServe={serve}
					palette={palette}
					service={service}
					// With acts the rail holds only what moves; open quiet orders
					// are not "no open orders".
					showEmptyRail={
						!(isEmpty || (ticketActs && snapshot.threads.length > 0))
					}
					ticketActs={ticketActs}
				/>
				<div className="ms-auto flex shrink-0 flex-col items-end gap-2">
					<NewOrderButton
						density={density}
						disabled={loading}
						onNewOrder={newOrder}
					/>
					{narrow ? null : actButtons}
				</div>
			</div>
			{actsOn && narrow ? (
				// Clear of the zoom column on the right, and kept while asks exist.
				<GameHudSlot at="bottom-left" className="right-[68px] flex-wrap">
					{actButtons}
				</GameHudSlot>
			) : null}
			{loading || isEmpty ? null : (
				<>
					{actsOn && narrow ? null : (
						<GameHudSlot
							at="bottom-left"
							className={narrow ? "right-0 justify-center" : undefined}
						>
							<ServiceScore
								actTotals={actsOn ? tally : undefined}
								density={density}
								service={service}
							/>
						</GameHudSlot>
					)}
					<GameHudSlot at="bottom-right">
						{narrow || params?.serviceClock === false ? null : <ServiceClock />}
						<IsoZoomControls view={isoView} />
					</GameHudSlot>
				</>
			)}
		</>
	);
}
